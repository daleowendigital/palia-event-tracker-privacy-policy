/**
 * tools/enrichFishImages.mjs
 *
 * Enriches fish.json by adding imageUrl for each fish WITHOUT calling the wiki API.
 * wiki.gg is rate-limiting GitHub Actions (HTTP 429), so we generate a stable MediaWiki
 * redirect URL using Special:Filepath (alias of Special:Redirect/file).
 *
 * Example:
 *  Albino Eel -> https://palia.wiki.gg/wiki/Special:Filepath/Albino_Eel.png
 *
 * Notes:
 * - We assume fish images are named "<Title>.png" on the wiki (matches the fish list).
 * - If a few fish have non-standard filenames, they’ll just show placeholder in-app
 *   until you override them manually later.
 */

import fs from "node:fs/promises";

const FISH_JSON_PATH = "fish.json";

// MediaWiki file redirect (works externally) :contentReference[oaicite:2]{index=2}
const FILEPATH_BASE = "https://palia.wiki.gg/wiki/Special:Filepath/";

function extractFishArrays(data) {
  // Supports:
  // 1) fish.json = [ {...}, {...} ]
  // 2) fish.json = { fish: [ {...} ], otherGroup: [ {...} ] }
  if (Array.isArray(data)) return [data];

  if (data && typeof data === "object") {
    return Object.values(data).filter(Array.isArray);
  }

  return [];
}

function titleToFileNamePng(title) {
  // "Albino Eel" -> "Albino_Eel.png"
  const safe = String(title || "").trim().replace(/\s+/g, "_");
  if (!safe) return null;
  return `${safe}.png`;
}

function buildFilepathUrl(fileName) {
  // Encode but keep slashes intact (there are none here anyway)
  return FILEPATH_BASE + encodeURIComponent(fileName);
}

function sanitizeFilepathUrl(url) {
  const s = String(url || "").trim();
  if (!s) return null;

  // If it looks like a Special:Filepath URL, re-encode the filename portion.
  const idx = s.indexOf("Special:Filepath/");
  if (idx !== -1) {
    const head = s.slice(0, idx + "Special:Filepath/".length);
    const tail = s.slice(idx + "Special:Filepath/".length);
    if (!tail) return s;
    return head + encodeURIComponent(decodeURIComponentSafe(tail));
  }

  // Generic fallback: encodeURI then patch apostrophes.
  return encodeURI(s).replace(/'/g, "%27");
}

function decodeURIComponentSafe(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}


async function main() {
  const raw = await fs.readFile(FISH_JSON_PATH, "utf8");
  const data = JSON.parse(raw);

  const fishArrays = extractFishArrays(data);
  if (fishArrays.length === 0) {
    throw new Error("No fish arrays found in fish.json");
  }

  let added = 0;

  for (const fishArr of fishArrays) {
    for (const f of fishArr) {
      if (!f || typeof f !== "object") continue;

      // Normalize existing imageUrl, but do not remove it.
      if (f.imageUrl) {
        const norm = sanitizeFilepathUrl(f.imageUrl);
        if (norm && norm !== f.imageUrl) {
          f.imageUrl = norm;
          added++;
        }
        continue;
      }

      // Your schema uses "title" (not "name")
      const title = f.title || f.name;
      const fileName = titleToFileNamePng(title);
      if (!fileName) continue;

      f.imageUrl = sanitizeFilepathUrl(buildFilepathUrl(fileName));
      added++;
    }
  }

  if (added > 0) {
    await fs.writeFile(FISH_JSON_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
  }

  console.log(`Image enrichment done. Added: ${added}. Changed file: ${added > 0 ? "YES" : "NO"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
