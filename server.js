const express = require("express");
const OpenAI = require("openai");
const { twiml: { VoiceResponse } } = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Pick one voice and keep it consistent.
// Good options supported by Twilio include:
// "Polly.Joanna-Generative"
// "Polly.Joanna-Neural"
// "Google.en-US-Chirp3-HD-Aoede"
const VOICE = "Polly.Joanna-Generative";

const GREETINGS = [
  "Thanks for calling The Farmers Daughters Dispensary in Brookings. How can I help you today?",
  "Thanks for calling The Farmers Daughters Dispensary. What can I help you with today?",
  "The Farmers Daughters Dispensary, Brookings. How can I help you today?"
];

const NO_INPUT_REPLIES = [
  "I didn't catch that. Give me one more try.",
  "Sorry, I missed that. What can I help you with?",
  "I didn't hear anything. Go ahead and ask me again."
];

const ERROR_REPLIES = [
  "Sorry, I'm having trouble right now. Please call the store staff for help.",
  "I'm having a little trouble on my end. Please try the store staff.",
  "Sorry about that. Please call the store staff for help."
];

const SYSTEM_PROMPT = `
You are the phone assistant for The Farmers Daughters Dispensary in Brookings, Oregon.

Known facts:
- Business name: The Farmers Daughters Dispensary
- Location: Brookings, Oregon
- Hours: 9 AM to 9 PM daily
- Payment: cash and debit accepted
- Age requirement: 21+ with valid ID
- Website/menu: www.thefarmersdaughtersdispensary.com
- First-time discounts: 5 percent first visit, 10 percent second, 15 percent third, 20 percent fourth

Style:
- Sound warm, upbeat, and natural.
- Keep answers short for phone calls.
- Usually answer in 1 sentence.
- Never ramble.
- Do not repeat the exact same wording every time.
- Use slight variation in phrasing so you sound more human.
- Do not mention being an AI unless asked.

Rules:
- If asked about hours, payment, website, age requirement, or first-time discounts, answer directly.
- If you do not know something, say: "I'm not sure on that. Please call the store staff for help."
- Do not guess inventory, pricing, cannabis laws, or medical advice.
- Do not make up specials, products, or menu items.
`;

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function cleanForPhone(text) {
  if (!text) return "I'm not sure on that. Please call the store staff for help.";

  return text
    .replace(/\s+/g, " ")
    .replace(/\bBrookings,\s*Oregon\b/gi, "Brookings")
    .trim()
    .slice(0, 280); // keep it short on the phone
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
      max_completion_tokens: 60
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
  res.send("Farmers Daughters AI phone server is running.");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
