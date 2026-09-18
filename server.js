const express = require("express");
const http = require("http");
const twilio = require("twilio");
const WebSocket = require("ws");
const { WebSocketServer } = require("ws");
const { twiml: { VoiceResponse } } = twilio;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-realtime-2.1";
const REALTIME_VOICE = process.env.REALTIME_VOICE || "marin";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim();

const FALLBACK_VOICE = "Polly.Danielle-Neural";
const MENU_URL = "https://www.thefarmersdaughtersdispensary.com/menu";
const WEBSITE_URL = "https://www.thefarmersdaughtersdispensary.com";
const STORE_ADDRESS = "1025 Chetco Ave, Brookings, Oregon 97415";
const STORE_PHONE = "541-813-1711";
const VENDOR_EMAIL = "brookingsvendors@gmail.com";

const BLACKLEAF_API_KEY = process.env.BLACKLEAF_API_KEY || "";
const BLACKLEAF_SMS_URL = "https://api.blackleaf.io/messaging/send/text";

const WEEDMAPS_ACCESS_TOKEN =
  process.env.WEEDMAPS_ACCESS_TOKEN || "";

const WEEDMAPS_MENU_ID =
  process.env.WEEDMAPS_MENU_ID || "";

const WEEDMAPS_API_BASE =
  "https://api-g.weedmaps.com/wm/2025-07/partners";

function normalizePhone(value) {
  if (!value) return null;

  const raw = String(value).trim();

  if (/^(client|sip):/i.test(raw)) {
    return null;
  }

  const digits =
    raw.replace(/\D/g, "");

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (
    digits.length === 11 &&
    digits.startsWith("1")
  ) {
    return `+${digits}`;
  }

  if (
    digits.length >= 8 &&
    digits.length <= 15
  ) {
    return `+${digits}`;
  }

  return null;
}

function blackleafPhone(value) {
  const phone =
    normalizePhone(value);

  if (!phone) {
    return null;
  }

  if (/^\+1\d{10}$/.test(phone)) {
    return phone.slice(2);
  }

  return phone.replace(/^\+/, "");
}

function safeJson(
  value,
  fallback = {}
) {
  try {
    return value
      ? JSON.parse(value)
      : fallback;
  } catch {
    return fallback;
  }
}

function pretty(value) {
  try {
    return JSON.stringify(
      value,
      null,
      2
    );
  } catch {
    return String(value);
  }
}

function pacificNow() {
  const formatter =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          "America/Los_Angeles",

        weekday: "long",

        hour: "numeric",

        minute: "numeric",

        hourCycle: "h23"
      }
    );

  const parts =
    Object.fromEntries(
      formatter
        .formatToParts(
          new Date()
        )
        .map(
          part => [
            part.type,
            part.value
          ]
        )
    );

  return {
    day:
      (
        parts.weekday || ""
      ).toLowerCase(),

    hour:
      Number(parts.hour),

    minute:
      Number(parts.minute)
  };
}

function storeStatus() {
  const {
    hour,
    minute
  } = pacificNow();

  const now =
    hour * 60 +
    minute;

  if (now < 540) {
    return (
      "We're closed right now " +
      "and open at 9 AM today."
    );
  }

  if (now >= 1260) {
    return (
      "We're closed for the night " +
      "and open again at 9 AM tomorrow."
    );
  }

  if (now >= 1230) {
    return (
      "We're open until 9 PM tonight, " +
      "so we're closing soon."
    );
  }

  return (
    "We're open right now " +
    "until 9 PM."
  );
}

function todaysDeal() {
  const deals = {
    monday:
      "Today's deal is four times loyalty points.",

    tuesday:
      "Today's deal is 20 percent off infused joints and joint packs.",

    wednesday:
      "Today's deal is 20 percent off cartridges.",

    thursday:
      "Today's deal is 20 percent off edibles.",

    friday:
      "Today's deal is 20 percent off flower in jars.",

    saturday:
      "Today's deal is 20 percent off dabs, extracts, and rosin.",

    sunday:
      "Today's deal is 50 percent off ounces in jars."
  };

  return (
    deals[pacificNow().day] ||
    "You can check today's deal on our website."
  );
}

function publicWsUrl(req) {
  if (PUBLIC_BASE_URL) {
    return (
      PUBLIC_BASE_URL
        .replace(
          /^https:/i,
          "wss:"
        )
        .replace(
          /^http:/i,
          "ws:"
        )
        .replace(
          /\/$/,
          ""
        ) +
      "/media-stream"
    );
  }

  const host =
    req.headers[
      "x-forwarded-host"
    ] ||
    req.headers.host;

  return (
    `wss://${host}` +
    "/media-stream"
  );
}

function socketOpen(ws) {
  return (
    ws &&
    ws.readyState ===
      WebSocket.OPEN
  );
}

// ---------- BLACKLEAF SMS ----------

async function sendBlackleafText(
  to,
  body
) {
  const phone =
    blackleafPhone(to);

  console.log(
    "Blackleaf destination raw:",
    to
  );

  console.log(
    "Blackleaf destination normalized:",
    phone
  );

  if (!phone) {
    throw new Error(
      `Invalid destination phone: ${String(to)}`
    );
  }

  if (!BLACKLEAF_API_KEY) {
    throw new Error(
      "Missing BLACKLEAF_API_KEY"
    );
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      7000
    );

  let response;

  try {
    response =
      await fetch(
        BLACKLEAF_SMS_URL,
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${BLACKLEAF_API_KEY}`,

            "Content-Type":
              "application/json",

            Accept:
              "application/json"
          },

          body:
            JSON.stringify({
              to: phone,

              body,

              unsubscribeText:
                "Reply STOP to unsubscribe"
            }),

          signal:
            controller.signal
        }
      );
  } finally {
    clearTimeout(timeout);
  }

  const text =
    await response.text();

  let data;

  try {
    data =
      text
        ? JSON.parse(text)
        : {};
  } catch {
    data = {
      raw: text
    };
  }

  if (
    !response.ok ||
    data?.success === false
  ) {
    console.error(
      "Blackleaf SMS rejected:",
      pretty({
        httpStatus:
          response.status,

        response:
          data
      })
    );

    throw new Error(
      `Blackleaf SMS failed (${response.status}): ` +
      pretty(data).slice(
        0,
        1800
      )
    );
  }

  console.log(
    "Blackleaf SMS accepted:",
    pretty(data)
  );

  return data;
}

function sendMenuText(to) {
  return sendBlackleafText(
    to,

    "The Farmers Daughters Dispensary\n" +
      `Live menu & online ordering: ${MENU_URL}\n` +
      "1025 Chetco Ave, Brookings\n" +
      "Open daily 9 AM-9 PM"
  );
}

function sendDealsText(to) {
  return sendBlackleafText(
    to,

    "The Farmers Daughters Dispensary\n" +
      `${todaysDeal()}\n` +
      "Happy hour: 4:20-6:20 PM daily.\n" +
      `Menu: ${MENU_URL}`
  );
}

// ---------- LIVE MENU ----------

let menuCache = {
  items: [],
  fetchedAt: 0
};

const MENU_CACHE_MS =
  45000;

const liveMenuConfigured =
  () =>
    Boolean(
      WEEDMAPS_ACCESS_TOKEN &&
      WEEDMAPS_MENU_ID
    );

async function fetchLiveMenu() {
  if (!liveMenuConfigured()) {
    throw new Error(
      "Live Weedmaps menu is not configured"
    );
  }

  if (
    menuCache.items.length &&
    Date.now() -
      menuCache.fetchedAt <
      MENU_CACHE_MS
  ) {
    return menuCache.items;
  }

  let page = 1;
  let items = [];

  while (page <= 5) {
    const url =
      `${WEEDMAPS_API_BASE}/menus/` +
      `${encodeURIComponent(
        WEEDMAPS_MENU_ID
      )}/items` +
      `?page_size=150&page=${page}`;

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        4000
      );

    let response;

    try {
      response =
        await fetch(
          url,
          {
            headers: {
              Authorization:
                `Bearer ${WEEDMAPS_ACCESS_TOKEN}`,

              Accept:
                "application/json"
            },

            signal:
              controller.signal
          }
        );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(
        `Weedmaps ${response.status}: ` +
        (
          await response.text()
        ).slice(
          0,
          500
        )
      );
    }

    const payload =
      await response.json();

    const batch =
      Array.isArray(
        payload.data
      )
        ? payload.data
        : [];

    items.push(...batch);

    const total =
      Number(
        payload?.meta
          ?.total ||
          items.length
      );

    if (
      !batch.length ||
      batch.length < 150 ||
      items.length >= total
    ) {
      break;
    }

    page += 1;
  }

  menuCache = {
    items,
    fetchedAt:
      Date.now()
  };

  console.log(
    `Live menu refreshed: ${items.length} items`
  );

  return items;
}

function itemText(item) {
  try {
    return JSON
      .stringify(item)
      .toLowerCase();
  } catch {
    return String(
      item || ""
    ).toLowerCase();
  }
}

function itemName(item) {
  return (
    item?.name ||
    item?.product?.name ||
    item?.brand_product
      ?.name ||
    item?.external_name ||
    "menu item"
  );
}

function keywords(question) {
  const stop =
    new Set([
      "do",
      "you",
      "have",
      "any",
      "what",
      "which",
      "is",
      "are",
      "in",
      "stock",
      "carry",
      "inventory",
      "right",
      "now",
      "today",
      "please",
      "can",
      "i",
      "get",
      "me",
      "your",
      "the",
      "a",
      "an",
      "of",
      "some",
      "kind",
      "kinds",
      "available"
    ]);

  return String(
    question || ""
  )
    .toLowerCase()

    .replace(
      /pre[\s-]?rolls?/g,
      "preroll"
    )

    .replace(
      /cartridges?/g,
      "cartridge"
    )

    .replace(
      /carts?/g,
      "cartridge"
    )

    .replace(
      /concentrates?/g,
      "concentrate"
    )

    .replace(
      /extracts?/g,
      "extract"
    )

    .split(
      /[^a-z0-9]+/
    )

    .filter(
      word =>
        word.length > 1 &&
        !stop.has(word)
    );
}

async function checkInventory(
  question
) {
  if (!liveMenuConfigured()) {
    return {
      success: false,

      liveDataChecked:
        false,

      message:
        "Live inventory is not connected yet. " +
        "Do not claim stock. " +
        "Offer to text the live online menu."
    };
  }

  try {
    const items =
      await fetchLiveMenu();

    const terms =
      keywords(question);

    let matches =
      terms.length
        ? items.filter(
            item =>
              terms.every(
                term =>
                  itemText(
                    item
                  ).includes(
                    term
                  )
              )
          )
        : items;

    if (
      !matches.length &&
      terms.length
    ) {
      matches =
        items.filter(
          item =>
            terms.some(
              term =>
                itemText(
                  item
                ).includes(
                  term
                )
            )
        );
    }

    const names = [
      ...new Set(
        matches
          .map(itemName)
          .filter(Boolean)
      )
    ];

    if (!names.length) {
      return {
        success: true,

        liveDataChecked:
          true,

        found: false,

        message:
          "I checked the live menu and did not find a matching item right now."
      };
    }

    const sample =
      names.slice(
        0,
        5
      );

    return {
      success: true,

      liveDataChecked:
        true,

      found: true,

      totalMatches:
        names.length,

      matches:
        sample,

      message:
        names.length > 5
          ? `I found ${sample.join(", ")}, plus ${names.length - 5} more on the live menu.`
          : `I found ${sample.join(", ")} on the live menu.`
    };
  } catch (error) {
    console.error(
      "Live menu error:",
      error.message ||
        error
    );

    return {
      success: false,

      liveDataChecked:
        false,

      message:
        "I could not reach the live menu just now. " +
        "Do not guess inventory. " +
        "Offer to text the online menu."
    };
  }
}

// ---------- JASMINE ----------

const JASMINE_INSTRUCTIONS = `
You are Jasmine, the phone assistant for The Farmers Daughters Dispensary in Brookings, Oregon.

Speak warmly, casually, confidently, and naturally like a knowledgeable budtender. Keep most answers to one or two short sentences. Do not ramble. Let callers interrupt naturally. Do not say you are an AI unless directly asked. If asked, say you are Jasmine, the shop's automated phone assistant. Never invent store facts, prices, policies, deals, or inventory.

Store facts:
- Address: ${STORE_ADDRESS}
- Directions: Right off Highway 101, behind Dragon Palace and Rancho Viejo. The shop sits a little back off the road by the tall dispensary sign.
- Hours: 9 AM to 9 PM every day.
- Payment: cash and debit.
- Age: 21 or older with valid ID.
- Website: ${WEBSITE_URL}
- Live menu and online ordering: ${MENU_URL}
- Shop phone: ${STORE_PHONE}
- First visit 5 percent off, second 10 percent, third 15 percent, fourth 20 percent.
- Happy hour every day 4:20 PM to 6:20 PM: 20 percent off Cookies, Khalifa Kush, Tyson, Select, and Hotbox.
- Monday: four times loyalty points.
- Tuesday: 20 percent off infused joints and joint packs.
- Wednesday: 20 percent off cartridges.
- Thursday: 20 percent off edibles.
- Friday: 20 percent off flower in jars.
- Saturday: 20 percent off dabs, extracts, and rosin.
- Sunday: 50 percent off ounces in jars.
- Vendors: ${VENDOR_EMAIL}. Showing and samples Monday through Friday.

Rules:
- For whether the store is open right now, use get_store_status.
- For today's deal, use get_todays_deal.
- For any current product, strain, brand, size, category, or stock question, use check_live_inventory. Never guess stock.
- If inventory is unavailable, say you cannot verify it and offer to text the live menu.
- If the caller asks to text the menu or ordering link, use send_menu_text immediately. Never claim it sent unless success=true.
- If the caller asks how to order, say orders go through the online menu and offer to text the link. If they agree, use send_menu_text.
- If the caller asks to text today's deals, use send_deals_text. Never claim it sent unless success=true.
- Never take an order over the phone.
- If a store-specific question is not answered by these facts or tools, use record_unknown_question and say you do not want to give bad information.
- After a tool returns, answer naturally without talking about tools or APIs.
`;

const TOOLS = [
  {
    type: "function",

    name:
      "get_store_status",

    description:
      "Get whether the store is open right now, closed, or closing soon using current Pacific time.",

    parameters: {
      type: "object",

      properties: {},

      additionalProperties:
        false
    }
  },

  {
    type: "function",

    name:
      "get_todays_deal",

    description:
      "Get today's current daily deal using Pacific time.",

    parameters: {
      type: "object",

      properties: {},

      additionalProperties:
        false
    }
  },

  {
    type: "function",

    name:
      "check_live_inventory",

    description:
      "Check the live menu for any current product, strain, brand, category, size, or stock request.",

    parameters: {
      type: "object",

      properties: {
        query: {
          type: "string"
        }
      },

      required: [
        "query"
      ],

      additionalProperties:
        false
    }
  },

  {
    type: "function",

    name:
      "send_menu_text",

    description:
      "Text the live menu and ordering link to the current caller when requested or accepted.",

    parameters: {
      type: "object",

      properties: {},

      additionalProperties:
        false
    }
  },

  {
    type: "function",

    name:
      "send_deals_text",

    description:
      "Text today's deal and menu link to the current caller when explicitly requested.",

    parameters: {
      type: "object",

      properties: {},

      additionalProperties:
        false
    }
  },

  {
    type: "function",

    name:
      "record_unknown_question",

    description:
      "Log a store-specific question Jasmine cannot answer reliably for owner review.",

    parameters: {
      type: "object",

      properties: {
        question: {
          type: "string"
        }
      },

      required: [
        "question"
      ],

      additionalProperties:
        false
    }
  }
];

async function executeTool(
  name,
  args,
  context
) {
  if (
    name ===
    "get_store_status"
  ) {
    return {
      success: true,
      message:
        storeStatus()
    };
  }

  if (
    name ===
    "get_todays_deal"
  ) {
    return {
      success: true,
      message:
        todaysDeal()
    };
  }

  if (
    name ===
    "check_live_inventory"
  ) {
    return checkInventory(
      args?.query || ""
    );
  }

  if (
    name ===
    "send_menu_text"
  ) {
    if (
      !context.callerNumber
    ) {
      return {
        success: false,

        message:
          "Caller phone number is unavailable. Do not claim a text was sent."
      };
    }

    try {
      const provider =
        await sendMenuText(
          context.callerNumber
        );

      return {
        success: true,

        message:
          "The menu and ordering link were sent successfully.",

        provider
      };
    } catch (error) {
      console.error(
        "SMS menu error:",
        error.message ||
          error
      );

      return {
        success: false,

        message:
          "The menu text failed. Do not claim it was sent. Give the website menu address instead."
      };
    }
  }

  if (
    name ===
    "send_deals_text"
  ) {
    if (
      !context.callerNumber
    ) {
      return {
        success: false,

        message:
          "Caller phone number is unavailable. Do not claim a text was sent."
      };
    }

    try {
      const provider =
        await sendDealsText(
          context.callerNumber
        );

      return {
        success: true,

        message:
          "Today's deal and menu link were sent successfully.",

        provider
      };
    } catch (error) {
      console.error(
        "SMS deals error:",
        error.message ||
          error
      );

      return {
        success: false,

        message:
          "The deals text failed. Do not claim it was sent."
      };
    }
  }

  if (
    name ===
    "record_unknown_question"
  ) {
    console.log(
      "JASMINE_UNKNOWN_QUESTION:",

      pretty({
        timestamp:
          new Date()
            .toISOString(),

        callSid:
          context.callSid ||
          null,

        callerNumber:
          context.callerNumber ||
          null,

        question:
          String(
            args?.question ||
              ""
          ).trim()
      })
    );

    return {
      success: true,

      message:
        "The question was logged for owner review. This is not yet permanent learned memory."
    };
  }

  return {
    success: false,

    message:
      `Unknown tool: ${name}`
  };
}

// ---------- HTTP ----------

app.get(
  "/",

  (req, res) =>
    res
      .status(200)
      .send(
        "Jasmine realtime phone server is running."
      )
);

app.get(
  "/health",

  (req, res) =>
    res.json({
      ok: true,

      voiceMode:
        "OpenAI Realtime + Twilio Media Streams",

      realtimeModel:
        REALTIME_MODEL,

      realtimeVoice:
        REALTIME_VOICE,

      openaiConfigured:
        Boolean(
          OPENAI_API_KEY
        ),

      blackleafConfigured:
        Boolean(
          BLACKLEAF_API_KEY
        ),

      liveMenuConfigured:
        liveMenuConfigured(),

      menuCacheItems:
        menuCache.items
          .length,

      uptimeSeconds:
        Math.round(
          process.uptime()
        )
    })
);

app.post(
  "/voice",

  (req, res) => {
    const callSid =
      req.body.CallSid ||
      "unknown";

    const callerNumber =
      req.body.From ||
      req.body.Caller ||
      req.body.CallerNumber ||
      "unknown";

    console.log(
      "Incoming call:",
      callSid,
      callerNumber
    );

    const vr =
      new VoiceResponse();

    if (
      !OPENAI_API_KEY
    ) {
      vr.say(
        {
          voice:
            FALLBACK_VOICE
        },

        "Sorry, Jasmine is temporarily unavailable. Please visit thefarmersdaughtersdispensary.com or call back shortly."
      );

      vr.hangup();

      res.type(
        "text/xml"
      );

      return res.send(
        vr.toString()
      );
    }

    const stream =
      vr
        .connect()
        .stream({
          url:
            publicWsUrl(req)
        });

    stream.parameter({
      name:
        "callSid",

      value:
        String(callSid)
    });

    stream.parameter({
      name:
        "callerNumber",

      value:
        String(
          callerNumber
        )
    });

    vr.say(
      {
        voice:
          FALLBACK_VOICE
      },

      "Sorry, Jasmine lost the connection. The live menu is at thefarmersdaughtersdispensary.com slash menu."
    );

    res.type(
      "text/xml"
    );

    res.send(
      vr.toString()
    );
  }
);

// ---------- HTTP + WEBSOCKET ----------

const server =
  http.createServer(app);

const wss =
  new WebSocketServer({
    noServer: true
  });

server.on(
  "upgrade",

  (
    request,
    socket,
    head
  ) => {
    let pathname = "";

    try {
      pathname =
        new URL(
          request.url,

          "http://localhost"
        ).pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (
      pathname !==
      "/media-stream"
    ) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(
      request,
      socket,
      head,

      ws =>
        wss.emit(
          "connection",
          ws,
          request
        )
    );
  }
);

// ---------- REALTIME BRIDGE ----------

wss.on(
  "connection",

  twilioWs => {
    console.log(
      "Twilio Media Stream connected."
    );

    let streamSid = null;
    let callSid = null;
    let callerNumber = null;

    let latestMediaTimestamp =
      0;

    let assistantStartTimestamp =
      null;

    let assistantItemId =
      null;

    let currentMark =
      null;

    let markCounter = 0;

    let openaiWs = null;

    let sessionReady =
      false;

    let greetingSent =
      false;

    let stopped = false;

    let pendingAudio = [];

    const handledCalls =
      new Set();

    const context = {
      get callSid() {
        return callSid;
      },

      get callerNumber() {
        return normalizePhone(
          callerNumber
        );
      }
    };

    const sendTwilio =
      object => {
        if (
          socketOpen(
            twilioWs
          )
        ) {
          twilioWs.send(
            JSON.stringify(
              object
            )
          );
        }
      };

    const sendOpenAI =
      object => {
        if (
          !socketOpen(
            openaiWs
          )
        ) {
          return false;
        }

        openaiWs.send(
          JSON.stringify(
            object
          )
        );

        return true;
      };

    function resetPlayback() {
      assistantStartTimestamp =
        null;

      assistantItemId =
        null;

      currentMark =
        null;
    }

    function clearPlayback() {
      if (!streamSid) {
        return;
      }

      sendTwilio({
        event: "clear",

        streamSid
      });

      if (
        assistantItemId &&
        assistantStartTimestamp !==
          null
      ) {
        const elapsed =
          Math.max(
            0,

            latestMediaTimestamp -
              assistantStartTimestamp
          );

        sendOpenAI({
          type:
            "conversation.item.truncate",

          item_id:
            assistantItemId,

          content_index:
            0,

          audio_end_ms:
            Math.floor(
              elapsed
            )
        });
      }

      resetPlayback();
    }

    function markPlayback() {
      if (
        !streamSid ||
        !assistantItemId
      ) {
        return;
      }

      currentMark =
        `jasmine-${++markCounter}`;

      sendTwilio({
        event: "mark",

        streamSid,

        mark: {
          name:
            currentMark
        }
      });
    }

    function flushAudio() {
      if (!sessionReady) {
        return;
      }

      for (
        const audio of
        pendingAudio
      ) {
        sendOpenAI({
          type:
            "input_audio_buffer.append",

          audio
        });
      }

      pendingAudio = [];
    }

    function greet() {
      if (
        !sessionReady ||
        greetingSent
      ) {
        return;
      }

      greetingSent = true;

      sendOpenAI({
        type:
          "response.create",

        response: {
          input: [],

          instructions:
            "Say exactly: Thanks for calling The Farmers Daughters Dispensary. This is Jasmine. How can I help?"
        }
      });
    }

    async function handleToolCall(
      event
    ) {
      if (
        !event.call_id ||
        handledCalls.has(
          event.call_id
        )
      ) {
        return;
      }

      handledCalls.add(
        event.call_id
      );

      const args =
        safeJson(
          event.arguments,
          {}
        );

      console.log(
        "Jasmine tool call:",
        event.name,
        pretty(args)
      );

      let result;

      try {
        result =
          await executeTool(
            event.name,
            args,
            context
          );
      } catch (error) {
        console.error(
          "Tool execution error:",
          error.message ||
            error
        );

        result = {
          success: false,

          message:
            "The requested action failed. Do not claim it succeeded."
        };
      }

      console.log(
        "Jasmine tool result:",
        event.name,
        pretty(result)
      );

      sendOpenAI({
        type:
          "conversation.item.create",

        item: {
          type:
            "function_call_output",

          call_id:
            event.call_id,

          output:
            JSON.stringify(
              result
            )
        }
      });

      sendOpenAI({
        type:
          "response.create"
      });
    }

    function connectOpenAI() {
      if (
        openaiWs ||
        stopped
      ) {
        return;
      }

      if (
        !OPENAI_API_KEY
      ) {
        twilioWs.close();
        return;
      }

      openaiWs =
        new WebSocket(
          "wss://api.openai.com/v1/realtime" +
            `?model=${encodeURIComponent(
              REALTIME_MODEL
            )}`,

          {
            headers: {
              Authorization:
                `Bearer ${OPENAI_API_KEY}`
            }
          }
        );

      openaiWs.on(
        "open",

        () => {
          console.log(
            `Connected to OpenAI Realtime: ${REALTIME_MODEL}`
          );

          sendOpenAI({
            type:
              "session.update",

            session: {
              type:
                "realtime",

              output_modalities: [
                "audio"
              ],

              audio: {
                input: {
                  format: {
                    type:
                      "audio/pcmu"
                  },

                  turn_detection: {
                    type:
                      "semantic_vad",

                    eagerness:
                      "high",

                    create_response:
                      true,

                    interrupt_response:
                      true
                  }
                },

                output: {
                  format: {
                    type:
                      "audio/pcmu"
                  },

                  voice:
                    REALTIME_VOICE
                }
              },

              instructions:
                JASMINE_INSTRUCTIONS,

              tools:
                TOOLS,

              tool_choice:
                "auto",

              max_output_tokens:
                300
            }
          });
        }
      );

      openaiWs.on(
        "message",

        async raw => {
          let event;

          try {
            event =
              JSON.parse(
                raw.toString()
              );
          } catch (error) {
            console.error(
              "Bad OpenAI event:",
              error.message
            );

            return;
          }

          if (
            event.type ===
            "session.updated"
          ) {
            if (
              !sessionReady
            ) {
              sessionReady =
                true;

              console.log(
                `Jasmine ready. Voice=${REALTIME_VOICE}, Model=${REALTIME_MODEL}`
              );

              greet();
              flushAudio();
            }

            return;
          }

          if (
            event.type ===
              "response.output_item.added" &&
            event.item?.type ===
              "message"
          ) {
            assistantItemId =
              event.item.id ||
              assistantItemId;

            assistantStartTimestamp =
              null;

            currentMark =
              null;

            return;
          }

          if (
            event.type ===
              "response.output_audio.delta" &&
            event.delta &&
            streamSid
          ) {
            if (
              event.item_id
            ) {
              assistantItemId =
                event.item_id;
            }

            if (
              assistantStartTimestamp ===
              null
            ) {
              assistantStartTimestamp =
                latestMediaTimestamp;
            }

            sendTwilio({
              event:
                "media",

              streamSid,

              media: {
                payload:
                  event.delta
              }
            });

            return;
          }

          if (
            event.type ===
            "response.output_audio.done"
          ) {
            markPlayback();
            return;
          }

          if (
            event.type ===
            "input_audio_buffer.speech_started"
          ) {
            if (
              assistantItemId
            ) {
              console.log(
                "Caller interrupted Jasmine."
              );

              clearPlayback();
            }

            return;
          }

          if (
            event.type ===
            "response.function_call_arguments.done"
          ) {
            await handleToolCall(
              event
            );

            return;
          }

          if (
            event.type ===
            "error"
          ) {
            console.error(
              "OpenAI Realtime error:",
              pretty(event)
            );
          }
        }
      );

      openaiWs.on(
        "error",

        error =>
          console.error(
            "OpenAI WebSocket error:",
            error.message ||
              error
          )
      );

      openaiWs.on(
        "close",

        (
          code,
          reason
        ) => {
          sessionReady =
            false;

          console.log(
            "OpenAI WebSocket closed:",
            code,
            reason?.toString?.() ||
              ""
          );

          if (
            !stopped &&
            socketOpen(
              twilioWs
            )
          ) {
            twilioWs.close();
          }
        }
      );
    }

    twilioWs.on(
      "message",

      raw => {
        let message;

        try {
          message =
            JSON.parse(
              raw.toString()
            );
        } catch (error) {
          console.error(
            "Bad Twilio media message:",
            error.message
          );

          return;
        }

        if (
          message.event ===
          "start"
        ) {
          streamSid =
            message.start
              ?.streamSid ||
            message.streamSid ||
            null;

          callSid =
            message.start
              ?.customParameters
              ?.callSid ||
            message.start
              ?.callSid ||
            null;

          callerNumber =
            message.start
              ?.customParameters
              ?.callerNumber ||
            null;

          console.log(
            "Twilio stream started:",

            pretty({
              streamSid,

              callSid,

              callerNumber,

              mediaFormat:
                message.start
                  ?.mediaFormat ||
                {}
            })
          );

          connectOpenAI();

          return;
        }

        if (
          message.event ===
          "media"
        ) {
          const audio =
            message.media
              ?.payload;

          const timestamp =
            Number(
              message.media
                ?.timestamp
            );

          if (
            Number.isFinite(
              timestamp
            )
          ) {
            latestMediaTimestamp =
              timestamp;
          }

          if (!audio) {
            return;
          }

          if (
            sessionReady &&
            socketOpen(
              openaiWs
            )
          ) {
            sendOpenAI({
              type:
                "input_audio_buffer.append",

              audio
            });
          } else {
            pendingAudio.push(
              audio
            );

            if (
              pendingAudio.length >
              500
            ) {
              pendingAudio =
                pendingAudio.slice(
                  -500
                );
            }
          }

          return;
        }

        if (
          message.event ===
            "mark" &&
          currentMark &&
          message.mark?.name ===
            currentMark
        ) {
          resetPlayback();
          return;
        }

        if (
          message.event ===
          "stop"
        ) {
          stopped = true;

          console.log(
            "Twilio media stream stopped."
          );

          if (
            socketOpen(
              openaiWs
            )
          ) {
            openaiWs.close();
          }
        }
      }
    );

    twilioWs.on(
      "error",

      error =>
        console.error(
          "Twilio WebSocket error:",
          error.message ||
            error
        )
    );

    twilioWs.on(
      "close",

      () => {
        stopped = true;

        console.log(
          "Twilio Media Stream closed."
        );

        if (
          socketOpen(
            openaiWs
          )
        ) {
          openaiWs.close();
        }
      }
    );
  }
);

server.listen(
  PORT,
  "0.0.0.0",

  () => {
    console.log(
      `Jasmine server running on port ${PORT}`
    );

    console.log(
      `Realtime model: ${REALTIME_MODEL}`
    );

    console.log(
      `Realtime voice: ${REALTIME_VOICE}`
    );

    console.log(
      `OpenAI configured: ${Boolean(OPENAI_API_KEY)}`
    );

    console.log(
      `Blackleaf SMS configured: ${Boolean(BLACKLEAF_API_KEY)}`
    );

    console.log(
      `Live Weedmaps menu configured: ${liveMenuConfigured()}`
    );
  }
);
