const CLIENT_ID = process.env.FLOWHUB_CLIENT_ID;
const KEY = process.env.FLOWHUB_API_TOKEN;

if (!CLIENT_ID || !KEY) {
  console.error("Missing FLOWHUB_CLIENT_ID or FLOWHUB_API_TOKEN");
  process.exit(1);
}

async function test(path) {
  const url = `https://api.flowhub.com${path}`;

  console.log("\nTESTING:", url);

  const response = await fetch(url, {
    headers: {
      clientId: CLIENT_ID,
      key: KEY,
      Accept: "application/json"
    }
  });

  const text = await response.text();

  console.log("STATUS:", response.status);

  try {
    const data = JSON.parse(text);

    console.log(
      JSON.stringify(data, null, 2).slice(0, 8000)
    );
  } catch {
    console.log(text.slice(0, 3000));
  }
}

(async () => {
  await test("/v0/locations");
  await test("/v0/inventory?max=5");
})();
