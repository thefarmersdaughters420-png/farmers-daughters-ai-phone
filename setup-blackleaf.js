const API_KEY = process.env.BLACKLEAF_API_KEY;

if (!API_KEY) {
  console.error("ERROR: BLACKLEAF_API_KEY is missing.");
  process.exit(1);
}

const API_BASE = "https://api.blackleaf.io";

async function blackleaf(path, options = {}) {
  const response = await fetch(API_BASE + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: "application/json",
      ...(options.body
        ? { "Content-Type": "application/json" }
        : {}),
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  return {
    response,
    data
  };
}

async function main() {
  console.log("Looking up Blackleaf sender profiles...");

  const senderResult = await blackleaf(
    "/messaging/senders/profiles?pageSize=100&page=0"
  );

  if (!senderResult.response.ok) {
    console.error(
      "Sender lookup failed:",
      JSON.stringify(senderResult.data, null, 2)
    );
    process.exit(1);
  }

  const items =
    senderResult.data?.items ||
    senderResult.data?.data?.items ||
    [];

  const sender = items.find(item => {
    const name = String(
      item?.title ||
      item?.name ||
      ""
    )
      .trim()
      .toLowerCase();

    return name === "10 dlc - marketing";
  });

  if (!sender) {
    console.error(
      "Could not find sender named '10 DLC - Marketing'."
    );

    console.log(
      "Available senders:",
      items.map(item => ({
        name: item?.title || item?.name,
        healthy: item?.healthy
      }))
    );

    process.exit(1);
  }

  const senderId =
    sender._id ||
    sender.id;

  console.log(
    "Found sender:",
    sender.title || sender.name
  );

  console.log("Creating menu template...");

  const templateResult = await blackleaf(
    "/messaging/create/template",
    {
      method: "POST",

      body: JSON.stringify({
        body:
  "The Farmers Daughters: " +
  "The information you requested is ready. View it here: {{url}}",

        unsubscribeText:
          "Reply STOP to unsubscribe"
      })
    }
  );

  console.log(
    "Template response:",
    JSON.stringify(
      templateResult.data,
      null,
      2
    )
  );

  const template =
    templateResult.data;

  const accepted =
    templateResult.response.ok &&
    template?.accepted === true &&
    template?.bodyAccepted === true &&
    String(
      template?.status || ""
    ).toLowerCase() === "accepted";

  if (!accepted) {
    console.error(
      "\nTEMPLATE WAS NOT ACCEPTED."
    );

    console.error(
      "Do not change Jasmine yet."
    );

    process.exit(1);
  }

  console.log(
    "\nSUCCESS — SAVE THESE TWO RAILWAY VARIABLES:"
  );

  console.log(
    `BLACKLEAF_SENDER_PROFILE_ID=${senderId}`
  );

  console.log(
    `BLACKLEAF_MENU_TEMPLATE_ID=${template.id}`
  );
}

main().catch(error => {
  console.error(
    "Setup failed:",
    error
  );

  process.exit(1);
});
