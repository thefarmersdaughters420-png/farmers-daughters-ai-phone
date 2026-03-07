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

const VOICE = "Polly.Danielle-Neural";
const STORE_PHONE = process.env.TWILIO_PHONE_NUMBER;
const MENU_URL = "https://www.thefarmersdaughtersdispensary.com/menu";
const WEBSITE_URL = "https://www.thefarmersdaughtersdispensary.com";

const GREETINGS = [
  "Thanks for calling The Farmers Daughters Dispensary. This is Jasmine. How can I help?",
  "The Farmers Daughters Dispensary, this is Jasmine. How can I help?",
  "Thanks for calling The Farmers Daughters Dispensary. Jasmine here. What can I help you with?"
];

const FOLLOW_UPS = [
  "Anything else I can help with?",
  "What else can I help you with?",
  "Anything else you want to check on?",
  "What else can I look up for you?",
  "Is there anything else you'd like to know?",
  "Need help with anything else?",
  "Anything else I can check for you?",
  "What else would you like to know?",
  "Can I help you with anything else today?",
  "Is there something else I can help with?"
];

const NO_INPUT_REPLIES = [
  "I didn't catch that. Go ahead and ask me again.",
  "Sorry, I missed that. What can I help you with?",
  "I didn't hear anything. Go ahead and try that again."
];

const ERROR_REPLIES = [
  "Sorry about that. I can help with deals, hours, directions, payment, or text you the menu.",
  "Sorry about that. You can ask me about deals, directions, payment, or the menu.",
  "Sorry about that. I can text you the menu or help with hours, deals, and directions."
];

const SYSTEM_PROMPT = `
You are Jasmine, the phone assistant for The Farmers Daughters Dispensary in Brookings, Oregon.

Known facts:
- Business name: The Farmers Daughters Dispensary
- Full address: 1025 Chetco Ave, Brookings, OR 97415
- Directions: Right off Highway 101, behind Dragon Palace and Rancho Viejo. The shop sits a little back off the road by the tall dispensary sign.
- Hours: 9 AM to 9 PM daily
- Payment: cash and debit accepted
- Age requirement: 21 plus with valid ID
- Website: www.thefarmersdaughtersdispensary.com
- Menu: www.thefarmersdaughtersdispensary.com/menu
- Shop phone number: 541-813-1711
- First-time discounts: 5 percent first visit, 10 percent second, 15 percent third, 20 percent fourth

Happy hour:
- Every day from 4:20 PM to 6:20 PM
- 20 percent off Cookies, Khalifa Kush, Tyson, Select, and Hotbox

Daily deals:
- Monday deals four time Loyalty points
- Tuesday: 20 percent off infused joints and joint packs
- Wednesday: 20 percent off cartridges
- Thursday: 20 percent off edibles
- Friday: 20 percent off flower in jars
- Saturday: 20 percent off dabs, extracts, and rosin
- Sunday: 50 percent off ounces in jars

Vendor info:
- Vendors should email brookingsvendors@gmail.com
- Showing and samples can be done Monday through Friday

Style:
- Sound warm, relaxed, natural, and conversational
- Sound like a real budtender
- Keep answers short for phone calls
- Usually answer in 1 sentence, sometimes 2 short sentences
- Never ramble
- Do not repeat the exact same wording every time
- Do not mention being an AI unless asked

Rules:
- Never take orders over the phone
- Direct orders to the website menu
- If asked about current inventory or exact prices, prefer the live menu
- If you do not know something, say: "I don't want to give you the wrong info, but I can text you the live menu."
`;

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function cleanForPhone(text) {
  if (!text) {
    return "I don't want to give you the wrong info, but I can text you the live menu.";
  }

  return text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function normalizePhoneNumber(value) {
  if (!value) return null;
  const digits = String(value).replace(/[^\d+]/g, "");
  if (!digits) return null;
  return digits.startsWith("+") ? digits : `+${digits}`;
}

function getPacificNow() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
  );
}

function getPacificDayName() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long"
  }).format(new Date()).toLowerCase();
}

function isNearClosing() {
  const now = getPacificNow();
  const hour = now.getHours();
  const minute = now.getMinutes();
  return hour === 20 && minute >= 30;
}

function getTodaysDealLine() {
  const deals = {
    monday: "Monday deals four time Loyalty points.",
    tuesday: "Today’s deal is 20 percent off infused joints and joint packs.",
    wednesday: "Today’s deal is 20 percent off cartridges.",
    thursday: "Today’s deal is 20 percent off edibles.",
    friday: "Today’s deal is 20 percent off flower in jars.",
    saturday: "Today’s deal is 20 percent off dabs, extracts, and rosin.",
    sunday: "Today’s deal is 50 percent off ounces in jars."
  };

  return deals[getPacificDayName()] || "You can find today’s deal on our website.";
}

function getDealsTextBody() {
  return (
    `Hi from The Farmers Daughters Dispensary. ` +
    `Today’s deal: ${getTodaysDealLine()} ` +
    `Happy hour is every day from 4:20 to 6:20 with 20 percent off Cookies, Khalifa Kush, Tyson, Select, and Hotbox. ` +
    `Menu: ${MENU_URL}`
  );
}

async function sendMenuText(to) {
  const phone = normalizePhoneNumber(to);
  if (!phone) throw new Error("Invalid phone number");
  if (!STORE_PHONE) throw new Error("Missing TWILIO_PHONE_NUMBER");

  return twilioClient.messages.create({
    from: STORE_PHONE,
    to: phone,
    body:
      `Hi from The Farmers Daughters Dispensary. ` +
      `Here is the live menu: ${MENU_URL} ` +
      `Orders go through the website. ` +
      `We are at 1025 Chetco Ave in Brookings, behind Dragon Palace and Rancho Viejo.`
  });
}

async function sendDealsText(to) {
  const phone = normalizePhoneNumber(to);
  if (!phone) throw new Error("Invalid phone number");
  if (!STORE_PHONE) throw new Error("Missing TWILIO_PHONE_NUMBER");

  return twilioClient.messages.create({
    from: STORE_PHONE,
    to: phone,
    body: getDealsTextBody()
  });
}

function getInstantAnswer(question) {
  const q = question.toLowerCase();

  if (/(hours|open|close|closing|what time|how late are you open|open tonight)/.test(q)) {
    if (isNearClosing()) {
      return "We’re open until 9 PM tonight, so we’re closing soon.";
    }
    return "We’re open 9 AM to 9 PM every day.";
  }

  if (/(address|where are you|location|directions|where is the store|where are you located)/.test(q)) {
    return "We’re at 1025 Chetco Ave in Brookings, right off Highway 101 behind Dragon Palace and Rancho Viejo. We sit a little back off the road by the tall dispensary sign.";
  }

  if (/(phone|phone number|call you|store number|shop number)/.test(q)) {
    return "Our shop phone number is 541-813-1711.";
  }

  if (/(parking|driveway|hard to find|sign)/.test(q)) {
    return "Look for the tall dispensary sign and driveway. We sit a little back off the road.";
  }

  if (/(payment|debit|card|cash|atm|debit only|use card|cash back|cashback)/.test(q)) {
    return "We accept cash and debit.";
  }

  if (/(age|id|how old|requirement)/.test(q)) {
    return "You must be 21 or older with a valid ID.";
  }

  if (/(menu|website|online menu)/.test(q) && !/(text|send)/.test(q)) {
    return "The live menu is on our website at thefarmersdaughtersdispensary.com.";
  }

  if (/(first time|first visit|new customer|loyalty discount)/.test(q)) {
    return "First visit is 5 percent off, second is 10 percent, third is 15, and fourth is 20 percent.";
  }

  if (/(happy hour|4:20|420 deal)/.test(q)) {
    return "Happy hour is every day from 4:20 to 6:20 with 20 percent off Cookies, Khalifa Kush, Tyson, Select, and Hotbox.";
  }

  if (/(today'?s deal|deal today|special today|todays special)/.test(q)) {
    return getTodaysDealLine();
  }

  if (/\bmonday\b/.test(q) && /deal|special|monday/.test(q)) {
    return "Monday deals four time Loyalty points.";
  }

  if (/\btuesday\b/.test(q) && /deal|special|tuesday/.test(q)) {
    return "Tuesday is 20 percent off infused joints and joint packs.";
  }

  if (/\bwednesday\b/.test(q) && /deal|special|wednesday/.test(q)) {
    return "Wednesday is 20 percent off cartridges.";
  }

  if (/\bthursday\b/.test(q) && /deal|special|thursday/.test(q)) {
    return "Thursday is 20 percent off edibles.";
  }

  if (/\bfriday\b/.test(q) && /deal|special|friday/.test(q)) {
    return "Friday is 20 percent off flower in jars.";
  }

  if (/\bsaturday\b/.test(q) && /deal|special|saturday/.test(q)) {
    return "Saturday is 20 percent off dabs, extracts, and rosin.";
  }

  if (/\bsunday\b/.test(q) && /deal|special|sunday/.test(q)) {
    return "Sunday is 50 percent off ounces in jars.";
  }

  if (/(order|pickup|place order|buy over the phone)/.test(q)) {
    return "Orders go through the website menu. That’s the fastest way to place one.";
  }

  if (/(do you have|carry|stock|availability|have any)/.test(q)) {
    return "The live menu is the best place to check current availability, and I can text it to you.";
  }

  if (/(vendor|sales rep|wholesale|appointment|meeting|sample|samples)/.test(q)) {
    return "For vendors, please email brookingsvendors@gmail.com. Showing and samples can be done Monday through Friday.";
  }

  return null;
}

function buildGather(vr) {
  return vr.gather({
    input: "speech",
    speechTimeout: "auto",
    timeout: 4,
    action: "/ask",
    method: "POST",
    actionOnEmptyResult: true
  });
}

app.get("/", (req, res) => {
  res.status(200).send("Jasmine phone server is running.");
});

app.post("/voice", (req, res) => {
  const vr = new VoiceResponse();
  const gather = buildGather(vr);

  gather.say({ voice: VOICE }, pick(GREETINGS));

  res.type("text/xml");
  res.send(vr.toString());
});

app.post("/ask", async (req, res) => {
  const question = (req.body.SpeechResult || "").trim();
  const callerNumber = req.body.From;
  const vr = new VoiceResponse();

  if (!question) {
    const gather = buildGather(vr);
    gather.say({ voice: VOICE }, pick(NO_INPUT_REPLIES));

    res.type("text/xml");
    return res.send(vr.toString());
  }

  try {
    if (/(text|send).*(menu|link)|menu.*(text|send)/i.test(question)) {
      try {
        await sendMenuText(callerNumber);
        vr.say({ voice: VOICE }, "Yep, I just texted the menu over.");
      } catch (err) {
        console.error("SMS menu error:", err.message);
        vr.say({ voice: VOICE }, "I had trouble sending the text, but the live menu is on the website.");
      }

      const gather = buildGather(vr);
      gather.say({ voice: VOICE }, pick(FOLLOW_UPS));

      res.type("text/xml");
      return res.send(vr.toString());
    }

    if (/(text|send).*(deal|deals|special|specials)|deal.*(text|send)|special.*(text|send)/i.test(question)) {
      try {
        await sendDealsText(callerNumber);
        vr.say({ voice: VOICE }, "Yep, I just texted the deals over.");
      } catch (err) {
        console.error("SMS deals error:", err.message);
        vr.say({ voice: VOICE }, "I had trouble sending the text, but I can still tell you today’s deal.");
      }

      const gather = buildGather(vr);
      gather.say({ voice: VOICE }, pick(FOLLOW_UPS));

      res.type("text/xml");
      return res.send(vr.toString());
    }

    const instant = getInstantAnswer(question);
    if (instant) {
      vr.say({ voice: VOICE }, instant);

      const gather = buildGather(vr);
      gather.say({ voice: VOICE }, pick(FOLLOW_UPS));

      res.type("text/xml");
      return res.send(vr.toString());
    }

    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "developer", content: SYSTEM_PROMPT },
        { role: "user", content: question }
      ],
      max_completion_tokens: 24,
      temperature: 0.2
    });

    const answer = cleanForPhone(
      response.choices?.[0]?.message?.content || ""
    );

    vr.say({ voice: VOICE }, answer);

    const gather = buildGather(vr);
    gather.say({ voice: VOICE }, pick(FOLLOW_UPS));
  } catch (error) {
    console.error("Server error:", error);

    const gather = buildGather(vr);
    gather.say({ voice: VOICE }, pick(ERROR_REPLIES));
  }

  res.type("text/xml");
  res.send(vr.toString());
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
