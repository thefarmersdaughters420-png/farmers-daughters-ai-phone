const express = require("express");
const { twiml: { VoiceResponse } } = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

app.all("/voice", (req, res) => {
  const vr = new VoiceResponse();
  vr.say(
    { voice: "Polly.Joanna" },
    "Testing version 2. Beau this is the new server."
  );
  res.type("text/xml");
  res.send(vr.toString());
});

app.get("/", (req, res) => {
  res.send("Version 2 is live");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
