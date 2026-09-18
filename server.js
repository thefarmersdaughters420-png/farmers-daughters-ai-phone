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

const BLACKLEAF_API_KEY = process.env.BLACKLEAF_API_KEY || "";
const BLACKLEAF_SMS_URL =
  "https://api.blackleaf.io/messaging/send/text";

const FLOWHUB_CLIENT_ID =
  process.env.FLOWHUB_CLIENT_ID || "";

const FLOWHUB_API_TOKEN =
  process.env.FLOWHUB_API_TOKEN || "";

const FLOWHUB_INVENTORY_URL =
  "https://api.flowhub.com/v0/inventory?max=1000";

const FLOWHUB_CACHE_MS =
  60 * 1000;

const MENU_URL =
  "https://www.thefarmersdaughtersdispensary.com/menu";

const WEBSITE_URL =
  "https://www.thefarmersdaughtersdispensary.com";

const STORE_ADDRESS =
  "1025 Chetco Ave, Brookings, Oregon 97415";

const STORE_PHONE =
  "541-813-1711";

const VENDOR_EMAIL =
  "brookingsvendors@gmail.com";

const FALLBACK_VOICE =
  "Polly.Danielle-Neural";

let inventoryCache = {
  fetchedAt: 0,
  rows: []
};


/* --------------------------------
   BASIC HELPERS
-------------------------------- */

function phone(v) {

  if (!v) {
    return null;
  }

  const r =
    String(v).trim();

  if (/^(client|sip):/i.test(r)) {
    return null;
  }

  const d =
    r.replace(/\D/g, "");

  if (d.length === 10) {
    return `+1${d}`;
  }

  if (
    d.length === 11 &&
    d[0] === "1"
  ) {
    return `+${d}`;
  }

  if (
    d.length >= 8 &&
    d.length <= 15
  ) {
    return `+${d}`;
  }

  return null;
}


function parse(v) {

  try {

    return v
      ? JSON.parse(v)
      : {};

  } catch {

    return {};
  }
}


function open(ws) {

  return (
    ws &&
    ws.readyState === WebSocket.OPEN
  );
}


function now() {

  const f =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          "America/Los_Angeles",

        weekday:
          "long",

        hour:
          "numeric",

        minute:
          "numeric",

        hourCycle:
          "h23"
      }
    );

  const p =
    Object.fromEntries(
      f
        .formatToParts(new Date())
        .map(
          x => [
            x.type,
            x.value
          ]
        )
    );

  return {

    day:
      (p.weekday || "")
        .toLowerCase(),

    mins:
      Number(p.hour) * 60 +
      Number(p.minute)
  };
}


/* --------------------------------
   STORE STATUS
-------------------------------- */

function status() {

  const m =
    now().mins;

  if (m < 540) {

    return (
      "We're closed right now and open at 9 AM today."
    );
  }

  if (m >= 1260) {

    return (
      "We're closed for the night and open again at 9 AM tomorrow."
    );
  }

  if (m >= 1230) {

    return (
      "We're open until 9 PM tonight, so we're closing soon."
    );
  }

  return (
    "We're open right now until 9 PM."
  );
}


/* --------------------------------
   DAILY DEALS
-------------------------------- */

function deal() {

  return ({

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

  })[now().day] ||
  "You can check today's deal on our website.";
}


/* --------------------------------
   TWILIO WEBSOCKET URL
-------------------------------- */

function wsUrl(req) {

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
        )

      + "/media-stream"
    );
  }

  return (
    `wss://${
      req.headers[
        "x-forwarded-host"
      ] ||
      req.headers.host
    }/media-stream`
  );
}


/* ================================================================
   FLOWHUB LIVE INVENTORY
================================================================ */


/*
  Normalize words for inventory searching.
*/

function normalizeText(value) {

  return String(
    value || ""
  )
    .toLowerCase()

    .replace(
      /[^a-z0-9]+/g,
      " "
    )

    .replace(
      /\s+/g,
      " "
    )

    .trim();
}


/*
  Very small singularizer so:

  gummies -> gummy
  carts -> cart
  edibles -> edible
*/

function singularize(token) {

  if (
    token.endsWith("ies") &&
    token.length > 4
  ) {

    return (
      `${token.slice(0, -3)}y`
    );
  }

  if (
    token.endsWith("s") &&
    token.length > 4 &&
    !token.endsWith("ss")
  ) {

    return token.slice(
      0,
      -1
    );
  }

  return token;
}


/*
  Remove conversational filler and
  add useful dispensary synonyms.
*/

function queryTokens(query) {

  const stop =
    new Set([

      "a",
      "an",
      "and",
      "any",
      "are",
      "can",
      "carry",
      "do",
      "does",
      "for",
      "got",
      "have",
      "i",
      "in",
      "is",
      "it",
      "looking",
      "me",
      "of",
      "please",
      "some",
      "stock",
      "the",
      "there",
      "what",
      "with",
      "you",
      "your"

    ]);

  const aliases = {

    cart: [
      "cartridge",
      "vape"
    ],

    cartridge: [
      "cart",
      "vape"
    ],

    carts: [
      "cartridge",
      "vape"
    ],

    dab: [
      "concentrate",
      "extract",
      "rosin"
    ],

    dabs: [
      "concentrate",
      "extract",
      "rosin"
    ],

    edible: [
      "gummy"
    ],

    edibles: [
      "edible",
      "gummy"
    ],

    gummies: [
      "gummy",
      "edible"
    ],

    gummy: [
      "edible"
    ],

    joint: [
      "pre roll",
      "preroll"
    ],

    joints: [
      "joint",
      "pre roll",
      "preroll"
    ],

    preroll: [
      "pre roll",
      "joint"
    ],

    prerolls: [
      "pre roll",
      "preroll",
      "joint"
    ],

    bud: [
      "flower"
    ],

    weed: [
      "flower"
    ]
  };


  const base =

    normalizeText(query)

      .split(" ")

      .map(
        singularize
      )

      .filter(
        token =>
          token &&
          !stop.has(token)
      );


  const expanded =
    new Set(base);


  for (
    const token of base
  ) {

    const extra =
      aliases[token] ||
      [];

    for (
      const value of extra
    ) {

      expanded.add(
        value
      );
    }
  }


  return [
    ...expanded
  ];
}


/*
  Get current quantity from the
  Flowhub item.
*/

function quantityOf(row) {

  const raw =

    row?.quantity ??

    row?.quantityAvailable ??

    row?.availableQuantity ??

    row?.onHandQuantity ??

    null;


  const n =
    Number(raw);


  return Number.isFinite(n)
    ? n
    : null;
}


/*
  Build searchable text from
  SAFE product information only.
*/

function itemSearchText(row) {

  return normalizeText(

    [

      row?.productName,

      row?.name,

      row?.brand,

      row?.category,

      row?.categoryName,

      row?.productType,

      row?.type,

      row?.variantName,

      row?.strainName,

      row?.supplierName

    ]

      .filter(Boolean)

      .join(" ")
  );
}


/*
  Give Jasmine cannabinoid information
  without exposing private Flowhub fields.
*/

function cannabinoidSummary(row) {

  const list =

    Array.isArray(
      row?.cannabinoidInformation
    )

      ? row.cannabinoidInformation

      : [];


  return list

    .filter(
      x =>
        x &&
        x.name
    )

    .slice(
      0,
      8
    )

    .map(
      x => ({

        name:
          String(
            x.name
          ),

        lowerRange:
          Number.isFinite(
            Number(
              x.lowerRange
            )
          )

            ? Number(
                x.lowerRange
              )

            : null,

        upperRange:
          Number.isFinite(
            Number(
              x.upperRange
            )
          )

            ? Number(
                x.upperRange
              )

            : null,

        unit:
          x.unitOfMeasure ||
          null

      })
    );
}


/*
  Flowhub weight-tier pricing.

  Flowhub supplies prices as cents,
  so 2500 becomes $25.
*/

function weightTierSummary(row) {

  const list =

    Array.isArray(
      row?.weightTierInformation
    )

      ? row.weightTierInformation

      : [];


  return list

    .slice(
      0,
      10
    )

    .map(
      x => {

        const cents =
          Number(
            x?.pricePerUnitInMinorUnits
          );

        const grams =
          Number(
            x?.gramAmount
          );


        return {

          name:
            x?.name ||
            null,

          gramAmount:
            Number.isFinite(
              grams
            )

              ? grams

              : null,

          price:
            Number.isFinite(
              cents
            )

              ? cents / 100

              : null
        };
      }
    )

    .filter(
      x =>
        x.name ||
        x.gramAmount !== null ||
        x.price !== null
    );
}


/*
  IMPORTANT:

  This is the ONLY Flowhub inventory
  information that gets passed back
  to the voice model.

  No client IDs.
  No costs.
  No regulatory IDs.
  No internal IDs.
  No private analytics.
*/

function publicInventoryItem(row) {

  const quantity =
    quantityOf(row);


  return {

    productName:
      row?.productName ||
      row?.name ||
      "Unknown product",

    brand:
      row?.brand ||
      null,

    category:
      row?.categoryName ||
      row?.category ||
      null,

    productType:
      row?.productType ||
      row?.type ||
      null,

    variantName:
      row?.variantName ||
      null,

    quantityAvailable:
      quantity,

    weightTiers:
      weightTierSummary(
        row
      ),

    cannabinoids:
      cannabinoidSummary(
        row
      )
  };
}


/*
  Rank search matches.
*/

function scoreInventoryRow(
  row,
  query,
  tokens
) {

  const text =
    itemSearchText(row);

  const phrase =
    normalizeText(query);


  if (!text) {
    return 0;
  }


  let score = 0;


  if (
    phrase &&
    text.includes(
      phrase
    )
  ) {

    score += 20;
  }


  for (
    const token of tokens
  ) {

    if (
      text.includes(
        normalizeText(
          token
        )
      )
    ) {

      score += 4;
    }
  }


  const productName =
    normalizeText(
      row?.productName ||
      row?.name
    );


  const brand =
    normalizeText(
      row?.brand
    );


  for (
    const token of tokens
  ) {

    const t =
      normalizeText(
        token
      );


    if (
      t &&
      productName.includes(t)
    ) {

      score += 3;
    }


    if (
      t &&
      brand.includes(t)
    ) {

      score += 2;
    }
  }


  return score;
}


/*
  Pull current inventory from Flowhub.

  Cache for 60 seconds so Jasmine
  does not burn through Flowhub's
  API request limit.
*/

async function fetchFlowhubInventory() {

  if (
    !FLOWHUB_CLIENT_ID ||
    !FLOWHUB_API_TOKEN
  ) {

    throw new Error(
      "Flowhub API credentials are not configured"
    );
  }


  const age =
    Date.now() -
    inventoryCache.fetchedAt;


  if (
    inventoryCache.rows.length &&
    age < FLOWHUB_CACHE_MS
  ) {

    return inventoryCache.rows;
  }


  const controller =
    new AbortController();


  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      8000
    );


  let response;


  try {

    response =
      await fetch(
        FLOWHUB_INVENTORY_URL,
        {

          headers: {

            clientId:
              FLOWHUB_CLIENT_ID,

            key:
              FLOWHUB_API_TOKEN,

            Accept:
              "application/json"
          },

          signal:
            controller.signal
        }
      );

  } finally {

    clearTimeout(
      timeout
    );
  }


  const raw =
    await response.text();


  if (!response.ok) {

    console.error(

      "Flowhub inventory request failed:",

      response.status,

      raw.slice(
        0,
        1000
      )
    );


    throw new Error(
      `Flowhub inventory request failed (${response.status})`
    );
  }


  let data;


  try {

    data =
      raw
        ? JSON.parse(raw)
        : {};

  } catch {

    throw new Error(
      "Flowhub returned invalid JSON"
    );
  }


  const rows =

    Array.isArray(data)

      ? data

      : Array.isArray(
          data?.data
        )

        ? data.data

        : Array.isArray(
            data?.inventory
          )

          ? data.inventory

          : Array.isArray(
              data?.items
            )

            ? data.items

            : [];


  inventoryCache = {

    fetchedAt:
      Date.now(),

    rows:
      rows
  };


  console.log(
    `Flowhub inventory refreshed: ${rows.length} rows`
  );


  return rows;
}


/*
  Search live Flowhub inventory.
*/

async function searchFlowhubInventory(
  query
) {

  const cleanQuery =
    String(
      query || ""
    ).trim();


  if (!cleanQuery) {

    return {

      success:
        false,

      liveDataChecked:
        false,

      message:
        "No inventory search term was provided."
    };
  }


  const rows =
    await fetchFlowhubInventory();


  const tokens =
    queryTokens(
      cleanQuery
    );


  const scored =

    rows

      .map(
        row => ({

          row,

          quantity:
            quantityOf(
              row
            ),

          score:
            scoreInventoryRow(
              row,
              cleanQuery,
              tokens
            )
        })
      )

      .filter(
        x =>
          x.quantity !== null &&
          x.quantity > 0
      )

      .filter(
        x =>
          x.score > 0
      )

      .sort(
        (a, b) =>
          b.score -
          a.score
      );


  /*
    Combine duplicate batches
    of the same product.
  */

  const merged =
    new Map();


  for (
    const entry of scored
  ) {

    const item =
      publicInventoryItem(
        entry.row
      );


    const key =
      normalizeText(

        [

          item.productName,

          item.brand,

          item.variantName

        ]

          .filter(Boolean)

          .join("|")
      );


    if (
      !merged.has(
        key
      )
    ) {

      merged.set(
        key,
        {

          ...item,

          matchScore:
            entry.score
        }
      );

    } else {

      const existing =
        merged.get(
          key
        );


      existing.quantityAvailable +=
        item.quantityAvailable ||
        0;


      existing.matchScore =
        Math.max(

          existing.matchScore,

          entry.score
        );
    }
  }


  const results =

    [
      ...merged.values()
    ]

      .sort(
        (a, b) =>
          b.matchScore -
          a.matchScore
      )

      .slice(
        0,
        6
      )

      .map(
        ({
          matchScore,
          ...item
        }) => item
      );


  if (
    !results.length
  ) {

    return {

      success:
        true,

      liveDataChecked:
        true,

      found:
        false,

      query:
        cleanQuery,

      results:
        [],

      message:

        `I checked live Flowhub inventory and did not find an in-stock match for "${cleanQuery}". ` +

        "Do not guess. Say you did not find a current match and offer to text the live online menu."
    };
  }


  return {

    success:
      true,

    liveDataChecked:
      true,

    found:
      true,

    query:
      cleanQuery,

    results:
      results,

    message:

      `I checked live Flowhub inventory and found ${results.length} matching in-stock item${results.length === 1 ? "" : "s"}. ` +

      "Answer from these results only. Do not invent other products or prices."
  };
}


/* ================================================================
   BLACKLEAF TEXTING
================================================================ */


/*
  We intentionally do NOT use
  templateId or sendingProfileId.

  This is the Blackleaf method that
  already worked in production.
*/

async function textLink(to) {

  const toPhone =
    phone(to);


  console.log(
    "Blackleaf destination:",
    toPhone
  );


  if (!toPhone) {

    throw new Error(
      "Invalid caller phone number"
    );
  }


  if (
    !BLACKLEAF_API_KEY
  ) {

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

          method:
            "POST",

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

              to:
                toPhone,

              body:
                "The Farmers Daughters: " +
                "The information you requested is ready. " +
                "View it here: {{url}}",

              landingUrl:
                MENU_URL,

              unsubscribeText:
                "Reply STOP to unsubscribe"
            }),

          signal:
            controller.signal
        }
      );

  } finally {

    clearTimeout(
      timeout
    );
  }


  const raw =
    await response.text();


  let data;


  try {

    data =
      raw
        ? JSON.parse(raw)
        : {};

  } catch {

    data = {
      raw
    };
  }


  const rejected =

    !response.ok ||

    data?.success === false ||

    data?.accepted === false ||

    String(
      data?.status || ""
    )
      .toLowerCase() ===
      "rejected";


  if (rejected) {

    console.error(

      "Blackleaf rejected:",

      JSON.stringify(
        data,
        null,
        2
      )
    );


    throw new Error(
      `Blackleaf send failed (${response.status})`
    );
  }


  console.log(

    "Blackleaf accepted:",

    JSON.stringify(
      data,
      null,
      2
    )
  );


  return data;
}


/* ================================================================
   JASMINE INSTRUCTIONS
================================================================ */

const INSTRUCTIONS = `
You are Jasmine, the phone assistant for The Farmers Daughters Dispensary in Brookings, Oregon.

Speak naturally like a knowledgeable budtender. Be warm, relaxed, confident, and concise. Most answers should be one or two short sentences. Let callers interrupt.

Do not say you are an AI unless directly asked. If asked, say you are the shop's automated phone assistant.

Never invent facts, prices, policies, deals, or inventory.

Store facts:
- Address: ${STORE_ADDRESS}. Right off Highway 101 behind Dragon Palace and Rancho Viejo, set back by the tall dispensary sign.
- Hours: 9 AM to 9 PM every day.
- Payment: cash and debit.
- Age: 21+ with valid ID.
- Website: ${WEBSITE_URL}
- Menu and online ordering: ${MENU_URL}
- Phone: ${STORE_PHONE}
- First visit 5% off, second 10%, third 15%, fourth 20%.
- Happy hour daily 4:20-6:20 PM: 20% off Cookies, Khalifa Kush, Tyson, Select, and Hotbox.
- Monday: 4x loyalty points.
- Tuesday: 20% off infused joints and joint packs.
- Wednesday: 20% off cartridges.
- Thursday: 20% off edibles.
- Friday: 20% off flower in jars.
- Saturday: 20% off dabs, extracts, and rosin.
- Sunday: 50% off ounces in jars.
- Vendors: ${VENDOR_EMAIL}. Showing and samples Monday-Friday.

Inventory rules:
- Live Flowhub inventory is connected through check_live_inventory.
- For ANY question about whether a product, brand, category, strain, edible, cart, concentrate, flower, pre-roll, or other item is currently available, call check_live_inventory before answering.
- Answer inventory questions only from the tool result.
- If the tool says found=false, say you did not find a current in-stock match. Do not say the shop never carries it.
- If the tool fails, say you cannot verify inventory right now and offer to text the live online menu.
- Do not read exact quantity to the caller unless they specifically ask how much is available. Quantity units can differ by product type.
- Only quote a price if the tool result actually includes that price.
- Never reveal SKU, regulatory IDs, API credentials, internal IDs, costs, wholesale cost, or private inventory metadata.

Privacy rules:
- You do not have access to sales totals, revenue, profit, margins, costs, customer records, employee information, payroll, or other private business analytics.
- If a caller asks for private business information, say: "I don't have access to private business information like sales or profits."
- Never attempt to infer private business numbers from inventory or other information.

Other rules:
- Use get_store_status for current open/closed status.
- Use get_todays_deal for today's deal.
- If asked to text the menu or ordering link, call send_menu_text immediately.
- Never claim a text succeeded unless the tool returns success=true.
- If asked how to order, say orders go through the online menu and offer to text it.
- If asked to text today's deals, call send_deals_text.
- Never take an order over the phone.
- For an unknown store-specific question, use record_unknown_question.
- After tools, answer naturally without mentioning APIs, Flowhub, or Blackleaf.
`;


/* ================================================================
   OPENAI TOOLS
================================================================ */

const TOOLS = [

  {
    type:
      "function",

    name:
      "get_store_status",

    description:
      "Get current store open or closed status.",

    parameters: {

      type:
        "object",

      properties:
        {},

      additionalProperties:
        false
    }
  },


  {
    type:
      "function",

    name:
      "get_todays_deal",

    description:
      "Get today's daily deal.",

    parameters: {

      type:
        "object",

      properties:
        {},

      additionalProperties:
        false
    }
  },


  {
    type:
      "function",

    name:
      "check_live_inventory",

    description:
      "Search the dispensary's live Flowhub inventory for a product, brand, category, strain, or product type. Use this before answering any current stock question.",

    parameters: {

      type:
        "object",

      properties: {

        query: {

          type:
            "string",

          description:
            "Short inventory search phrase, for example Drops gummies, rosin, Blue Dream, carts, or Cookies."
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
    type:
      "function",

    name:
      "send_menu_text",

    description:
      "Text the requested information and menu link to the current caller.",

    parameters: {

      type:
        "object",

      properties:
        {},

      additionalProperties:
        false
    }
  },


  {
    type:
      "function",

    name:
      "send_deals_text",

    description:
      "Text the requested information link after discussing today's deal.",

    parameters: {

      type:
        "object",

      properties:
        {},

      additionalProperties:
        false
    }
  },


  {
    type:
      "function",

    name:
      "record_unknown_question",

    description:
      "Log an unknown store-specific question for owner review.",

    parameters: {

      type:
        "object",

      properties: {

        question: {

          type:
            "string"
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


/* ================================================================
   TOOL EXECUTION
================================================================ */

async function tool(
  name,
  args,
  ctx
) {


  if (
    name ===
    "get_store_status"
  ) {

    return {

      success:
        true,

      message:
        status()
    };
  }


  if (
    name ===
    "get_todays_deal"
  ) {

    return {

      success:
        true,

      message:
        deal()
    };
  }


  /*
    LIVE FLOWHUB INVENTORY
  */

  if (
    name ===
    "check_live_inventory"
  ) {

    try {

      return (
        await searchFlowhubInventory(
          args?.query
        )
      );

    } catch (e) {

      console.error(

        "Flowhub inventory error:",

        e.message ||
        e
      );


      return {

        success:
          false,

        liveDataChecked:
          false,

        message:
          "Live inventory could not be verified right now. Do not guess stock or price. Offer to text the live online menu."
      };
    }
  }


  /*
    BLACKLEAF SMS
  */

  if (
    name ===
      "send_menu_text" ||

    name ===
      "send_deals_text"
  ) {

    if (
      !ctx.callerNumber
    ) {

      return {

        success:
          false,

        message:
          "Caller phone number is unavailable. Do not claim a text was sent."
      };
    }


    try {

      return {

        success:
          true,

        message:
          "The requested information link was accepted for sending.",

        provider:
          await textLink(
            ctx.callerNumber
          )
      };

    } catch (e) {

      console.error(

        "SMS error:",

        e.message ||
        e
      );


      return {

        success:
          false,

        message:
          "The text failed. Do not claim it was sent. Give the website address instead."
      };
    }
  }


  /*
    UNKNOWN QUESTION LOG
  */

  if (
    name ===
    "record_unknown_question"
  ) {

    console.log(

      "JASMINE_UNKNOWN_QUESTION",

      JSON.stringify({

        time:
          new Date()
            .toISOString(),

        callSid:
          ctx.callSid ||
          null,

        caller:
          ctx.callerNumber ||
          null,

        question:
          String(
            args?.question ||
            ""
          )
            .trim()
      })
    );


    return {

      success:
        true,

      message:
        "Question logged for owner review."
    };
  }


  return {

    success:
      false,

    message:
      `Unknown tool: ${name}`
  };
}


/* ================================================================
   WEB ROUTES
================================================================ */

app.get(

  "/",

  (req, res) =>
    res.send(
      "Jasmine realtime phone server is running."
    )
);


app.get(

  "/health",

  (req, res) =>
    res.json({

      ok:
        true,

      model:
        REALTIME_MODEL,

      voice:
        REALTIME_VOICE,

      openai:
        Boolean(
          OPENAI_API_KEY
        ),

      blackleaf:
        Boolean(
          BLACKLEAF_API_KEY
        ),

      flowhub:
        Boolean(
          FLOWHUB_CLIENT_ID &&
          FLOWHUB_API_TOKEN
        ),

      liveInventory:
        Boolean(
          FLOWHUB_CLIENT_ID &&
          FLOWHUB_API_TOKEN
        )
    })
);


/* ================================================================
   TWILIO VOICE ENTRY
================================================================ */

app.post(

  "/voice",

  (req, res) => {

    const callSid =
      req.body.CallSid ||
      "unknown";


    const caller =

      req.body.From ||

      req.body.Caller ||

      req.body.CallerNumber ||

      "unknown";


    console.log(

      "Incoming call:",

      callSid,

      caller
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

        "Sorry, Jasmine is temporarily unavailable. Please visit thefarmersdaughtersdispensary.com."
      );


      vr.hangup();


      res.type(
        "text/xml"
      );


      return res.send(
        vr.toString()
      );
    }


    const s =
      vr

        .connect()

        .stream({

          url:
            wsUrl(req)
        });


    s.parameter({

      name:
        "callSid",

      value:
        String(
          callSid
        )
    });


    s.parameter({

      name:
        "callerNumber",

      value:
        String(
          caller
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


/* ================================================================
   HTTP + WEBSOCKET SERVER
================================================================ */

const server =
  http.createServer(
    app
  );


const wss =
  new WebSocketServer({

    noServer:
      true
  });


server.on(

  "upgrade",

  (
    req,
    socket,
    head
  ) => {

    let p =
      "";


    try {

      p =
        new URL(

          req.url,

          "http://localhost"
        ).pathname;

    } catch {

      socket.destroy();

      return;
    }


    if (
      p !==
      "/media-stream"
    ) {

      socket.destroy();

      return;
    }


    wss.handleUpgrade(

      req,

      socket,

      head,

      ws =>
        wss.emit(

          "connection",

          ws,

          req
        )
    );
  }
);


/* ================================================================
   TWILIO ↔ OPENAI REALTIME
================================================================ */

wss.on(

  "connection",

  tw => {

    console.log(
      "Twilio Media Stream connected."
    );


    let sid =
      null;

    let callSid =
      null;

    let caller =
      null;

    let lastTs =
      0;

    let startTs =
      null;

    let itemId =
      null;

    let mark =
      null;

    let markN =
      0;

    let oa =
      null;

    let ready =
      false;

    let greeted =
      false;

    let stopped =
      false;

    let pending =
      [];


    const done =
      new Set();


    const ctx = {

      get callSid() {

        return callSid;
      },


      get callerNumber() {

        return phone(
          caller
        );
      }
    };


    const toTw =
      o => {

        if (
          open(tw)
        ) {

          tw.send(
            JSON.stringify(
              o
            )
          );
        }
      };


    const toOA =
      o => {

        if (
          !open(oa)
        ) {

          return false;
        }


        oa.send(
          JSON.stringify(
            o
          )
        );


        return true;
      };


    const reset =
      () => {

        startTs =
          null;

        itemId =
          null;

        mark =
          null;
      };


    const clear =
      () => {

        if (!sid) {
          return;
        }


        toTw({

          event:
            "clear",

          streamSid:
            sid
        });


        if (
          itemId &&
          startTs !== null
        ) {

          toOA({

            type:
              "conversation.item.truncate",

            item_id:
              itemId,

            content_index:
              0,

            audio_end_ms:
              Math.max(

                0,

                Math.floor(
                  lastTs -
                  startTs
                )
              )
          });
        }


        reset();
      };


    const markDone =
      () => {

        if (
          !sid ||
          !itemId
        ) {

          return;
        }


        mark =
          `jasmine-${++markN}`;


        toTw({

          event:
            "mark",

          streamSid:
            sid,

          mark: {

            name:
              mark
          }
        });
      };


    const flush =
      () => {

        if (!ready) {
          return;
        }


        for (
          const a of pending
        ) {

          toOA({

            type:
              "input_audio_buffer.append",

            audio:
              a
          });
        }


        pending =
          [];
      };


    const greet =
      () => {

        if (
          !ready ||
          greeted
        ) {

          return;
        }


        greeted =
          true;


        toOA({

          type:
            "response.create",

          response: {

            input:
              [],

            instructions:
              "Say exactly: Thanks for calling The Farmers Daughters Dispensary. This is Jasmine. How can I help?"
          }
        });
      };


    async function callTool(e) {

      if (
        !e.call_id ||
        done.has(
          e.call_id
        )
      ) {

        return;
      }


      done.add(
        e.call_id
      );


      const args =
        parse(
          e.arguments
        );


      console.log(

        "Jasmine tool call:",

        e.name,

        JSON.stringify(
          args
        )
      );


      let r;


      try {

        r =
          await tool(

            e.name,

            args,

            ctx
          );

      } catch (err) {

        console.error(

          "Tool error:",

          err.message ||
          err
        );


        r = {

          success:
            false,

          message:
            "The requested action failed. Do not claim it succeeded."
        };
      }


      console.log(

        "Jasmine tool result:",

        e.name,

        JSON.stringify(
          r
        )
      );


      toOA({

        type:
          "conversation.item.create",

        item: {

          type:
            "function_call_output",

          call_id:
            e.call_id,

          output:
            JSON.stringify(
              r
            )
        }
      });


      toOA({

        type:
          "response.create"
      });
    }


    function connect() {

      if (
        oa ||
        stopped
      ) {

        return;
      }


      oa =
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


      oa.on(

        "open",

        () => {

          console.log(

            "Connected to OpenAI Realtime:",

            REALTIME_MODEL
          );


          toOA({

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
                INSTRUCTIONS,

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


      oa.on(

        "message",

        async raw => {

          let e;


          try {

            e =
              JSON.parse(
                raw.toString()
              );

          } catch {

            return;
          }


          if (
            e.type ===
            "session.updated"
          ) {

            if (!ready) {

              ready =
                true;


              console.log(

                `Jasmine ready. Voice=${REALTIME_VOICE}, Model=${REALTIME_MODEL}`
              );


              greet();

              flush();
            }


            return;
          }


          if (
            e.type ===
              "response.output_item.added" &&

            e.item?.type ===
              "message"
          ) {

            itemId =
              e.item.id ||
              itemId;


            startTs =
              null;

            mark =
              null;


            return;
          }


          if (
            e.type ===
              "response.output_audio.delta" &&

            e.delta &&

            sid
          ) {

            if (
              e.item_id
            ) {

              itemId =
                e.item_id;
            }


            if (
              startTs === null
            ) {

              startTs =
                lastTs;
            }


            toTw({

              event:
                "media",

              streamSid:
                sid,

              media: {

                payload:
                  e.delta
              }
            });


            return;
          }


          if (
            e.type ===
            "response.output_audio.done"
          ) {

            markDone();

            return;
          }


          if (
            e.type ===
            "input_audio_buffer.speech_started"
          ) {

            if (
              itemId
            ) {

              console.log(
                "Caller interrupted Jasmine."
              );


              clear();
            }


            return;
          }


          if (
            e.type ===
            "response.function_call_arguments.done"
          ) {

            await callTool(
              e
            );


            return;
          }


          if (
            e.type ===
            "error"
          ) {

            console.error(

              "OpenAI Realtime error:",

              JSON.stringify(
                e
              )
            );
          }
        }
      );


      oa.on(

        "error",

        e =>
          console.error(

            "OpenAI WebSocket error:",

            e.message ||
            e
          )
      );


      oa.on(

        "close",

        (
          c,
          r
        ) => {

          ready =
            false;


          console.log(

            "OpenAI WebSocket closed:",

            c,

            r?.toString?.() ||
            ""
          );


          if (
            !stopped &&
            open(tw)
          ) {

            tw.close();
          }
        }
      );
    }


    /* --------------------------------
       TWILIO EVENTS
    -------------------------------- */

    tw.on(

      "message",

      raw => {

        let m;


        try {

          m =
            JSON.parse(
              raw.toString()
            );

        } catch {

          return;
        }


        if (
          m.event ===
          "start"
        ) {

          sid =

            m.start?.streamSid ||

            m.streamSid ||

            null;


          callSid =

            m.start
              ?.customParameters
              ?.callSid ||

            m.start
              ?.callSid ||

            null;


          caller =

            m.start
              ?.customParameters
              ?.callerNumber ||

            null;


          console.log(

            "Twilio stream started:",

            JSON.stringify({

              sid,

              callSid,

              caller,

              format:
                m.start
                  ?.mediaFormat ||
                {}
            })
          );


          connect();

          return;
        }


        if (
          m.event ===
          "media"
        ) {

          const a =
            m.media?.payload;


          const t =
            Number(
              m.media?.timestamp
            );


          if (
            Number.isFinite(t)
          ) {

            lastTs =
              t;
          }


          if (!a) {
            return;
          }


          if (
            ready &&
            open(oa)
          ) {

            toOA({

              type:
                "input_audio_buffer.append",

              audio:
                a
            });

          } else {

            pending.push(
              a
            );


            if (
              pending.length >
              500
            ) {

              pending =
                pending.slice(
                  -500
                );
            }
          }


          return;
        }


        if (
          m.event ===
            "mark" &&

          mark &&

          m.mark?.name ===
            mark
        ) {

          reset();

          return;
        }


        if (
          m.event ===
          "stop"
        ) {

          stopped =
            true;


          console.log(
            "Twilio media stream stopped."
          );


          if (
            open(oa)
          ) {

            oa.close();
          }
        }
      }
    );


    tw.on(

      "error",

      e =>
        console.error(

          "Twilio WebSocket error:",

          e.message ||
          e
        )
    );


    tw.on(

      "close",

      () => {

        stopped =
          true;


        console.log(
          "Twilio Media Stream closed."
        );


        if (
          open(oa)
        ) {

          oa.close();
        }
      }
    );
  }
);


/* ================================================================
   START SERVER
================================================================ */

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
      `OpenAI configured: ${Boolean(
        OPENAI_API_KEY
      )}`
    );


    console.log(
      `Blackleaf API configured: ${Boolean(
        BLACKLEAF_API_KEY
      )}`
    );


    console.log(
      `Flowhub inventory configured: ${Boolean(
        FLOWHUB_CLIENT_ID &&
        FLOWHUB_API_TOKEN
      )}`
    );
  }
);
