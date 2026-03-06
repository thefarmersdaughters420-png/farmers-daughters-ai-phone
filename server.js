const express = require("express");
const OpenAI = require("openai");
const { twiml: { VoiceResponse } } = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SYSTEM_PROMPT = `
You are the phone assistant for The Farmers Daughters Dispensary in Brookings, Oregon.

Rules:
- Be friendly, calm, and concise.
- Keep answers short enough for a phone call.
- If you do not know something, say: "I'm not sure on that. Please call the store staff for help."
- Do not guess inventory, pricing, cannabis laws, or medical advice.
- Known facts:
  - Business name: The Farmers Daughters Dispensary
  - Location: Brookings, Oregon
  - Hours: 9 AM to 9 PM daily
  - Payment: cash and debit accepted
  - Age requirement: 21+ with valid ID
  - Website/menu: www.thefarmersdaughtersdispensary.com
  - First-time discounts: 5% first visit, 10% second, 15% third, 20% fourth
`;

app.post("/voice", (req, res) => {
  const vr = new VoiceResponse();

  const gather = vr.gather({
    input: "speech",
    speechTimeout: "auto",
    action: "/ask",
    method: "POST"
  });

  gather.say(
    { voice: "Polly.Joanna" },
    "Thanks for calling The Farmers Daughters Dispensary in Brookings. How can I help you today?"
  );

  vr.redirect({ method: "POST" }, "/voice");

  res.type("text/xml");
  res.send(vr.toString());
});

app.post("/ask", async (req, res) => {
  const userSpeech = req.body.SpeechResult || "";
  const vr = new VoiceResponse();

  if (!userSpeech.trim()) {
    vr.say({ voice: "Polly.Joanna" }, "I'm sorry, I didn't catch that.");
    vr.redirect({ method: "POST" }, "/voice");
    res.type("text/xml");
    return res.send(vr.toString());
  }

  try {
    const response = await client.responses.create({
      model: "gpt-5.4-mini",
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userSpeech }
      ]
    });

    const answer =
      (response.output_text || "").trim() ||
      "I'm sorry, I don't have that answer right now.";

    vr.say({ voice: "Polly.Joanna" }, answer);
    vr.pause({ length: 1 });
    vr.redirect({ method: "POST" }, "/voice");
  } catch (error) {
    console.error(error);
    vr.say(
      { voice: "Polly.Joanna" },
      "Sorry, the assistant is having trouble right now. Please call back in a little bit."
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
