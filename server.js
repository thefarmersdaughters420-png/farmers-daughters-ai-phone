const express = require("express");
const OpenAI = require("openai");
const { twiml: { VoiceResponse } } = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const VOICE = "Polly.Danielle-Neural";

const GREETINGS = [
  "Hi, thanks for calling The Farmers Daughters Dispensary. This is Jasmine. How can I help you today?",
  "Thanks for calling The Farmers Daughters Dispensary. This is Jasmine. What can I help you with today?",
  "The Farmers Daughters Dispensary in Brookings. This is Jasmine. How can I help you today?"
];

const NO_INPUT_REPLIES = [
  "I didn't catch that. Go ahead and ask me again.",
  "Sorry, I missed that. What can I help you with?",
  "I didn't hear anything. Go ahead and try that again."
];

const ERROR_REPLIES = [
  "Sorry about that. The live menu on the website is the best place to check.",
  "I had a little trouble there. Best bet is the live menu on the website.",
  "Sorry about that. You can check the live menu on the website."
];

const SYSTEM_PROMPT = `
You are Jasmine, the phone assistant for The Farmers Daughters Dispensary in Brookings, Oregon.

Known facts:
- Business name: The Farmers Daughters Dispensary
- Location: Brookings, Oregon
- Full address: 1025 Chetco Ave, Brookings, OR 97415
- Directions: Right off Highway 101, behind Dragon Palace and Rancho Viejo. The shop sits a little back off the road by the tall dispensary sign.
- Hours: 9 AM to 9 PM daily
- Payment: cash and debit accepted
- Age requirement: 21+ with valid ID
- Website/menu: www.thefarmersdaughtersdispensary.com
- First-time discounts: 5 percent first visit, 10 percent second, 15 percent third, 20 percent fourth

Happy hour:
- Every day from 4:20 PM to 6:20 PM
- 20 percent off Brand Select, Cookies, Hotbox, Tyson, and Khalifa

Daily deals:
- Monday: 4x loyalty points
- Tuesday: 20 percent off infused joints and joint packs
- Wednesday: 20 percent off cartridges
- Thursday: 20 percent off edibles
- Friday: 20 percent off flower in jars
- Saturday: 20 percent off dabs, extracts, and rosin
- Sunday: 50 percent off ounces in jars

Style:
- Sound warm, relaxed, natural, and conversational.
- Sound like a real budtender.
- Keep answers short for phone calls.
- Usually answer in 1 sentence, sometimes 2 short sentences.
- Never ramble.
- Do not repeat the exact same wording every time.
- Use slight variation in phrasing so you sound more human.
- Do not mention being an AI unless asked.

Rules:
- If asked about hours, payment, website, age requirement, discounts, happy hour, address, directions, or daily deals, answer directly.
- If asked where the store is, mention that it sits a little back off the road.
- If asked about ordering, say orders should go through the website menu.
- Never take orders over the phone.
- Do not guess inventory, pricing, cannabis laws, or medical advice.
- Do not make up specials, products, or menu items.
- If you do not know something, say: "I don't want to give you the wrong info, but the live menu on the website is the best place to check."
`;

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function cleanForPhone(text) {
  if (!text) {
    return "I don't want to give you the wrong info, but the live menu on the website is the best place to check.";
  }

  return text
    .replace(/\s+/g, " ")
    .replace(/\bBrookings,\s*Oregon\b/gi, "Brookings")
    .trim()
    .slice(0, 220);
}

app.all("/voice", (req, res) => {
  const vr = new VoiceResponse();

  const gather = vr.gather({
    input: "speech",
    speechTimeout: 1,
    timeout: 3,
    action: "/ask",
    method: "POST"
  });

  gather.say({ voice: VOICE }, pick(GREETINGS));

  vr.say({ voice: VOICE }, pick(NO_INPUT_REPLIES));
  vr.redirect({ method: "POST" }, "/voice");

  res.type("text/xml");
  res.send(vr.toString());
});

app.all("/ask", async (req, res) => {
  const question = (req.body.SpeechResult || "").trim();
  const vr = new VoiceResponse();

  if (!question) {
    vr.say({ voice: VOICE }, pick(NO_INPUT_REPLIES));
    vr.redirect({ method: "POST" }, "/voice");
    res.type("text/xml");
    return res.send(vr.toString());
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "developer", content: SYSTEM_PROMPT },
        { role: "user", content: question }
      ],
      max_completion_tokens: 50,
      temperature: 0.5
    });

    const answer = cleanForPhone(
      response.choices?.[0]?.message?.content || ""
    );

    vr.say({ voice: VOICE }, answer);
    vr.pause({ length: 1 });

    const gather = vr.gather({
      input: "speech",
      speechTimeout: 1,
      timeout: 3,
      action: "/ask",
      method: "POST"
    });

    gather.say({ voice: VOICE }, "Anything else I can help with?");

    vr.say({ voice: VOICE }, pick(NO_INPUT_REPLIES));
    vr.hangup();
  } catch (error) {
    console.error("OpenAI error:", error);
    vr.say({ voice: VOICE }, pick(ERROR_REPLIES));
    vr.hangup();
  }

  res.type("text/xml");
  res.send(vr.toString());
});

app.get("/", (req, res) => {
  res.send("Jasmine phone server is running.");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
