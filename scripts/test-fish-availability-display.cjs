// Exercise production display helpers and both renderer expressions without Expo.
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
let computations = 0;
const c = { pad2: n => String(n).padStart(2, '0'), useMemo: fn => { computations++; return fn(); } };
vm.createContext(c);
function run(code) { return vm.runInContext(ts.transpile(code, { target: ts.ScriptTarget.ES2020 }), c); }
for (const name of ['format12hTime', 'parseFishSchedule', 'isUnconfirmedFish', 'fishFieldLabel', 'fishAppearsToPeriodsFlags', 'fishAppearsIsAnyTime', 'fishAppearsToWindows', 'fishAvailabilityDisplayLabel', 'buildFishNotes', 'extractFishFieldFromNotes', 'isAllDayFish', 'canNotifyMarker']) run(nodes.get(name).getText(tree));
const catalogue = require('../fish.json').fish;
const cases = {
  angelfish: '3:00 AM - 9:00 PM',
  blue_spotted_ray: '3:00 AM - 9:00 PM',
  cloudfish: '3:00 AM - 6:00 PM',
  ancient_koi: 'Any Time',
  dawnray: '3:00 AM - 6:00 AM',
  fairy_carp: '3:00 AM - 6:00 AM\n6:00 PM - 9:00 PM',
  cactus_moray: '6:00 AM - 6:00 PM\n9:00 PM - 3:00 AM',
  devilfish: '6:00 PM - 6:00 AM',
  eleroo_eel: '6:00 PM - 6:00 AM',
  piksii_floatfish: '9:00 PM - 6:00 PM',
  albino_eel: 'Any Time',
};
c.markerFieldCache = new Map(catalogue.map(f => ['fish_' + f.id, { appears: f.appears || '' }]));
run(`this.fishAvailabilityLabels = ${nodes.get('fishAvailabilityLabels').initializer.getText(tree)};`);
assert.equal(computations, 1);
for (const [id, expected] of Object.entries(cases)) {
  const fish = catalogue.find(f => f.id === id);
  const marker = { id: 'fish_' + id, notes: c.buildFishNotes(fish), hour: 3, minute: 0, endHour: 6, endMinute: 0, hasRange: true, enabled: false, notify: false };
  const before = JSON.stringify(marker);
  c.m = marker; c.eventDetailsMarker = marker; c.hasRange = true;
  for (const renderer of ['timeLabel', 'timeText']) {
    const label = run(nodes.get(renderer).initializer.getText(tree));
    assert.equal(label, expected, `${id}: ${renderer}`);
    assert.equal(label.split('\n').length, ['fairy_carp', 'cactus_moray'].includes(id) ? 2 : 1);
    assert.ok(!label.includes(';'), 'windows must be separated by newlines');
  }
  const allDay = expected === 'Any Time';
  assert.equal(c.isAllDayFish(marker), allDay);
  assert.equal(c.canNotifyMarker(marker), !allDay);
  assert.equal(JSON.stringify(marker), before, 'display must not mutate preferences or timing');
}
// The current four-period parser permits at most two disjoint windows.
// Check three-window display formatting independently without changing that parser.
const originalParser = c.fishAppearsToWindows;
c.fishAppearsToWindows = () => [
  { hour: 3, minute: 0, hasRange: true, endHour: 6, endMinute: 0 },
  { hour: 12, minute: 0, hasRange: true, endHour: 15, endMinute: 0 },
  { hour: 21, minute: 0, hasRange: true, endHour: 1, endMinute: 0 },
];
const threeWindows = '3:00 AM - 6:00 AM\n12:00 PM - 3:00 PM\n9:00 PM - 1:00 AM';
assert.equal(c.fishAvailabilityDisplayLabel('Morning'), threeWindows);
c.fishAppearsToWindows = originalParser;
c.fishAvailabilityLabels.set('fish_three_windows', threeWindows);
c.m = c.eventDetailsMarker = { id: 'fish_three_windows' };
for (const renderer of ['timeLabel', 'timeText']) assert.equal(run(nodes.get(renderer).initializer.getText(tree)), threeWindows);
// All literal All Day catalogue entries must suppress restricted ranges and bells.
for (const fish of catalogue.filter(f => f.appears === 'All Day')) {
  assert.equal(c.fishAvailabilityLabels.get('fish_' + fish.id), 'Any Time');
  assert.equal(c.canNotifyMarker({ id: 'fish_' + fish.id, notes: c.buildFishNotes(fish) }), false);
}
// Missing Fish schedules must not use base times; Events retain their fallback.
assert.equal(c.fishAvailabilityLabels.get('fish_copper_sturgeon'), 'Unconfirmed');
for (const id of ['fish_copper_sturgeon', 'custom_example']) {
  c.m = c.eventDetailsMarker = { id, hour: 10, minute: 15, endHour: 11, endMinute: 30 };
  for (const renderer of ['timeLabel', 'timeText']) assert.equal(run(nodes.get(renderer).initializer.getText(tree)), id.startsWith('fish_') ? 'Unconfirmed' : '10:15 AM - 11:30 AM');
}
assert.equal(computations, 1, 'rendering labels must reuse the memoized map');
assert.match(nodes.get('fishAvailabilityLabels').initializer.getText(tree), /\[markerFieldCache\]/);
console.log('PASS: one/two/three-line setup/details labels, reported Fish, overnight windows, All Day suppression, cached lookups, unchanged markers and Event/unknown fallbacks');
