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
const CONCURRENCY = 1;

// Tip: set a real contact (email or repo) before running this a lot.
const USER_AGENT = "PaliaEventTrackerBot/1.2 (contact: https://daleowendigital.github.io/palia-event-tracker-privacy-policy/)";

// Entries that are known to be junk / not real fish pages in the upstream category listing.
const DROP_FISH_IDS = new Set([
  "bass",
  "catfish",
  "trout",
]);


// ------------ utils ------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One shared queue includes retries, so no worker can send during another's cooldown.
// Budgets cover the Wiki phase: 6 attempts/request, 1s between requests, 120s max
// server delay, 10 minutes total sleeping and 20 minutes elapsed, 20s/request.
function createWikiRequester({ fetchImpl = fetch, now = Date.now, pause = sleep, random = Math.random, warn = console.warn } = {}) {
  const deadline = now() + 20 * 60 * 1000;
  let queue = Promise.resolve(), nextAllowed = 0, slept = 0, fatalError;
  const fatal = message => {
    fatalError = new Error(message);
    return fatalError;
  };
  const waitForGate = async () => {
    if (fatalError) throw fatalError;
    const wait = Math.max(0, nextAllowed - now());
    if (slept + wait > 10 * 60 * 1000 || now() + wait >= deadline) throw fatal('Wiki pacing execution budget exceeded');
    slept += wait;
    if (wait) await pause(wait);
    if (now() >= deadline) throw fatal('Wiki elapsed execution budget exceeded');
  };
  const retryAfterMs = header => {
    if (typeof header !== 'string' || !header.trim()) return null;
    const value = header.trim();
    if (/^\d+$/.test(value)) return Number(value) * 1000;
    // HTTP-date supports IMF-fixdate and the two legacy HTTP date forms.
    if (!/^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?[, ]|Tuesday,|Wednesday,|Thursday,|Saturday,)/i.test(value)) return null;
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - now()) : null;
  };
  const request = async url => {
    for (let attempt = 0; attempt < 6; attempt++) {
      await waitForGate();
      let error, serverDelay = null;
      try {
        const response = await fetchImpl(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          signal: AbortSignal.timeout(Math.max(1, Math.min(20000, deadline - now()))),
        });
        if (!response.ok) {
          const header = response.headers.get('retry-after');
          if (response.status === 429) serverDelay = retryAfterMs(header);
          const body = await response.text().catch(() => '');
          throw new Error(`API ${response.status} ${response.statusText}${header ? ` (retry-after: ${header})` : ''} for ${url}\n${body.slice(0, 400)}`);
        }
        const json = await response.json();
        if (json?.error) throw new Error(`API error for ${url}: ${json.error.code} - ${json.error.info}`);
        nextAllowed = now() + 1000;
        return json;
      } catch (caught) { error = caught; }
      if (serverDelay !== null && (!Number.isFinite(serverDelay) || serverDelay > 120000)) {
        throw fatal(`${error.message}\nRetry-After exceeds the 120-second server-delay budget`);
      }
      const fallback = Math.min(15000, 800 * 2 ** attempt + Math.floor(random() * 250));
      const delay = serverDelay ?? fallback;
      nextAllowed = now() + Math.max(1000, delay);
      if (attempt === 5) throw error;
      warn(`Wiki retry ${attempt + 1}/5 in ${Math.max(1000, delay)}ms: ${error.message}`);
    }
  };
  return url => {
    const result = queue.then(() => request(url));
    queue = result.catch(() => {});
    return result;
  };
}

const requestWiki = createWikiRequester();

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

  return requestWiki(url);
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

    const members = data?.query?.categorymembers;
    if (!Array.isArray(members)) throw new Error("Malformed category response: categorymembers missing");
    for (const m of members) {
      if (typeof m?.title !== "string" || !m.title.trim()) throw new Error("Malformed category member");
      if (!m.title.startsWith("Category:")) titles.push(m.title);
    }

    cmcontinue = data?.continue?.cmcontinue;
    if (!cmcontinue) break;

  }

  if (!titles.length) throw new Error("Empty Fish category; refusing generation");
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
  if (!parse || typeof parse.text !== "string" || !parse.text.trim()) {
    throw new Error(`Missing parsed Wiki content for ${title}`);
  }
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
  if (!page || page.missing || typeof page.fullurl !== "string") throw new Error(`Missing Wiki page info for ${title}`);
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
      let operation = 'parse';
      try {
        const { title: fixedTitle, pageid, html } = await fetchParseHtml(title);
        operation = 'page information';
        const { url, lastrevid } = await fetchPageUrlAndRevid(title);

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
        const failure = { id: slugifyTitle(title), title, operation, reason: String(e?.message || e) };
        console.error(JSON.stringify({ failedWikiRequests: [failure] }, null, 2));
        throw new Error(`Incomplete Fish generation: ${failure.id} (${title}), ${operation} failed: ${failure.reason}; catalogue not replaced`);
      }
    },
    CONCURRENCY
  );

  const ok = records.filter((r) => r && !r._skipped);
  const failed = records.filter((r) => r && r._skipped);
  if (failed.length) {
    const failures = failed.map(({ id, title, error }) => ({ id, title, reason: error }));
    console.error(JSON.stringify({ failedWikiRequests: failures }, null, 2));
    throw new Error(`Incomplete Fish generation: ${failed.length} Wiki requests failed; catalogue not replaced`);
  }

  // Filter out known junk entries so they don't reappear on the next update.
  const dropped = ok
    .filter((r) => DROP_FISH_IDS.has(String(r.id || "").toLowerCase()))
    .map((r) => r.id);

  const okClean = ok.filter((r) => !DROP_FISH_IDS.has(String(r.id || "").toLowerCase()));
  if (!okClean.length) throw new Error("No usable Fish; catalogue not replaced");

  const out = {
    meta: {
      category: CATEGORY,
      count: titles.length,
      ok: okClean.length,
      failed: failed.length,
      dropped: dropped,
      fetchedAt,
      base: BASE,
      api: API,
      // Helpful for debugging without polluting the fish list.
      skippedTitles: failed.slice(0, 200).map((r) => r?.title).filter(Boolean),
    },
    // Only ship usable fish records.
    fish: okClean,
  };

  await fs.writeFile(OUT_FILE, JSON.stringify(out, null, 2), "utf-8");
  console.log(`Wrote ${OUT_FILE}`);
  console.log(`OK: ${ok.length}  Failed: ${failed.length}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
