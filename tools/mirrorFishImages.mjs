import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const INPUT_JSON = path.join(ROOT, "fish.json");

const DOCS_DIR = path.join(ROOT, "docs");
const OUT_IMAGES_DIR = path.join(DOCS_DIR, "fish-images");
const OUT_JSON = path.join(DOCS_DIR, "fish.json");

// No trailing slash
const PAGES_BASE_URL =
  process.env.PAGES_BASE_URL || "https://daleowendigital.github.io/palia-event-tracker-privacy-policy";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getArrayFromFishJson(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.fish)) return raw.fish;
  if (raw && Array.isArray(raw.items)) return raw.items;
  if (raw && Array.isArray(raw.data)) return raw.data;
  // fallback if it's an object keyed by id
  if (raw && typeof raw === "object") {
    const vals = Object.values(raw);
    if (vals.length && typeof vals[0] === "object") return vals;
  }
  return [];
}

function filenameFromUrl(u) {
  const last = (u.split("/").pop() || "image.png").split("?")[0];
  return last.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

async function fetchWithBackoff(url, opts = {}) {
  const {
    tries = 6,
    timeoutMs = 12000,
    maxTotalMs = 60000, // don't let one URL stall the entire run
  } = opts;

  const started = Date.now();
  let lastErr;

  for (let i = 0; i < tries; i++) {
    if (Date.now() - started > maxTotalMs) {
      throw new Error(`Gave up (maxTotalMs) for ${url}`);
    }

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          // Some hosts rate-limit "unknown" clients harder. This helps.
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
      });
      clearTimeout(t);

      if (res.status === 429) {
        const wait = Math.min(15000, 800 * 2 ** i) + Math.floor(Math.random() * 600);
        console.log(`[mirror] 429 for ${url} (try ${i + 1}/${tries}) waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;

      const wait = Math.min(12000, 700 * 2 ** i) + Math.floor(Math.random() * 600);
      console.log(`[mirror] fetch fail for ${url} (try ${i + 1}/${tries}) waiting ${wait}ms: ${String(e?.message || e)}`);
      await sleep(wait);
    }
  }

  throw lastErr || new Error(`Failed to fetch ${url}`);
}

async function main() {
  if (!fs.existsSync(INPUT_JSON)) throw new Error(`Missing ${INPUT_JSON}`);

  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.mkdirSync(OUT_IMAGES_DIR, { recursive: true });

  const raw = JSON.parse(fs.readFileSync(INPUT_JSON, "utf8"));
  const fish = getArrayFromFishJson(raw);
  if (!fish.length) throw new Error("fish.json had no fish array");

  // Keep it polite
  const CONCURRENCY = 1;

  let cursor = 0;
  let downloaded = 0;
  let skipped = 0;
  let rewritten = 0;
  const failed = [];

  async function worker() {
    while (cursor < fish.length) {
      const idx = cursor++;
      const f = fish[idx];

      try {
        const src = f?.imageUrl;
        if (!src || typeof src !== "string") continue;

        console.log(`[mirror] try ${idx + 1}/${fish.length} id=${String(f?.id)} src=${src}`);

        const file = filenameFromUrl(src);
        const outPath = path.join(OUT_IMAGES_DIR, file);

        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) {
          skipped++;
        } else {
          const res = await fetchWithBackoff(src);
          const buf = Buffer.from(await res.arrayBuffer());
          fs.writeFileSync(outPath, buf);
          downloaded++;
          await sleep(200);
        }

        f.imageUrl = `${PAGES_BASE_URL}/fish-images/${encodeURIComponent(file)}`;
        rewritten++;
      } catch (e) {
        failed.push({ id: f?.id, url: f?.imageUrl, err: String(e?.message || e) });
        await sleep(200);
      }
    }
  }

  const startedAt = Date.now();
  const progressTimer = setInterval(() => {
    const done = cursor;
    const pct = ((done / fish.length) * 100).toFixed(1);
    const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
    console.log(
      `[mirror] progress ${done}/${fish.length} (${pct}%) elapsed=${mins}m downloaded=${downloaded} skipped=${skipped} rewritten=${rewritten} failed=${failed.length}`,
    );
  }, 5000);

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  } finally {
    clearInterval(progressTimer);

    // ALWAYS write docs/fish.json even if some downloads fail
    try {
      console.log("[mirror] about to write docs/fish.json");
      fs.writeFileSync(OUT_JSON, JSON.stringify(fish, null, 2) + "\n", "utf8");
      console.log("[mirror] finished writing docs/fish.json");
    } catch (e) {
      console.log("[mirror] FAILED to write docs/fish.json:", String(e?.message || e));
    }
  }

  console.log(`[mirror] fish=${fish.length}`);
  console.log(`[mirror] downloaded=${downloaded} skipped=${skipped} rewritten=${rewritten}`);
  if (failed.length) {
    console.log(`[mirror] failed=${failed.length} (showing first 25)`);
    console.log(failed.slice(0, 25));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
