/**
 * tools/enrichFishImages.mjs
 *
 * Enriches fish.json by adding imageUrl for each fish using the Official Palia Wiki (wiki.gg) MediaWiki API.
 * - Keeps existing imageUrl if already present
 * - Only fetches for missing imageUrl
 * - Does not fail the whole run if one fish lookup fails
 *
 * Node 18+ required (GitHub Actions Node 20 is fine).
 */

import fs from "node:fs/promises";

const FISH_JSON_PATH = "fish.json";

// Official Palia Wiki (wiki.gg) Action API endpoint
const WIKI_API = "https://palia.wiki.gg/api.php";

// Be polite: tiny delay so we don’t look like a botnet.
const REQUEST_DELAY_MS = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanTitle(name) {
  // MediaWiki pages usually match the item name, but keep it simple and consistent.
  return String(name || "").trim();
}

async function fetchPageImageUrl(title) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    titles: title,
    redirects: "1",
    prop: "pageimages",
    piprop: "original", // prefer original image if available
    pithumbsize: "256", // fallback if original isn't available (some wikis still return thumb)
    pilicense: "any",
    origin: "*",
  });

  const url = `${WIKI_API}?${params.toString()}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "palia-event-tracker-bot/1.0 (GitHub Actions; image enrichment)",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for title "${title}"`);
  }

  const json = await res.json();

  const pages = json?.query?.pages;
  if (!pages) return null;

  const firstKey = Object.keys(pages)[0];
  const page = pages[firstKey];

  // pageimages can return "original" or "thumbnail" depending on config/availability
  const original = page?.original?.source ?? null;
  const thumb = page?.thumbnail?.source ?? null;

  // Prefer original if available, otherwise thumb.
  return original || thumb || null;
}

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

  for (const fishArr of fishArrays) {
    for (let i = 0; i < fishArr.length; i++) {
      const f = fishArr[i];
      if (!f || typeof f !== "object") continue;

      if (f.imageUrl) continue; // keep existing

      const title = cleanTitle(f.title || f.name);
      if (!title) continue;

      try {
        const img = await fetchPageImageUrl(title);
        if (img) {
          f.imageUrl = img;
          changed = true;
          found++;
        } else {
          missing++;
        }
      } catch (e) {
        // Don’t nuke the daily run because one page had a tantrum.
        missing++;
        console.warn(`[image] ${title}: ${e?.message || e}`);
      }

      await sleep(REQUEST_DELAY_MS);
    }
  }

  if (changed) {
    // IMPORTANT: write back the full original structure (array OR object), not just one array.
    await fs.writeFile(FISH_JSON_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
  }

  console.log(
    `Image enrichment done. Added: ${found}. No image / failed: ${missing}. Changed file: ${changed ? "YES" : "NO"}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
