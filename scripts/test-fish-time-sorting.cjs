// Run production sort metadata, comparators and folder branches without Expo.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const source = fs.readFileSync('app/(tabs)/index.tsx', 'utf8');
const tree = ts.createSourceFile('screen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = new Map();
function visit(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name && ts.isIdentifier(node.name)) nodes.set(node.name.text, node);
  ts.forEachChild(node, visit);
}
visit(tree);
const c = { useMemo: fn => fn(), countdowns: {} };
vm.createContext(c);
const run = code => vm.runInContext(ts.transpile(code, { target: ts.ScriptTarget.ES2020 }), c);
for (const name of ['parseFishSchedule', 'isUnconfirmedFish', 'fishFieldLabel', 'fishAppearsToPeriodsFlags', 'fishAppearsIsAnyTime', 'fishAppearsToWindows', 'fishAppearsToWindow', 'fishTimeSortKey']) run(nodes.get(name).getText(tree));
function evaluate(name) { run(`this.${name} = ${nodes.get(name).initializer.getText(tree)};`); }
const catalogue = require('../fish.json').fish;
c.markers = catalogue.map(f => ({ id: 'fish_' + f.id, name: f.title + ' - Location', ...c.fishAppearsToWindow(f.appears) }));
c.markerFieldCache = new Map(catalogue.map(f => ['fish_' + f.id, { appears: f.appears || '' }]));
evaluate('fishTimeSortMetadata'); evaluate('sortFishByTime'); evaluate('sortByTime'); evaluate('sortByNext');
for (const [id, start] of Object.entries({ angelfish: 180, fairy_carp: 180, cactus_moray: 360, devilfish: 1080, eleroo_eel: 1080, piksii_floatfish: 1260, amber_moray: 1260 })) {
  assert.equal(c.fishTimeSortMetadata.get('fish_' + id).start, start, id);
}
for (const id of ['albino_eel', 'ancient_koi']) assert.equal(c.fishTimeSortMetadata.get('fish_' + id).group, 1);
assert.equal(c.fishTimeSortMetadata.get('fish_copper_sturgeon').group, 2);
assert.equal(c.fishTimeSortKey('').group, 2);
assert.equal(c.fishTimeSortKey('unrecognised').group, 2);
// Controlled expanded windows verify minute precision, invalid endpoints and min selection.
const parser = c.fishAppearsToWindows;
const window = (hour, minute, endHour = 23, endMinute = 59) => ({ hour, minute, endHour, endMinute, hasRange: true });
c.fishAppearsToWindows = () => [window(21, 0, 3, 0), window(6, 15, 18, 0)];
assert.equal(c.fishTimeSortKey('Day').start, 375);
for (const invalid of [window(24, 0), window(3, 60), window(3, 0, undefined, 99), window(3, 0, 3, 0)]) {
  c.fishAppearsToWindows = () => [invalid];
  assert.equal(c.fishTimeSortKey('Day').group, 2);
}
const synthetic = [
  ['fish_z', 'Alpha - Z location', 0, 0],
  ['fish_a', 'Zulu - A location', 0, 0],
  ['fish_t2', 'Same - A', 0, 610],
  ['fish_t1', 'Same - Z', 0, 610],
  ['fish_early', 'Earlier', 0, 609],
  ['fish_late', 'Late', 0, 1439],
  ['fish_any_z', 'Any Z', 1, 0],
  ['fish_any_a', 'Any A', 1, 0],
  ['fish_bad_z', 'Unknown Z', 2, 0],
  ['fish_bad_a', 'Unknown A', 2, 0],
];
// Build synthetic windows through the production metadata memo, including displayed names.
c.markers = synthetic.map(([id, name]) => ({ id, name, hour: 3, minute: 0, enabled: false, notify: false }));
c.markerFieldCache = new Map(synthetic.map(([id, , group]) => [id, { appears: group === 1 ? 'Any Time' : group === 2 ? '' : id }]));
c.fishAppearsToWindows = label => {
  const item = synthetic.find(([id]) => id === label);
  return item ? [window(Math.floor(item[3] / 60), item[3] % 60, 0, 1)] : parser(label);
};
evaluate('fishTimeSortMetadata');
c.fishAppearsToWindows = () => { throw Error('comparator must reuse cached metadata'); };
const expected = ['fish_z', 'fish_a', 'fish_early', 'fish_t1', 'fish_t2', 'fish_late', 'fish_any_a', 'fish_any_z', 'fish_bad_a', 'fish_bad_z'];
const before = JSON.stringify(c.markers);
for (const input of [c.markers, [...c.markers].reverse(), [...c.markers.slice(3), ...c.markers.slice(0, 3)]]) {
  c.fishMarkers = input; evaluate('fishMarkersView');
  assert.deepEqual(Array.from(c.fishMarkersView, m => m.id), expected);
}
assert.equal(JSON.stringify(c.markers), before);
// Identical names use IDs in every schedule group.
for (const group of [1, 2]) {
  const tied = [{ id: 'fish_tie_z' }, { id: 'fish_tie_a' }];
  for (const m of tied) c.fishTimeSortMetadata.set(m.id, { group, start: 0, name: 'Identical' });
  assert.deepEqual(tied.slice().sort(c.sortFishByTime).map(m => m.id), ['fish_tie_a', 'fish_tie_z']);
}
// Changing countdowns cannot change chronological Fish ordering or membership.
for (const offset of [0, 999, 3600]) {
  c.countdowns = Object.fromEntries(c.markers.map((m, i) => [m.id, (offset + i * 13) % 3600]));
  c.fishMarkers = [...c.markers].reverse(); evaluate('fishMarkersView');
  assert.deepEqual(Array.from(c.fishMarkersView, m => m.id), expected);
  assert.deepEqual(Array.from(c.fishMarkersView, m => m.id).sort(), c.markers.map(m => m.id).sort());
}
for (const prefix of ['default', 'custom', 'repeatable']) {
  c[prefix + 'Markers'] = c.markers;
  for (const mode of ['time', 'next']) {
    c[prefix + 'MarkersSort'] = mode;
    evaluate(prefix + 'MarkersView');
    assert.deepEqual(Array.from(c[prefix + 'MarkersView'], m => m.id), c.markers.slice().sort(mode === 'time' ? c.sortByTime : c.sortByNext).map(m => m.id));
  }
}
assert.equal(JSON.stringify(c.markers), before);
assert.match(nodes.get('fishTimeSortMetadata').initializer.getText(tree), /\[markers, markerFieldCache\]/);
assert.doesNotMatch(source, /\b(fishMarkersSort|setFishMarkersSort|toggleFishSort|sortFishByNext)\b/);
console.log('PASS: chronological Fish placements, alphabetical/ID ties, schedule groups, countdown-independent membership/order, cached metadata, immutability, no Fish sort toggle and unchanged Time/Next in other folders');
