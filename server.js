const express = require("express");
const OpenAI = require("openai");
const twilio = require("twilio");
const { twiml: { VoiceResponse } } = twilio;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ---------- STORE SETTINGS ----------
const VOICE = "Polly.Danielle-Neural";
const STORE_PHONE = process.env.TWILIO_PHONE_NUMBER;
const MENU_URL = "https://www.thefarmersdaughtersdispensary.com/menu";
const WEBSITE_URL = "https://www.thefarmersdaughtersdispensary.com";
const STORE_ADDRESS = "1025 Chetco Ave, Brookings, Oregon 97415";
const STORE_PHONE_SPOKEN = "541-813-1711";

// Optional Weedmaps live-menu integration.
// Add these in Railway Variables when credentials are available.
const WEEDMAPS_ACCESS_TOKEN = process.env.WEEDMAPS_ACCESS_TOKEN || "";
const WEEDMAPS_MENU_ID = process.env.WEEDMAPS_MENU_ID || "";
const WEEDMAPS_API_BASE = "https://api-g.weedmaps.com/wm/2025-07/partners";

// ---------- CALL MEMORY ----------
const callMemory = new Map();
const CALL_MEMORY_TTL_MS = 30 * 60 * 1000;

function getCallState(callSid) {
  if (!callSid) {
    return {
      history: [],
      pendingAction: null,
      callerNumber: null,
      updatedAt: Date.now()
    };
  }

  const existing = callMemory.get(callSid);

  if (existing && Date.now() - existing.updatedAt < CALL_MEMORY_TTL_MS) {
    existing.updatedAt = Date.now();
    return existing;
  }

  const fresh = {
    history: [],
    pendingAction: null,
    callerNumber: null,
    updatedAt: Date.now()
  };

  callMemory.set(callSid, fresh);
  return fresh;
}

function saveTurn(state, role, content) {
  state.history.push({ role, content });
  state.history = state.history.slice(-6);
  state.updatedAt = Date.now();
}

// Clean old calls periodically.
setInterval(() => {
  const now = Date.now();
  for (const [callSid, state] of callMemory.entries()) {
    if (now - state.updatedAt > CALL_MEMORY_TTL_MS) {
      callMemory.delete(callSid);
    }
  }
}, 10 * 60 * 1000).unref();

// ---------- LANGUAGE ----------
const GREETINGS = [
  "Thanks for calling The Farmers Daughters Dispensary. This is Jasmine. How can I help?",
  "The Farmers Daughters Dispensary, this is Jasmine. What can I help you with?",
  "Thanks for calling The Farmers Daughters Dispensary. This is Jasmine. What can I do for you?"
];

const NO_INPUT_REPLIES = [
  "I didn't catch that. Go ahead and ask me again.",
  "Sorry, I missed that. What can I help you with?",
  "I didn't hear anything. Try that again for me."
];

const ERROR_REPLIES = [
  "Sorry about that. I can help with hours, deals, directions, or text you the menu.",
  "Sorry, I had trouble with that. Ask me about the menu, hours, deals, or directions."
];

const SYSTEM_PROMPT = `
You are Jasmine, the phone assistant for The Farmers Daughters Dispensary in Brookings, Oregon.

Store facts:
- Address: ${STORE_ADDRESS}
- Directions: Right off Highway 101, behind Dragon Palace and Rancho Viejo. The shop sits a little back off the road by the tall dispensary sign.
- Hours: 9 AM to 9 PM every day.
- Payment: cash and debit.
- Age requirement: 21 or older with valid ID.
- Website: ${WEBSITE_URL}
- Menu and online ordering: ${MENU_URL}
- Shop phone: ${STORE_PHONE_SPOKEN}
- First-time discounts: 5 percent first visit, 10 percent second, 15 percent third, 20 percent fourth.
- Happy hour: every day from 4:20 PM to 6:20 PM, 20 percent off Cookies, Khalifa Kush, Tyson, Select, and Hotbox.
- Monday: four times loyalty points.
- Tuesday: 20 percent off infused joints and joint packs.
- Wednesday: 20 percent off cartridges.
- Thursday: 20 percent off edibles.
- Friday: 20 percent off flower in jars.
- Saturday: 20 percent off dabs, extracts, and rosin.
- Sunday: 50 percent off ounces in jars.
- Vendors: brookingsvendors@gmail.com. Showing and samples Monday through Friday.

Phone style:
- Warm, relaxed and natural.
- Sound like a knowledgeable budtender.
- Keep most answers to one short sentence.
- Never ramble.
- Do not say you are an AI unless directly asked.
- Never claim inventory is in stock unless live menu data was successfully checked.
- Never claim a text was sent unless the application successfully sent it.
- Never take an order over the phone. Direct ordering to the online menu.
`;

// ---------- HELPERS ----------
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function cleanForPhone(text) {
  if (!text) return "I don't want to give you the wrong information.";
  return text.replace(/\s+/g, " ").trim().slice(0, 320);
}

function normalizePhoneNumber(value) {
  if (!value) return null;

  const raw = String(value).trim();

  // Twilio can sometimes use non-phone identities such as client:xxxxx.
  if (/^(client|sip):/i.test(raw)) return null;

  const digits = raw.replace(/\D/g, "");

  // US 10-digit number.
  if (digits.length === 10) return `+1${digits}`;

  // US number already containing country code.
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  // Generic E.164-compatible international length.
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;

  return null;
}

function getPacificParts() {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    hour: "numeric",
    minute: "numeric",
    hour12: false
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(new Date()).map(p => [p.type, p.value])
  );

  return {
    day: (parts.weekday || "").toLowerCase(),
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

function getStoreStatusLine() {
  const { hour, minute } = getPacificParts();
  const nowMinutes = hour * 60 + minute;
  const open = 9 * 60;
  const close = 21 * 60;

  if (nowMinutes < open) {
    return "We're closed right now and open at 9 AM today.";
  }

  if (nowMinutes >= close) {
    return "We're closed for the night and open again at 9 AM tomorrow.";
  }

  if (nowMinutes >= close - 30) {
    return "We're open until 9 PM tonight, so we're closing soon.";
  }

  return "We're open right now until 9 PM.";
}

function getTodaysDealLine() {
  const { day } = getPacificParts();

  const deals = {
    monday: "Today's deal is four times loyalty points.",
    tuesday: "Today's deal is 20 percent off infused joints and joint packs.",
    wednesday: "Today's deal is 20 percent off cartridges.",
    thursday: "Today's deal is 20 percent off edibles.",
    friday: "Today's deal is 20 percent off flower in jars.",
    saturday: "Today's deal is 20 percent off dabs, extracts, and rosin.",
    sunday: "Today's deal is 50 percent off ounces in jars."
  };

  return deals[day] || "You can check today's deal on our website.";
}

function isAffirmative(text) {
  return /^(yes|yeah|yep|sure|please|ok|okay|absolutely|send it|text it|do it|that works)\b/i.test(text.trim());
}

function isNegative(text) {
  return /^(no|nope|nah|not right now|i'?m good)\b/i.test(text.trim());
}

function wantsMenuText(text) {
  const q = text.toLowerCase();
  return (
    /(text|send|message).*(menu|link|order|ordering|website)/.test(q) ||
    /(menu|link|order|ordering|website).*(text|send|message)/.test(q) ||
    /text me/.test(q) ||
    /send it to me/.test(q)
  );
}

function isOrderingQuestion(text) {
  return /(how do i order|how can i order|where do i order|can i order online|online order|place an order|order online|ordering link)/i.test(text);
}

function isInventoryQuestion(text) {
  return /(do you have|have any|in stock|carry|inventory|what.*(flower|cart|cartridge|edible|preroll|pre-roll|joint|dab|extract|rosin|concentrate|ounce|oz)|what strains|what brands)/i.test(text);
}

// ---------- SMS ----------
async function sendMenuText(to) {
  const phone = normalizePhoneNumber(to);

  console.log("SMS destination raw:", to);
  console.log("SMS destination normalized:", phone);

  if (!phone) throw new Error(`Invalid phone number: ${String(to)}`);
  if (!STORE_PHONE) throw new Error("Missing TWILIO_PHONE_NUMBER");

  return twilioClient.messages.create({
    from: STORE_PHONE,
    to: phone,
    body:
      `The Farmers Daughters Dispensary\n` +
      `Live menu & online ordering: ${MENU_URL}\n` +
      `1025 Chetco Ave, Brookings\n` +
      `Open daily 9 AM-9 PM`
  });
}

async function sendDealsText(to) {
  const phone = normalizePhoneNumber(to);

  if (!phone) throw new Error(`Invalid phone number: ${String(to)}`);
  if (!STORE_PHONE) throw new Error("Missing TWILIO_PHONE_NUMBER");

  return twilioClient.messages.create({
    from: STORE_PHONE,
    to: phone,
    body:
      `The Farmers Daughters Dispensary\n` +
      `${getTodaysDealLine()}\n` +
      `Happy hour: 4:20-6:20 PM daily.\n` +
      `Menu: ${MENU_URL}`
  });
}

// ---------- WEEDMAPS LIVE MENU ----------
let menuCache = {
  items: [],
  fetchedAt: 0
};

const MENU_CACHE_MS = 45 * 1000;

function liveMenuConfigured() {
  return Boolean(WEEDMAPS_ACCESS_TOKEN && WEEDMAPS_MENU_ID);
}

async function fetchLiveMenuItems() {
  if (!liveMenuConfigured()) {
    throw new Error("Live Weedmaps menu is not configured");
  }

  if (
    menuCache.items.length &&
    Date.now() - menuCache.fetchedAt < MENU_CACHE_MS
  ) {
    return menuCache.items;
  }

  let page = 1;
  let allItems = [];

  while (page <= 5) {
    const url =
      `${WEEDMAPS_API_BASE}/menus/${encodeURIComponent(WEEDMAPS_MENU_ID)}/items` +
      `?page_size=150&page=${page}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    let response;

    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${WEEDMAPS_ACCESS_TOKEN}`,
          Accept: "application/json"
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Weedmaps ${response.status}: ${body.slice(0, 250)}`);
    }

    const payload = await response.json();
    const pageItems = Array.isArray(payload.data) ? payload.data : [];

    allItems = allItems.concat(pageItems);

    const total = Number(payload?.meta?.total || allItems.length);

    if (!pageItems.length || allItems.length >= total || pageItems.length < 150) {
      break;
    }

    page += 1;
  }

  menuCache = {
    items: allItems,
    fetchedAt: Date.now()
  };

  console.log(`Live menu refreshed: ${allItems.length} items`);
  return allItems;
}

function itemSearchText(item) {
  try {
    return JSON.stringify(item).toLowerCase();
  } catch {
    return String(item || "").toLowerCase();
  }
}

function itemName(item) {
  return (
    item?.name ||
    item?.product?.name ||
    item?.brand_product?.name ||
    item?.external_name ||
    "menu item"
  );
}

function inventoryKeywords(question) {
  const stop = new Set([
    "do","you","have","any","what","which","is","are","in","stock","carry",
    "inventory","right","now","today","please","can","i","get","me","your",
    "the","a","an","of","some","kind","kinds","available"
  ]);

  return question
    .toLowerCase()
    .replace(/pre[\s-]?rolls?/g, "preroll")
    .replace(/cartridges?/g, "cartridge")
    .replace(/carts?/g, "cartridge")
    .replace(/concentrates?/g, "concentrate")
    .replace(/extracts?/g, "extract")
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 1 && !stop.has(word));
}

async function answerInventoryQuestion(question) {
  if (!liveMenuConfigured()) {
    return {
      answered: true,
      text: "I can check live inventory once the Weedmaps menu connection is turned on. For now, I can text you the live online menu."
    };
  }

  try {
    const items = await fetchLiveMenuItems();
    const keywords = inventoryKeywords(question);

    let matches = items;

    if (keywords.length) {
      matches = items.filter(item => {
        const haystack = itemSearchText(item);
        return keywords.every(k => haystack.includes(k));
      });

      // If strict matching finds nothing, loosen it to any keyword.
      if (!matches.length) {
        matches = items.filter(item => {
          const haystack = itemSearchText(item);
          return keywords.some(k => haystack.includes(k));
        });
      }
    }

    const uniqueNames = [...new Set(matches.map(itemName).filter(Boolean))];

    if (!uniqueNames.length) {
      return {
        answered: true,
        text: "I checked the live menu and I don't see a match right now. I can text you the menu if you'd like."
      };
    }

    const sample = uniqueNames.slice(0, 5);

    if (/do you have|have any|in stock|carry/i.test(question) && uniqueNames.length <= 5) {
      return {
        answered: true,
        text: `Yes. I found ${sample.join(", ")} on the live menu.`
      };
    }

    const more = uniqueNames.length > sample.length
      ? `, plus ${uniqueNames.length - sample.length} more`
      : "";

    return {
      answered: true,
      text: `On the live menu I found ${sample.join(", ")}${more}.`
    };
  } catch (error) {
    console.error("Live menu error:", error.message);
    return {
      answered: true,
      text: "I couldn't reach the live menu just now, but I can text you the ordering link."
    };
  }
}

// ---------- FAST LOCAL ANSWERS ----------
function getInstantAnswer(question) {
  const q = question.toLowerCase();

  if (/(hours|open|close|closing|what time|how late|open tonight|open right now)/.test(q)) {
    return getStoreStatusLine();
  }

  if (/(address|where are you|location|directions|where is the store|where are you located)/.test(q)) {
    return "We're at 1025 Chetco Ave in Brookings, right off Highway 101 behind Dragon Palace and Rancho Viejo.";
  }

  if (/(phone|phone number|store number|shop number)/.test(q)) {
    return `Our shop number is ${STORE_PHONE_SPOKEN}.`;
  }

  if (/(parking|driveway|hard to find|sign)/.test(q)) {
    return "Look for the tall dispensary sign and driveway. We sit a little back off the road.";
  }

  if (/(payment|debit|card|cash|atm|cashback|cash back)/.test(q)) {
    return "We accept cash and debit.";
  }

  if (/(age|id|how old|requirement)/.test(q)) {
    return "You must be 21 or older with a valid ID.";
  }

  if (/(first time|first visit|new customer|first-time)/.test(q)) {
    return "First visit is 5 percent off, second is 10 percent, third is 15, and fourth is 20 percent.";
  }

  if (/(happy hour|4:20|420 deal)/.test(q)) {
    return "Happy hour is every day from 4:20 to 6:20 with 20 percent off Cookies, Khalifa Kush, Tyson, Select, and Hotbox.";
  }

  if (/(today'?s deal|deal today|special today|todays special)/.test(q)) {
    return getTodaysDealLine();
  }

  if (/\bmonday\b/.test(q) && /(deal|special)/.test(q)) {
    return "Monday is four times loyalty points.";
  }

  if (/\btuesday\b/.test(q) && /(deal|special)/.test(q)) {
    return "Tuesday is 20 percent off infused joints and joint packs.";
  }

  if (/\bwednesday\b/.test(q) && /(deal|special)/.test(q)) {
    return "Wednesday is 20 percent off cartridges.";
  }

  if (/\bthursday\b/.test(q) && /(deal|special)/.test(q)) {
    return "Thursday is 20 percent off edibles.";
  }

  if (/\bfriday\b/.test(q) && /(deal|special)/.test(q)) {
    return "Friday is 20 percent off flower in jars.";
  }

  if (/\bsaturday\b/.test(q) && /(deal|special)/.test(q)) {
    return "Saturday is 20 percent off dabs, extracts, and rosin.";
  }

  if (/\bsunday\b/.test(q) && /(deal|special)/.test(q)) {
    return "Sunday is 50 percent off ounces in jars.";
  }

  if (/(vendor|sales rep|wholesale|appointment|sample|samples)/.test(q)) {
    return "Vendors should email brookingsvendors@gmail.com. Showing and samples can be done Monday through Friday.";
  }

  if (/(menu|website|online menu)/.test(q) && !/(text|send|message)/.test(q) && !isOrderingQuestion(q)) {
    return "The live menu and online ordering are at thefarmersdaughtersdispensary.com slash menu.";
  }

  return null;
}

// ---------- TWILIO LISTENING ----------
function buildListen(vr, retryCount = 0) {
  return vr.gather({
    input: "speech",
    speechTimeout: "auto",
    timeout: 3,
    action: `/ask?retryCount=${retryCount}`,
    method: "POST",
    actionOnEmptyResult: true,
    hints: [
      "flower",
      "cartridge",
      "cart",
      "preroll",
      "pre-roll",
      "edible",
      "rosin",
      "dab",
      "extract",
      "concentrate",
      "ounce",
      "Cookies",
      "Khalifa Kush",
      "Tyson",
      "Select",
      "Hotbox"
    ].join(",")
  });
}

function continueListening(vr) {
  buildListen(vr, 0);
}

// ---------- ROUTES ----------
app.get("/", (req, res) => {
  res.status(200).send("Jasmine phone server is running.");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    liveMenuConfigured: liveMenuConfigured(),
    menuCacheItems: menuCache.items.length,
    uptimeSeconds: Math.round(process.uptime())
  });
});

app.post("/voice", (req, res) => {
  const callSid = req.body.CallSid;
  const state = getCallState(callSid);

  state.callerNumber =
    req.body.From ||
    req.body.Caller ||
    req.body.CallerNumber ||
    null;

  console.log("Incoming CallSid:", callSid);
  console.log("Incoming caller number:", state.callerNumber);

  const vr = new VoiceResponse();
  const gather = buildListen(vr, 0);

  gather.say({ voice: VOICE }, pick(GREETINGS));

  res.type("text/xml");
  res.send(vr.toString());
});

app.post("/ask", async (req, res) => {
  const question = (req.body.SpeechResult || "").trim();
  const retryCount = parseInt(req.query.retryCount || "0", 10);
  const callSid = req.body.CallSid;
  const state = getCallState(callSid);

  const callerNumber =
    req.body.From ||
    req.body.Caller ||
    req.body.CallerNumber ||
    state.callerNumber ||
    null;

  if (callerNumber) state.callerNumber = callerNumber;

  const vr = new VoiceResponse();

  console.log("Speech:", question);
  console.log("Caller for /ask:", callerNumber);

  if (!question) {
    if (retryCount >= 1) {
      vr.say(
        { voice: VOICE },
        "Thanks for calling The Farmers Daughters Dispensary. Have a good day."
      );
      vr.hangup();

      res.type("text/xml");
      return res.send(vr.toString());
    }

    const gather = buildListen(vr, retryCount + 1);
    gather.say({ voice: VOICE }, pick(NO_INPUT_REPLIES));

    res.type("text/xml");
    return res.send(vr.toString());
  }

  try {
    // Caller says yes/no after Jasmine offered a text.
    if (state.pendingAction === "sendMenu") {
      if (isAffirmative(question)) {
        try {
          await sendMenuText(callerNumber);
          state.pendingAction = null;
          vr.say({ voice: VOICE }, "Yep, I just texted the menu and ordering link over.");
        } catch (error) {
          console.error("SMS menu error:", error.message);
          vr.say({ voice: VOICE }, "I still couldn't send the text. The menu is on our website.");
        }

        continueListening(vr);
        res.type("text/xml");
        return res.send(vr.toString());
      }

      if (isNegative(question)) {
        state.pendingAction = null;
        vr.say({ voice: VOICE }, "No problem.");
        continueListening(vr);

        res.type("text/xml");
        return res.send(vr.toString());
      }

      // If they asked something else, clear the pending offer and handle the new question.
      state.pendingAction = null;
    }

    // Direct menu/order text request.
    if (wantsMenuText(question)) {
      try {
        await sendMenuText(callerNumber);
        vr.say({ voice: VOICE }, "Yep, I just texted the menu and ordering link over.");
      } catch (error) {
        console.error("SMS menu error:", error.message);
        vr.say({ voice: VOICE }, "I couldn't send the text, but the menu is on our website.");
      }

      continueListening(vr);
      res.type("text/xml");
      return res.send(vr.toString());
    }

    // Direct deals text request.
    if (/(text|send|message).*(deal|deals|special|specials)|deal.*(text|send|message)|special.*(text|send|message)/i.test(question)) {
      try {
        await sendDealsText(callerNumber);
        vr.say({ voice: VOICE }, "Yep, I just texted today's deal and the menu over.");
      } catch (error) {
        console.error("SMS deals error:", error.message);
        vr.say({ voice: VOICE }, "I couldn't send the text, but I can tell you today's deal.");
      }

      continueListening(vr);
      res.type("text/xml");
      return res.send(vr.toString());
    }

    // Ordering questions: offer to text the link and remember that offer.
    if (isOrderingQuestion(question)) {
      state.pendingAction = "sendMenu";
      vr.say(
        { voice: VOICE },
        "Orders go through our live online menu. Want me to text you the ordering link?"
      );

      continueListening(vr);
      res.type("text/xml");
      return res.send(vr.toString());
    }

    // Live inventory/menu questions.
    if (isInventoryQuestion(question)) {
      const inventory = await answerInventoryQuestion(question);

      if (/text you|text.*menu|ordering link/i.test(inventory.text)) {
        state.pendingAction = "sendMenu";
      }

      vr.say({ voice: VOICE }, inventory.text);
      continueListening(vr);

      res.type("text/xml");
      return res.send(vr.toString());
    }

    // Fast local answers avoid an OpenAI round-trip and greatly reduce lag.
    const instant = getInstantAnswer(question);

    if (instant) {
      vr.say({ voice: VOICE }, instant);
      continueListening(vr);

      res.type("text/xml");
      return res.send(vr.toString());
    }

    // AI fallback only when local logic did not already answer.
    saveTurn(state, "user", question);

    const aiMessages = [
      { role: "developer", content: SYSTEM_PROMPT },
      ...state.history
    ];

    const aiRequest = openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: aiMessages,
      max_completion_tokens: 70,
      temperature: 0.2
    });

    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("AI timeout")), 4500)
    );

    const response = await Promise.race([aiRequest, timeout]);

    const answer = cleanForPhone(
      response?.choices?.[0]?.message?.content || ""
    );

    saveTurn(state, "assistant", answer);

    // If AI offers to text the menu, remember it.
    if (/want me to text|i can text|text you.*menu|text you.*link/i.test(answer)) {
      state.pendingAction = "sendMenu";
    }

    vr.say({ voice: VOICE }, answer);
    continueListening(vr);
  } catch (error) {
    console.error("Server error:", error.message || error);

    const gather = buildListen(vr, 1);
    gather.say({ voice: VOICE }, pick(ERROR_REPLIES));
  }

  res.type("text/xml");
  res.send(vr.toString());
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Jasmine server running on port ${PORT}`);
  console.log(`Live Weedmaps menu configured: ${liveMenuConfigured()}`);
});
