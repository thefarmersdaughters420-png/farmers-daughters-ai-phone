const urls = [
  "https://weedmaps.com/api/web/v1/listings/the-farmers-daughters-dispensary/menu?show_unpublished=false&type=dispensary",
  "https://weedmaps.com/dispensaries/the-farmers-daughters-dispensary/flower"
];

async function test(url) {
  console.log("\nTESTING:");
  console.log(url);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142 Safari/537.36",

        Accept:
          "application/json,text/html;q=0.9,*/*;q=0.8",

        Referer:
          "https://weedmaps.com/"
      }
    });

    const text = await response.text();

    console.log("STATUS:", response.status);
    console.log("CONTENT TYPE:", response.headers.get("content-type"));
    console.log("SIZE:", text.length);

    try {
      const json = JSON.parse(text);

      console.log("JSON: YES");
      console.log("TOP LEVEL KEYS:", Object.keys(json));

      if (Array.isArray(json.categories)) {
        console.log(
          "CATEGORIES:",
          json.categories.map(c => ({
            title: c.title,
            items: Array.isArray(c.items) ? c.items.length : 0
          }))
        );

        const sample = [];

        for (const category of json.categories) {
          for (const item of category.items || []) {
            sample.push({
              category: category.title,
              name: item.name,
              prices: item.prices
            });

            if (sample.length >= 10) break;
          }

          if (sample.length >= 10) break;
        }

        console.log(
          "SAMPLE PRODUCTS:",
          JSON.stringify(sample, null, 2)
        );
      }
    } catch {
      console.log("JSON: NO");

      console.log(
        "HTML PREVIEW:",
        text.slice(0, 1000)
      );

      console.log(
        "CONTAINS THICC GIRL:",
        /thicc girl kush/i.test(text)
      );
    }
  } catch (error) {
    console.error("ERROR:", error.message);
  }
}

(async () => {
  for (const url of urls) {
    await test(url);
  }
})();
