app.post("/ask", async (req, res) => {
  const question = (req.body.SpeechResult || "").trim();
  const callerNumber = req.body.From;
  const retryCount = parseInt(req.body.retryCount || "0", 10);
  const vr = new VoiceResponse();

  if (!question) {
    if (retryCount >= 1) {
      vr.say({ voice: VOICE }, "Alright, thanks for calling The Farmers Daughters Dispensary.");
      vr.hangup();
      res.type("text/xml");
      return res.send(vr.toString());
    }

    const gather = vr.gather({
      input: "speech",
      speechTimeout: "auto",
      timeout: 4,
      action: `/ask?retryCount=${retryCount + 1}`,
      method: "POST",
      actionOnEmptyResult: true
    });

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

      const gather = vr.gather({
        input: "speech",
        speechTimeout: "auto",
        timeout: 4,
        action: "/ask?retryCount=0",
        method: "POST",
        actionOnEmptyResult: true
      });

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

      const gather = vr.gather({
        input: "speech",
        speechTimeout: "auto",
        timeout: 4,
        action: "/ask?retryCount=0",
        method: "POST",
        actionOnEmptyResult: true
      });

      gather.say({ voice: VOICE }, pick(FOLLOW_UPS));

      res.type("text/xml");
      return res.send(vr.toString());
    }

    const instant = getInstantAnswer(question);
    if (instant) {
      vr.say({ voice: VOICE }, instant);

      const gather = vr.gather({
        input: "speech",
        speechTimeout: "auto",
        timeout: 4,
        action: "/ask?retryCount=0",
        method: "POST",
        actionOnEmptyResult: true
      });

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

    const gather = vr.gather({
      input: "speech",
      speechTimeout: "auto",
      timeout: 4,
      action: "/ask?retryCount=0",
      method: "POST",
      actionOnEmptyResult: true
    });

    gather.say({ voice: VOICE }, pick(FOLLOW_UPS));
  } catch (error) {
    console.error("Server error:", error);

    const gather = vr.gather({
      input: "speech",
      speechTimeout: "auto",
      timeout: 4,
      action: "/ask?retryCount=1",
      method: "POST",
      actionOnEmptyResult: true
    });

    gather.say({ voice: VOICE }, pick(ERROR_REPLIES));
  }

  res.type("text/xml");
  res.send(vr.toString());
});
