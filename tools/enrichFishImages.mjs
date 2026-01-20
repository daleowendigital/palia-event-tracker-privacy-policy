/**
 * tools/enrichFishImages.mjs
 *
 * Enriches fish.json by adding imageUrl for each fish using the Official Palia Wiki (wiki.gg) MediaWiki API.
 * - Keeps existing imageUrl if already present
 * - Only fetches for missing imageUrl
 * - Uses pageid lookup (much less likely to get rate-limited than title search)
 * - Retries on HTTP 429 with backoff
 * - Does not fail the whole run if one fish lookup fails
 *
 * Node 18+ required (GitHub Actions Node 20 is fine).
 */

import fs from "node:fs/promises";

const FISH_JSON_PATH = "fish.json";

// Official Palia Wiki (wiki.gg) Action API endpoint
const WIKI_API = "https://palia.wiki.gg/api.php";

// Be polite: small delay between requests.
const REQUEST_DELAY_MS = 200;

// Retry/backoff for 429s
const RETRIES = 4;
const BACKOFF_MS = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractFishArrays(data) {
  // Supports:
  // 1) fish.json = [ {...}, {...} ]
  // 2) fish.json = { someGroup: [ {...} ], otherGroup: [ {...} ] }
  // 3) fish.json = { fish: [ {...} ], ... }
  if (Array.isArray(data)) return [data];

  if (data && typeof data === "object") {
    return Object.values(data).filter(Array.isArray);
  }

  return [];
}

async function fetchPageImageUrlByPageId(pageid, retriesLeft = RETRIES) {
  if (pageid === undefined || pageid === null || pageid === "") return null;

  const params = new URLSearchParams({
    action: "query",
    format: "json",
    pageids: String(pageid),
    prop: "pageimages",
    piprop: "original", // prefer original if available
    pithumbsize: "256", // fallback thumb if original isn't returned
    origin: "*",
  });

  const url = `${WIKI_API}?${params.toString()}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "palia-event-tracker-bot/1.0 (GitHub Actions; image enrichment)",
      Accept: "application/json",
    },
  });

  // Handle rate limiting with retry/backoff
  if (res.status === 429) {
    if (retriesLeft > 0) {
      await sleep(BACKOFF_MS);
      return fetchPageImageUrlByPageId(pageid, retriesLeft - 1);
    }
    throw new Error(`HTTP 429 (rate limited)`);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const json = await res.json();
  const pages = json?.query?.pages;
  if (!pages) return null;

  const firstKey = Object.keys(pages)[0];
  const page = pages[firstKey];

  return page?.original?.source ?? page?.thumbnail?.source ?? null;
}

async function main() {
  const raw = await fs.readFile(FISH_JSON_PATH, "utf8");
  const data = JSON.parse(raw);

  const fishArrays = extractFishArrays(data);
  if (fishArrays.length === 0) {
    throw new Error("No fish arrays found in fish.json");
  }

  let changed = false;
  let found = 0;
  let missing = 0;
  let failed = 0;

  for (const fishArr of fishArrays) {
    for (let i = 0; i < fishArr.length; i++) {
      const f = fishArr[i];
      if (!f || typeof f !== "object") continue;

      // keep existing
      if (f.imageUrl) continue;

      // Your schema includes pageid (and title). Use pageid for lookups.
      const pageid = f.pageid;

      try {
        const img = await fetchPageImageUrlByPageId(pageid);
        if (img) {
          f.imageUrl = img;
          changed = true;
          found++;
        } else {
          missing++;
        }
      } catch (e) {
        failed++;
        const label = f.title || f.name || f.id || String(pageid);
        console.warn(`[image] ${label}: ${e?.message || e}`);
      }

      await sleep(REQUEST_DELAY_MS);
    }
  }

  if (changed) {
    await fs.writeFile(FISH_JSON_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
  }

  console.log(
    `Image enrichment done. Added: ${found}. Missing: ${missing}. Failed: ${failed}. Changed file: ${
      changed ? "YES" : "NO"
    }`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
