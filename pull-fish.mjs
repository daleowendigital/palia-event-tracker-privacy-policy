#!/usr/bin/env node
/**
 * pull-fish.mjs (Upgraded)
 * Pull fish pages from palia.wiki.gg via MediaWiki Action API and extract infobox fields
 * in an event-friendly JSON format.
 *
 * Node 18+ (you’re on v24 so you’re annoyingly fine).
 */

import fs from "node:fs/promises";
import path from "node:path";

const BASE = "https://palia.wiki.gg";
const API = `${BASE}/api.php`;
const CATEGORY = "Category:Fish";

const OUT_FILE = path.resolve(process.cwd(), "fish.json");

// Wiki.gg rate-limits aggressively if you hammer it. Keep this conservative.
const CONCURRENCY = 2;
const DELAY_MS = 350; // baseline throttle between requests

// Tip: set a real contact (email or repo) before running this a lot.
const USER_AGENT = "PaliaEventTrackerBot/1.2 (contact: you@example.com)";

// ------------ utils ------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, { tries = 6, baseDelayMs = 800, maxDelayMs = 15000 } = {}) {
  let attempt = 0;
  // Exponential backoff + small jitter. Retries on 429 and transient failures.
  while (true) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      if (attempt >= tries) throw e;

      const msg = String(e?.message || e);
      const is429 = /\b429\b/.test(msg) || /too many requests/i.test(msg);

      // Backoff harder on 429, otherwise still back off a bit.
      const mult = is429 ? 1.5 : 1.0;
      const exp = Math.min(maxDelayMs, Math.floor(baseDelayMs * Math.pow(2, attempt - 1) * mult));
      const jitter = Math.floor(Math.random() * 250);
      const wait = Math.min(maxDelayMs, exp + jitter);

      console.warn(`Retry ${attempt}/${tries - 1} in ${wait}ms${is429 ? " (429)" : ""}`);
      await sleep(wait);
    }
  }
}

function decodeEntities(s) {
  if (!s) return "";
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(html) {
  if (!html) return "";
  // Remove scripts/styles
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  // Replace <br> and </p> with newlines, keep some structure
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n");
  // Remove tags
  s = s.replace(/<\/?[^>]+>/g, "");
  // Decode entities
  s = decodeEntities(s);
  // Normalize whitespace
  s = s.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

function normKey(k) {
  return (k || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function splitList(val) {
  if (!val) return [];
  // Values often come as "Kilima Valley Bahari Bay The Underground" (with line breaks)
  // or comma separated. We'll split on newlines first, then commas, then "  " runs.
  const raw = val
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)
    .flatMap((line) => line.split(",").map((x) => x.trim()))
    .filter(Boolean);

  // De-dupe
  return Array.from(new Set(raw));
}

function pickFirstParagraph(html) {
  if (!html) return "";
  // Grab <p> blocks and choose the first meaningful one
  const ps = Array.from(html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)).map((m) => stripTags(m[0]));
  for (const p of ps) {
    const cleaned = p.replace(/\[[^\]]*\]/g, "").trim(); // remove citation brackets
    if (cleaned.length >= 60) return cleaned;
  }
  return ps[0] || "";
}

// Extract portable infobox label/value pairs (wiki.gg commonly uses PortableInfobox)
function extractPortableInfoboxPairs(html) {
  const pairs = new Map();

  if (!html || !html.includes("portable-infobox")) return pairs;

  // Try to isolate the portable infobox block
  const asideMatch = html.match(/<aside\b[^>]*class="[^"]*portable-infobox[^"]*"[\s\S]*?<\/aside>/i);
  const block = asideMatch ? asideMatch[0] : html;

  // Label/value blocks often look like:
  // <h3 class="pi-data-label">Rarity</h3> ... <div class="pi-data-value">Common</div>
  const re = /<h3\b[^>]*class="[^"]*\bpi-data-label\b[^"]*"[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<div\b[^>]*class="[^"]*\bpi-data-value\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;

  for (const m of block.matchAll(re)) {
    const label = stripTags(m[1]);
    const value = stripTags(m[2]);
    if (label && value) pairs.set(normKey(label), value);
  }

  return pairs;
}

// Fallback: extract infobox table rows <th>Label</th><td>Value</td>
function extractTableInfoboxPairs(html) {
  const pairs = new Map();
  if (!html) return pairs;

  const tableMatch = html.match(/<table\b[^>]*class="[^"]*infobox[^"]*"[\s\S]*?<\/table>/i);
  if (!tableMatch) return pairs;

  const table = tableMatch[0];
  const rowRe = /<tr\b[^>]*>[\s\S]*?<\/tr>/gi;

  for (const row of table.match(rowRe) || []) {
    const th = row.match(/<th\b[^>]*>([\s\S]*?)<\/th>/i);
    const td = row.match(/<td\b[^>]*>([\s\S]*?)<\/td>/i);
    if (!th || !td) continue;

    const label = stripTags(th[1]);
    const value = stripTags(td[1]);
    if (label && value) pairs.set(normKey(label), value);
  }

  return pairs;
}

function extractValueGold(textBlock) {
  // Try to find "50 Gold" / "75 Gold" patterns
  const nums = Array.from(textBlock.matchAll(/(\d+)\s*gold/gi)).map((m) => Number(m[1]));
  // Typical order: Basic then Quality. If only one number, store as basic.
  return {
    basic: Number.isFinite(nums[0]) ? nums[0] : null,
    quality: Number.isFinite(nums[1]) ? nums[1] : null,
  };
}

function slugifyTitle(title) {
  return (title || "")
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ------------ API ------------
async function apiGet(params) {
  const url = new URL(API);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json",
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const retryAfter = res.headers.get("retry-after");
    // Preserve status in the message so withRetry can detect 429 reliably.
    // Include Retry-After when present (wiki.gg sometimes sends it).
    throw new Error(
      `API ${res.status} ${res.statusText}${retryAfter ? ` (retry-after: ${retryAfter})` : ""} for ${url}\n${txt.slice(0, 400)}`
    );
  }

  const json = await res.json();
  if (json?.error) throw new Error(`API error: ${json.error.code} - ${json.error.info}`);
  return json;
}

async function getAllCategoryMembers() {
  const titles = [];
  let cmcontinue = undefined;

  while (true) {
    const data = await apiGet({
      action: "query",
      format: "json",
      formatversion: 2,
      list: "categorymembers",
      cmtitle: CATEGORY,
      cmlimit: 500,
      cmtype: "page",
      ...(cmcontinue ? { cmcontinue } : {}),
    });

    const members = data?.query?.categorymembers ?? [];
    for (const m of members) {
      if (m?.title && !m.title.startsWith("Category:")) titles.push(m.title);
    }

    cmcontinue = data?.continue?.cmcontinue;
    if (!cmcontinue) break;

    await sleep(DELAY_MS);
  }

  return titles;
}

async function fetchParseHtml(title) {
  // Parse returns rendered HTML in `text`, which includes the infobox.
  const data = await apiGet({
    action: "parse",
    format: "json",
    formatversion: 2,
    page: title,
    prop: "text|wikitext",
    redirects: 1,
  });

  const parse = data?.parse;
  const html = parse?.text ?? "";
  const wikitext = parse?.wikitext ?? "";
  const pageid = parse?.pageid ?? null;
  const titleOut = parse?.title ?? title;

  return { title: titleOut, pageid, html, wikitext };
}

async function fetchPageUrlAndRevid(title) {
  const data = await apiGet({
    action: "query",
    format: "json",
    formatversion: 2,
    prop: "info",
    inprop: "url",
    titles: title,
    redirects: 1,
  });

  const page = data?.query?.pages?.[0];
  if (!page || page.missing) return { url: `${BASE}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`, lastrevid: null };
  return { url: page.fullurl, lastrevid: page.lastrevid ?? null };
}

function extractInfoboxFields(html) {
  // PortableInfobox first, then table infobox fallback
  const pairs = extractPortableInfoboxPairs(html);
  if (pairs.size === 0) {
    const tablePairs = extractTableInfoboxPairs(html);
    for (const [k, v] of tablePairs.entries()) pairs.set(k, v);
  }

  // Pull likely keys
  const rarity = pairs.get("rarity") || "";
  const appears = pairs.get("appears") || pairs.get("appears at") || "";
  const locationRaw = pairs.get("location") || "";
  const biomeRaw = pairs.get("biome") || "";
  const baitRaw = pairs.get("best bait") || pairs.get("bait") || "";

  // Value: sometimes exists as a visible section but not as a label/value pair.
  // We attempt to find a "Value" area in the infobox html if present.
  let value = { basic: null, quality: null };

  // Try: look for a "Value" header-ish chunk around it
  const valueChunkMatch =
    html.match(/>Value<[\s\S]{0,2000}?<\/(section|div|table)>/i) ||
    html.match(/>Value<[\s\S]{0,2000}?(Gold)/i);

  if (valueChunkMatch) value = extractValueGold(stripTags(valueChunkMatch[0]));

  return {
    rarity: rarity.trim() || null,
    appears: appears.trim() || null,
    locations: splitList(locationRaw),
    biomes: splitList(biomeRaw),
    bestBait: splitList(baitRaw),
    value,
  };
}

async function runPool(items, worker, concurrency) {
  const results = [];
  let idx = 0;

  async function runner() {
    while (idx < items.length) {
      const my = idx++;
      const item = items[my];
      const res = await worker(item, my);
      results[my] = res;
      await sleep(DELAY_MS);
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => runner());
  await Promise.all(workers);
  return results;
}

// ------------ Main ------------
(async () => {
  console.log(`Fetching category members for: ${CATEGORY}`);
  const titles = await getAllCategoryMembers();
  console.log(`Found ${titles.length} fish pages`);

  const fetchedAt = new Date().toISOString();

  const records = await runPool(
    titles,
    async (title) => {
      try {
        const [{ title: fixedTitle, pageid, html }, { url, lastrevid }] = await Promise.all([
          withRetry(() => fetchParseHtml(title)),
          withRetry(() => fetchPageUrlAndRevid(title)),
        ]);

        const infobox = extractInfoboxFields(html);
        const description = pickFirstParagraph(html);

        return {
          id: slugifyTitle(fixedTitle),
          title: fixedTitle,
          pageid,
          lastrevid,
          url,
          description: description || null,

          // Event-ready fields
          rarity: infobox.rarity,
          appears: infobox.appears,
          locations: infobox.locations,
          biomes: infobox.biomes,
          bestBait: infobox.bestBait,
          value: infobox.value,

          source: {
            wiki: "palia.wiki.gg",
            fetchedAt,
          },
        };
      } catch (e) {
        // If a page still fails after retries, skip it.
        // We keep counts in meta so you know something was skipped.
        return {
          _skipped: true,
          id: slugifyTitle(title),
          title,
          error: String(e?.message || e),
        };
      }
    },
    CONCURRENCY
  );

  const ok = records.filter((r) => r && !r._skipped);
  const failed = records.filter((r) => r && r._skipped);

  const out = {
    meta: {
      category: CATEGORY,
      count: titles.length,
      ok: ok.length,
      failed: failed.length,
      fetchedAt,
      base: BASE,
      api: API,
      // Helpful for debugging without polluting the fish list.
      skippedTitles: failed.slice(0, 200).map((r) => r?.title).filter(Boolean),
    },
    // Only ship usable fish records.
    fish: ok,
  };

  await fs.writeFile(OUT_FILE, JSON.stringify(out, null, 2), "utf-8");
  console.log(`Wrote ${OUT_FILE}`);
  console.log(`OK: ${ok.length}  Failed: ${failed.length}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
