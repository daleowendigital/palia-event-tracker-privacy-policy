// All generation runs use copied scripts, mocked HTTP and credential-free temp directories.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { baselineReport, validateCatalogues } from '../tools/validateFishCatalogue.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'palia-catalogue-safety-'));
let checks = 0;
const copy = value => JSON.parse(JSON.stringify(value));
const fish = (id = 'test_fish', appears = 'Morning (3:00 AM - 6:00 AM)') => ({ id, title: id === 'test_fish' ? 'Test Fish' : id, appears, pageid: id === 'test_fish' ? 1 : 2, description: 'Fixture Fish', imageUrl: 'https://palia.wiki.gg/Test_Fish.png' });
const catalogue = rows => ({ meta: { count: rows.length, ok: rows.length, failed: 0, dropped: [], skippedTitles: [] }, fish: rows });
const approved = catalogue([fish()]);
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); }
const mock = path.join(temp, 'mock.mjs');
write(mock, `
import fs from 'node:fs';
const mode = process.env.FISH_TEST_MODE;
const originalTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => originalTimeout(fn, 0, ...args);
if (mode === 'write-failure') {
  const write = fs.writeFileSync;
  fs.writeFileSync = (file, ...args) => {
    if (String(file).replaceAll('\\\\', '/').endsWith('/docs/fish.json')) throw new Error('Injected public write failure');
    return write(file, ...args);
  };
}
globalThis.fetch = async input => {
  const url = new URL(input);
  if (url.hostname.endsWith('github.io')) return { ok: true, json: async () => JSON.parse(fs.readFileSync(process.env.FISH_TEST_PUBLIC, 'utf8')) };
  if (url.searchParams.get('list') === 'categorymembers') {
    if (mode === 'category-failure') throw new Error('Injected category HTTP failure');
    if (mode === 'category-malformed') return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => ({ query: { categorymembers: mode === 'category-empty' ? [] : [{ title: 'Test Fish' }] } }) };
  }
  if (url.searchParams.get('action') === 'parse') {
    if (mode === 'fish-failure') throw new Error('Injected Wiki Fish failure');
    return { ok: true, json: async () => ({ parse: { title: 'Test Fish', pageid: 1, text: '<p>Fixture Fish description for validating a complete and successful Wiki response.</p><table class="infobox"><tr><th>Appears</th><td>Morning (3:00 AM - 6:00 AM)</td></tr></table>' } }) };
  }
  if (url.searchParams.get('prop') === 'info') return { ok: true, json: async () => ({ query: { pages: [{ fullurl: 'https://palia.wiki.gg/wiki/Test_Fish', lastrevid: 1 }] } }) };
  if (mode === 'image-failure') throw new Error('Injected recoverable image failure');
  return { ok: true, arrayBuffer: async () => new Uint8Array(2048).buffer };
};
`);
const env = mode => ({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: temp, TMP: temp, FISH_TEST_MODE: mode, NODE_OPTIONS: `--import=${pathToFileURL(mock).href}` });
function run(script, args = [], cwd = temp, mode = '', extra = {}) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, env: { ...env(mode), ...extra }, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  return result;
}
const validator = path.join(repo, 'tools/validateFishCatalogue.mjs');
function validation(name, candidate, publicCatalogue, base = approved, expected = false, raw = false, publishedBase = base) {
  const dir = path.join(temp, 'validation-' + checks++);
  const files = ['root.json', 'public.json', 'baseline.json', 'published.json'].map(p => path.join(dir, p));
  [raw ? candidate : copy(candidate), publicCatalogue, base, publishedBase].forEach((v, i) => write(files[i], v));
  const before = fs.readFileSync(files[3]);
  const result = run(validator, files);
  assert.equal(result.status === 0, expected, name + ': ' + result.stdout + result.stderr);
  assert.ok(fs.readFileSync(files[3]).equals(before), name + ': published baseline changed');
  console.log('PASS:', name);
}
validation('valid complete catalogue', approved, approved, approved, true);
const withDrops = { ...approved, meta: { ...approved.meta, count: 2, dropped: ['bass'] } };
validation('category count includes dropped entries', withDrops, withDrops, approved, true);
for (const patch of [
  { count: 999 }, { count: -1 }, { count: 1.5 }, { count: '1' }, { ok: 2 }, { failed: -1 },
  { failed: 0.5 }, { dropped: null }, { skippedTitles: null }, { dropped: ['bass', 'bass'] },
]) validation('malformed metadata ' + JSON.stringify(patch), { ...approved, meta: { ...approved.meta, ...patch } }, approved);
for (const meta of [undefined, null, [], {}]) validation('missing/malformed metadata object', { ...approved, meta }, approved);
for (const value of [null, { basic: null, quality: null }, { basic: 0, quality: 50 }, { basic: 25, quality: null }]) {
  const candidate = catalogue([{ ...fish(), value }]);
  validation('supported value ' + JSON.stringify(value), candidate, candidate, approved, true);
}
for (const value of ['invalid', [], {}, { basic: 5 }, { basic: '5', quality: null }, { basic: false, quality: null }]) {
  const candidate = catalogue([{ ...fish(), value }]);
  validation('malformed value ' + JSON.stringify(value), candidate, candidate);
}
const nonfinite = catalogue([{ ...fish(), value: { basic: Infinity, quality: null } }]);
assert.equal(validateCatalogues(nonfinite, nonfinite, [approved, approved]).valid, false);
console.log('PASS: nonfinite numeric value rejected');
const changedIdentity = catalogue([{ ...fish(), pageid: 99 }]);
validation('changed Wiki page identity', changedIdentity, changedIdentity);
validation('known Wiki page identity lost', catalogue([{ ...fish(), pageid: null }]), catalogue([{ ...fish(), pageid: null }]));
validation('unchanged Wiki identity', approved, approved, approved, true);
for (const pageid of [undefined, null, 0]) {
  const noOldIdentity = catalogue([{ ...fish(), pageid }]);
  validation('previous identity unavailable ' + pageid, approved, approved, noOldIdentity, true);
}
const added = catalogue([fish(), { ...fish('new_fish'), pageid: 3 }]);
validation('new Fish needs no historic identity', added, added, approved, true);
validation('empty catalogue', catalogue([]), catalogue([]));
validation('malformed JSON', '{broken', approved, approved, false, true);
validation('duplicate IDs', catalogue([fish(), fish()]), approved);
validation('missing name', catalogue([{ ...fish(), title: '' }]), approved);
validation('missing ID', catalogue([{ ...fish(), id: '' }]), approved);
const unknown = catalogue([fish('unknown', null)]);
validation('genuine unknown schedule allowed', unknown, unknown, unknown, true);
const invalid = catalogue([fish('test_fish', 'lunchtime')]);
validation('unrecognised schedule rejected', invalid, invalid);
const contradictory = catalogue([fish('test_fish', 'Morning (6:00 AM - 6:00 PM)')]);
validation('period/time contradiction rejected', contradictory, contradictory);
validation('failed Wiki metadata rejected', { ...approved, meta: { ok: 1, failed: 1, skippedTitles: ['Other Fish'] } }, approved);
validation('unexpected removal', approved, approved, catalogue([fish(), fish('other')]));
validation('public-only baseline removal blocked', approved, approved, approved, false, false, catalogue([fish(), fish('other')]));
validation('loss of known schedule', catalogue([fish('test_fish', null)]), catalogue([fish('test_fish', null)]));
validation('root/public mismatch', approved, catalogue([{ ...fish(), description: 'Changed' }]));
validation('root/public membership mismatch', approved, catalogue([fish(), fish('other')]));
validation('conflicting identities', catalogue([fish(), { ...fish('other'), title: 'Test Fish' }]), approved);
validation('malformed gameplay field', catalogue([{ ...fish(), locations: 'River' }]), approved);
validation('image URL rewriting allowed', approved, catalogue([{ ...fish(), imageUrl: 'https://example.com/mirror.png' }]), approved, true);
const missing = run(validator, [path.join(temp, 'missing'), path.join(temp, 'missing'), path.join(temp, 'missing'), path.join(temp, 'missing')]);
assert.notEqual(missing.status, 0); console.log('PASS: unreadable/missing public output rejected');

const scripts = ['pull-fish.mjs', 'tools/enrichFishImages.mjs', 'tools/mirrorFishImages.mjs', 'tools/bumpFishVersion.js', 'tools/validateFishCatalogue.mjs', 'tools/buildFishCandidate.mjs'];
function workspace(name) {
  const dir = path.join(temp, name);
  for (const script of scripts) { fs.mkdirSync(path.dirname(path.join(dir, script)), { recursive: true }); fs.copyFileSync(path.join(repo, script), path.join(dir, script)); }
  write(path.join(dir, 'fish.json'), approved); write(path.join(dir, 'docs/fish.json'), approved);
  return dir;
}
for (const mode of ['fish-failure', 'category-failure', 'category-malformed', 'category-empty']) {
  const dir = workspace(mode), before = fs.readFileSync(path.join(dir, 'fish.json'));
  const result = run(path.join(dir, 'pull-fish.mjs'), [], dir, mode);
  assert.notEqual(result.status, 0, mode);
  assert.ok(fs.readFileSync(path.join(dir, 'fish.json')).equals(before));
  if (mode === 'fish-failure') { assert.match(result.stderr, /test_fish/); assert.match(result.stderr, /Injected Wiki Fish failure/); }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'docs/fish.json'))), approved);
  console.log('PASS:', mode, 'nonzero and approved files unchanged');
}
for (const mode of ['write-failure', 'image-failure']) {
  const dir = workspace(mode), before = fs.readFileSync(path.join(dir, 'docs/fish.json'));
  const result = run(path.join(dir, 'tools/mirrorFishImages.mjs'), [], dir, mode);
  assert.equal(result.status === 0, mode === 'image-failure', result.stderr);
  if (mode === 'write-failure') assert.ok(fs.readFileSync(path.join(dir, 'docs/fish.json')).equals(before));
  else {
    const output = JSON.parse(fs.readFileSync(path.join(dir, 'docs/fish.json')));
    assert.equal(output.fish[0].imageUrl, approved.fish[0].imageUrl);
    assert.equal(validateCatalogues(approved, output, [approved, approved]).valid, true);
  }
  console.log('PASS:', mode);
}
// Entire isolated review pipeline: valid artifact, failed generation and removal gate.
for (const mode of ['', 'fish-failure', 'removal']) {
  const dir = workspace('runner-' + (mode || 'valid'));
  if (mode === 'removal') write(path.join(dir, 'fish.json'), catalogue([fish(), fish('other')]));
  const before = fs.readFileSync(path.join(dir, 'docs/fish.json'));
  const rootBefore = fs.readFileSync(path.join(dir, 'fish.json'));
  const output = path.join(temp, 'output-' + (mode || 'valid'));
  const result = run(path.join(dir, 'tools/buildFishCandidate.mjs'), [output], temp, mode, { FISH_TEST_PUBLIC: path.join(dir, 'docs/fish.json') });
  assert.equal(result.status === 0, !mode, result.stdout + result.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(output, 'review-report.json')));
  assert.equal(report.status, mode ? 'failed' : 'validated-for-review-only');
  if (mode === 'fish-failure') assert.match(report.generationFailure.details, /test_fish/);
  assert.equal(fs.existsSync(path.join(output, 'review/fish.json')), !mode);
  assert.ok(fs.readFileSync(path.join(dir, 'docs/fish.json')).equals(before));
  assert.ok(fs.readFileSync(path.join(dir, 'fish.json')).equals(rootBefore));
  console.log('PASS: isolated candidate pipeline', mode || 'valid', '(no Git publication credentials)');
}
// Fixed fixtures: legitimate updates to the real catalogue cannot break this coverage.
const rootFixture = catalogue([fish(), fish('root_only', null)]);
const publicFixture = catalogue([fish(), fish('public_only', 'Any Time')]);
const initial = baselineReport(rootFixture, publicFixture);
assert.deepEqual(initial.rootOnly, ['root_only']); assert.deepEqual(initial.publicOnly, ['public_only']);
assert.deepEqual(initial.unknownSchedules, ['root_only']);
const diagnosticRoot = path.join(temp, 'diagnostic-root.json'), diagnosticPublic = path.join(temp, 'diagnostic-public.json');
write(diagnosticRoot, rootFixture); write(diagnosticPublic, publicFixture);
const diagnostic = run(validator, ['--compare-baselines', diagnosticRoot, diagnosticPublic]);
assert.equal(diagnostic.status, 0); assert.deepEqual(JSON.parse(diagnostic.stdout).rootOnly, ['root_only']);
console.log('PASS: fixed addition/removal/unknown fixtures and separate dynamic diagnostic CLI');

// Canonical paths: aliases into the protected checkout must fail before writing.
const protectedCopy = workspace('alias-protected');
const runner = path.join(protectedCopy, 'tools/buildFishCandidate.mjs');
for (const output of [protectedCopy, path.join(protectedCopy, 'new'), path.join('alias-protected', 'relative-new')]) {
  const result = run(runner, [output], temp);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /outside the working repository/);
}
const alias = path.join(temp, 'checkout-alias');
let aliasSupported = true;
try { fs.symlinkSync(protectedCopy, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
catch (error) {
  if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
  aliasSupported = false; console.log('SKIP: filesystem aliases unavailable:', error.code);
}
if (aliasSupported) {
  const result = run(runner, [path.join(alias, 'missing-parent', 'candidate')], temp);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /outside the working repository/);
  assert.equal(fs.existsSync(path.join(protectedCopy, 'missing-parent')), false);
  console.log('PASS: alias/junction ancestor into protected checkout rejected without writes');
  const dangling = path.join(temp, 'dangling-alias');
  fs.symlinkSync(path.join(temp, 'absent-target'), dangling, process.platform === 'win32' ? 'junction' : 'dir');
  const uncertain = run(runner, [path.join(dangling, 'candidate')], temp);
  assert.notEqual(uncertain.status, 0);
  assert.equal(fs.existsSync(path.join(temp, 'absent-target')), false);
  console.log('PASS: unresolvable alias fails safely');
}
const nestedOutput = path.join(temp, 'new-parent', 'nested-output');
const isolated = run(runner, [path.relative(temp, nestedOutput)], temp, '', { FISH_TEST_PUBLIC: path.join(protectedCopy, 'docs/fish.json') });
assert.equal(isolated.status, 0, isolated.stderr);
console.log('PASS: relative external output with nonexistent ancestors succeeds');
console.log('All isolated safety checks passed on', process.version, '; retained fixtures:', temp);
