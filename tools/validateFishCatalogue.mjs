import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

const periods = { morning: [180, 360], day: [360, 1080], evening: [1080, 1260], night: [1260, 180] };
const coverage = ranges => Array.from({ length: 1440 }, (_, m) => ranges.some(([a, b]) => a < b ? m >= a && m < b : m >= a || m < b));

// Validate the existing period representation; do not infer schedules from descriptions.
export function scheduleKind(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) return 'unknown';
  if (typeof value !== 'string') throw new Error('schedule must be text or null');
  const label = value.trim().toLowerCase();
  if (/^(any time|all day)$/.test(label)) return 'any-time';
  const ranges = [];
  const words = label.replace(/\(([^()]*)\)/g, (_, range) => {
    const match = range.match(/^(\d{1,2}):(\d{2})\s*(am|pm)\s*-\s*(\d{1,2}):(\d{2})\s*(am|pm)$/);
    if (!match) throw new Error(`invalid time range: ${range}`);
    const hm = (h, m, meridian) => {
      if (+h < 1 || +h > 12 || +m > 59) throw new Error(`invalid time endpoint: ${range}`);
      return (+h % 12 + (meridian === 'pm' ? 12 : 0)) * 60 + +m;
    };
    const start = hm(match[1], match[2], match[3]), end = hm(match[4], match[5], match[6]);
    if (start === end) throw new Error('empty/ambiguous time range');
    ranges.push([start, end]);
    return ' ';
  });
  const tokens = words.replace(/[,/]/g, ' ').split(/\s+/).filter(Boolean).filter(w => w !== 'and');
  if (!tokens.length || tokens.some(w => !Object.hasOwn(periods, w))) throw new Error(`unrecognised schedule: ${value}`);
  if (ranges.length && !isDeepStrictEqual(coverage(tokens.map(w => periods[w])), coverage(ranges))) {
    throw new Error(`period/time contradiction: ${value}`);
  }
  return new Set(tokens).size === 4 ? 'any-time' : 'timed';
}

function entries(catalogue, label, errors, candidate = false) {
  const map = new Map(), identities = new Map(), pages = new Map();
  if (!catalogue || !Array.isArray(catalogue.fish) || !catalogue.fish.length) {
    errors.push(`${label}: expected nonempty { fish: [...] }`);
    return map;
  }
  if (candidate) {
    const meta = catalogue.meta;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      errors.push(`${label}: missing/malformed completeness metadata`);
    } else {
      const countsValid = ['count', 'ok', 'failed'].every(key => Number.isSafeInteger(meta[key]) && meta[key] >= 0);
      const droppedValid = Array.isArray(meta.dropped) && meta.dropped.every(id => typeof id === 'string' && id.trim()) &&
        new Set(meta.dropped).size === meta.dropped.length;
      const skippedValid = Array.isArray(meta.skippedTitles) && meta.skippedTitles.every(title => typeof title === 'string' && title.trim());
      if (!countsValid || !droppedValid || !skippedValid) errors.push(`${label}: malformed completeness counts/lists`);
      if (meta.failed !== 0 || !skippedValid || meta.skippedTitles.length) errors.push(`${label}: failed Wiki retrievals`);
      if (meta.ok !== catalogue.fish.length) errors.push(`${label}: meta.ok does not match entry count`);
      // Generator count includes dropped category pages; ok excludes them.
      if (countsValid && droppedValid && meta.count !== meta.ok + meta.failed + meta.dropped.length) {
        errors.push(`${label}: category count must equal usable Fish + failed requests + dropped entries`);
      }
      if (droppedValid && meta.dropped.some(id => catalogue.fish.some(fish => fish?.id === id))) {
        errors.push(`${label}: dropped ID is still present in Fish array`);
      }
    }
  }
  for (const fish of catalogue.fish) {
    if (!fish || typeof fish.id !== 'string' || !fish.id.trim() || typeof fish.title !== 'string' || !fish.title.trim()) {
      errors.push(`${label}: blank/missing Fish ID or title`);
      continue;
    }
    if (fish.id !== fish.id.trim() || map.has(fish.id)) errors.push(`${label}: duplicate/noncanonical ID ${fish.id}`);
    const identity = fish.title.trim().toLowerCase();
    if (identities.has(identity) && identities.get(identity) !== fish.id) errors.push(`${label}: conflicting title ${fish.title}`);
    if (fish.pageid != null && pages.has(fish.pageid) && pages.get(fish.pageid) !== fish.id) errors.push(`${label}: conflicting page identity ${fish.pageid}`);
    identities.set(identity, fish.id); pages.set(fish.pageid, fish.id); map.set(fish.id, fish);
    if (candidate) {
      if (fish.value != null) {
        const value = fish.value;
        if (typeof value !== 'object' || Array.isArray(value) || !['basic', 'quality'].every(key =>
          Object.hasOwn(value, key) && (value[key] === null || (typeof value[key] === 'number' && Number.isFinite(value[key]))))) {
          errors.push(`${label}: ${fish.id}.value must contain numeric or null basic/quality values`);
        }
      }
      for (const field of ['locations', 'biomes', 'bestBait']) {
        if (fish[field] != null && (!Array.isArray(fish[field]) || fish[field].some(v => typeof v !== 'string'))) {
          errors.push(`${label}: ${fish.id}.${field} must be a string array`);
        }
      }
      for (const field of ['description', 'rarity', 'url', 'imageUrl']) {
        if (fish[field] != null && typeof fish[field] !== 'string') errors.push(`${label}: ${fish.id}.${field} must be text`);
      }
      try { scheduleKind(fish.appears); } catch (error) { errors.push(`${label}: ${fish.id}: ${error.message}`); }
    }
  }
  return map;
}

export function baselineReport(root, published) {
  const errors = [], a = entries(root, 'root baseline', errors), b = entries(published, 'published baseline', errors);
  const changed = [];
  for (const [id, fish] of a) {
    if (!b.has(id)) continue;
    const fields = [...new Set([...Object.keys(fish), ...Object.keys(b.get(id))])]
      .filter(key => !isDeepStrictEqual(fish[key], b.get(id)[key]));
    if (fields.length) changed.push({ id, fields });
  }
  return {
    errors, rootOnly: [...a.keys()].filter(id => !b.has(id)), publicOnly: [...b.keys()].filter(id => !a.has(id)),
    unknownSchedules: [...a.values()].filter(f => scheduleKind(f.appears) === 'unknown').map(f => f.id),
    differences: changed,
  };
}

export function validateCatalogues(root, publicCatalogue, baselines) {
  const errors = [], a = entries(root, 'candidate root', errors, true), b = entries(publicCatalogue, 'candidate public', errors, true);
  for (const [id, fish] of a) {
    const other = b.get(id);
    if (!other) { errors.push(`public catalogue missing ${id}`); continue; }
    for (const key of new Set([...Object.keys(fish), ...Object.keys(other)])) {
      if (key !== 'imageUrl' && !isDeepStrictEqual(fish[key], other[key])) errors.push(`root/public mismatch: ${id}.${key}`);
    }
  }
  for (const id of b.keys()) if (!a.has(id)) errors.push(`public catalogue has extra ${id}`);
  for (const [index, baseline] of baselines.entries()) {
    const previous = entries(baseline, `baseline ${index + 1}`, errors);
    for (const [id, old] of previous) {
      const fish = a.get(id);
      if (!fish) { errors.push(`unexpected removal from baseline ${index + 1}: ${id}`); continue; }
      if (old.title !== fish.title) errors.push(`identity/name change requires review: ${id}`);
      if (Number.isSafeInteger(old.pageid) && old.pageid > 0 && old.pageid !== fish.pageid) {
        errors.push(`Wiki page identity change requires review: ${id} (${old.pageid} -> ${fish.pageid})`);
      }
      try {
        if (scheduleKind(old.appears) !== 'unknown' && scheduleKind(fish.appears) === 'unknown') errors.push(`lost known schedule: ${id}`);
      } catch (error) { errors.push(`${id}: ${error.message}`); }
    }
  }
  return { valid: !errors.length, errors, count: a.size, unknownSchedules: [...a.values()].filter(f => f.appears == null || String(f.appears).trim() === '').map(f => f.id) };
}

export function validateFiles(root, publicFile, baselineRoot, baselinePublic) {
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  return validateCatalogues(read(root), read(publicFile), [read(baselineRoot), read(baselinePublic)]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === '--compare-baselines') {
      if (process.argv.length !== 5) throw new Error('Usage: node validateFishCatalogue.mjs --compare-baselines ROOT PUBLIC');
      const report = baselineReport(...process.argv.slice(3).map(file => JSON.parse(fs.readFileSync(file, 'utf8'))));
      console.log(JSON.stringify(report, null, 2));
      if (report.errors.length) process.exitCode = 1;
    } else {
      if (process.argv.length !== 6) throw new Error('Usage: node validateFishCatalogue.mjs ROOT PUBLIC BASELINE_ROOT BASELINE_PUBLIC');
      const result = validateFiles(...process.argv.slice(2));
      console.log(JSON.stringify(result, null, 2));
      if (!result.valid) process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
