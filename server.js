const express = require("express");
const OpenAI = require("openai");
const { twiml: { VoiceResponse } } = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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

  vr.redirect("/voice");

  res.type("text/xml");
  res.send(vr.toString());
});

app.post("/ask", async (req, res) => {
  const question = req.body.SpeechResult || "";
  const vr = new VoiceResponse();

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `You are the phone assistant for The Farmers Daughters Dispensary in Brookings Oregon. Answer briefly and clearly. Question: ${question}`
    });

    const answer = response.output_text;

    vr.say({ voice: "Polly.Joanna" }, answer);
    vr.redirect("/voice");
  } catch (err) {
    vr.say("Sorry, I am having trouble answering right now.");
  }

  res.type("text/xml");
  res.send(vr.toString());
});

app.listen(process.env.PORT || 3000);
