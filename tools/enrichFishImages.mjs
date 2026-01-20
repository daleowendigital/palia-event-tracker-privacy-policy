/**
 * tools/enrichFishImages.mjs
 *
 * Batch-enriches fish.json with imageUrl using pageid lookups.
 * Designed to avoid wiki.gg rate limits by batching requests.
 *
 * Node 18+ required.
 */

import fs from "node:fs/promises";

const FISH_JSON_PATH = "fish.json";
const WIKI_API = "https://palia.wiki.gg/api.php";

// How many pageids per request (20–30 is safe)
const PAGEID_BATCH_SIZE = 20;
// Small delay between batches
const BATCH_DELAY_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractFishArrays(data) {
  if (Array.isArray(data)) return [data];
  if (data && typeof data === "object") {
    return Object.values(data).filter(Array.isArray);
  }
  return [];
}

async function fetchImagesForPageIds(pageids) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    pageids: pageids.join("|"),
    prop: "pageimages",
    piprop: "original",
    pithumbsize: "256",
    origin: "*",
  });

  const url = `${WIKI_API}?${params.toString()}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "palia-event-tracker-bot/1.0 (GitHub Actions; batch image enrichment)",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const json = await res.json();
  return json?.query?.pages ?? {};
}

async function main() {
  const raw = await fs.readFile(FISH_JSON_PATH, "utf8");
  const data = JSON.parse(raw);

  const fishArrays = extractFishArrays(data);
  if (fishArrays.length === 0) {
    throw new Error("No fish arrays found in fish.json");
  }

  // Flatten fish needing images
  const fishNeedingImages = [];
  for (const arr of fishArrays) {
    for (const f of arr) {
      if (!f?.imageUrl && f?.pageid) {
        fishNeedingImages.push(f);
      }
    }
  }

  if (fishNeedingImages.length === 0) {
    console.log("No fish missing images.");
    return;
  }

  let added = 0;

  // Process in batches
  for (let i = 0; i < fishNeedingImages.length; i += PAGEID_BATCH_SIZE) {
    const batch = fishNeedingImages.slice(i, i + PAGEID_BATCH_SIZE);
    const pageids = batch.map((f) => String(f.pageid));

    try {
      const pages = await fetchImagesForPageIds(pageids);

      for (const f of batch) {
        const page = pages[String(f.pageid)];
        const img =
          page?.original?.source ??
          page?.thumbnail?.source ??
          null;

        if (img) {
          f.imageUrl = img;
          added++;
        }
      }
    } catch (e) {
      console.warn(
        `[batch] Failed pageids: ${pageids.join(", ")} – ${e.message}`
      );
    }

    await sleep(BATCH_DELAY_MS);
  }

  if (added > 0) {
    await fs.writeFile(
      FISH_JSON_PATH,
      JSON.stringify(data, null, 2) + "\n",
      "utf8"
    );
  }

  console.log(
    `Image enrichment done. Added: ${added}. Changed file: ${added > 0 ? "YES" : "NO"}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
