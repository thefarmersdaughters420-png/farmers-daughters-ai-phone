const express = require("express");
const OpenAI = require("openai");
const { twiml: { VoiceResponse } } = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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

Rules:
- Be friendly, calm, and concise.
- Keep answers short enough for a phone call.
- If you do not know something, say: "I'm not sure on that. Please call the store staff for help."
- Do not guess inventory, pricing, cannabis laws, or medical advice.
- Do not mention being an AI unless asked.
`;

app.all("/voice", (req, res) => {
  const vr = new VoiceResponse();

  const gather = vr.gather({
    input: "speech",
    speechTimeout: "auto",
    timeout: 5,
    action: "/ask",
    method: "POST"
  });

  gather.say(
    { voice: "Polly.Joanna" },
    "Thanks for calling The Farmers Daughters Dispensary in Brookings. How can I help you today?"
  );

  vr.say(
    { voice: "Polly.Joanna" },
    "I didn't hear anything. Please call again."
  );

  res.type("text/xml");
  res.send(vr.toString());
});

app.all("/ask", async (req, res) => {
  const question = (req.body.SpeechResult || "").trim();
  const vr = new VoiceResponse();

  if (!question) {
    vr.say({ voice: "Polly.Joanna" }, "Sorry, I did not catch that.");
    vr.redirect({ method: "POST" }, "/voice");
    res.type("text/xml");
    return res.send(vr.toString());
  }

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: question }
      ]
    });

    const answer =
      (response.output_text || "").trim() ||
      "I'm sorry, I don't have that answer right now.";

    vr.say({ voice: "Polly.Joanna" }, answer);
    vr.redirect({ method: "POST" }, "/voice");
  } catch (error) {
    console.error("OpenAI error:", error);
    vr.say(
      { voice: "Polly.Joanna" },
      "Sorry, I am having trouble answering right now."
    );
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
