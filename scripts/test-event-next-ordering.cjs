// Evaluate the actual list calculations with memo dependencies and controlled Palia time.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const source = fs.readFileSync('app/(tabs)/index.tsx', 'utf8');
const tree = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
function visit(node) {
  if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
    declarations.set(node.name.text, node);
  }
  ts.forEachChild(node, visit);
}
visit(tree);
const memos = new Map(); let slot;
const c = {
  useMemo: (fn, deps) => {
    const previous = memos.get(slot);
    if (previous && deps.every((value, index) => Object.is(value, previous.deps[index]))) return previous.value;
    const value = fn(); memos.set(slot, { deps, value }); return value;
  },
  useCallback: fn => fn, clockViewMode: 'events', nextTimeFilter: null,
  filteredEventMode: false, expandedFishMarkers: [], countdowns: {},
  pad2: value => String(value).padStart(2, '0'), format12hTime: (h, m) => `${h}:${m}`,
  fishAppearsIsAnyTime: notes => /Appears: Any Time/.test(notes || ''),
};
vm.createContext(c);
function evaluate(name) {
  const node = declarations.get(name); assert.ok(node, `Missing source declaration: ${name}`);
  const text = ts.isFunctionDeclaration(node) ? node.getText(tree) : `this.${name} = ${node.initializer.getText(tree)};`;
  slot = name;
  vm.runInContext(ts.transpile(text, { target: ts.ScriptTarget.ES2020 }), c);
  return c[name];
}
for (const name of ['minutesUntil', 'isActiveNow', 'splitName', 'getEventWindowEnd', 'eventOccursInPeriod', 'sortKeyForTimeOfDay', 'isMinuteInTimeOfDay']) evaluate(name);
function render(markers, hour, minute) {
  c.markers = markers; c.paliaTime = { hour, minute };
  c.countdowns = Object.fromEntries(markers.map(m => [m.id, c.minutesUntil(hour, minute, m.hour, m.minute) * 2.5]));
  for (const name of ['sortedMarkers', 'enabledMarkers', 'homeListMarkers', 'nowItems', 'allDayFish', 'nextSectionMarkers', 'eventPlanningMarkers', 'nextTimeGroups']) evaluate(name);
  return Array.from(c.nextSectionMarkers, m => m.id);
}
const event = (id, hour, minute = 0, extra = {}) => ({ id, name: id, hour, minute, enabled: true, notify: false, ...extra });
let markers = [event('A', 6), event('B', 7)];
assert.deepEqual(render(markers, 5, 59), ['A', 'B']);
assert.deepEqual(render(markers, 6, 0), ['B', 'A']);
assert.equal(c.minutesUntil(6, 0, 6, 0), 1440);
assert.deepEqual(render(markers, 6, 1), ['B', 'A']);
markers = markers.map(m => ({ ...m, notify: !m.notify }));
assert.deepEqual(render(markers, 6, 1), ['B', 'A']);

markers = [event('Z', 8), event('A', 8), event('disabled', 7, 0, { enabled: false })];
assert.deepEqual(render(markers, 7, 0), ['A', 'Z']);
assert.deepEqual(render(markers.slice().reverse().map(m => ({ ...m, notify: true })), 7, 0), ['A', 'Z']);

markers = [event('range', 6, 0, { hasRange: true, endHour: 7, endMinute: 0 }), event('point', 8)];
render(markers, 5, 59); assert.equal(c.nowItems.length, 0);
render(markers, 6, 0); assert.deepEqual(Array.from(c.nowItems, m => m.id), ['range']);
assert.deepEqual(Array.from(c.nextSectionMarkers, m => m.id), ['point']);
render(markers, 7, 0); assert.equal(c.nowItems.length, 0);
assert.deepEqual(Array.from(c.nextSectionMarkers, m => m.id), ['point', 'range']);
markers = [event('overnight', 22, 0, { hasRange: true, endHour: 2, endMinute: 0 })];
for (const [hour, minute, active] of [[21, 59, false], [22, 0, true], [0, 0, true], [1, 59, true], [2, 0, false]]) {
  render(markers, hour, minute); assert.equal(c.nowItems.length, active ? 1 : 0);
}

markers = [event('a', 3), event('b', 4), event('c', 5), event('d', 6)];
render(markers, 2, 0); assert.equal(c.nextTimeGroups.length, 3);
for (const count of [1, 2, 3]) assert.equal(c.nextTimeGroups.slice(0, count).length, count);
markers = Array.from({ length: 10 }, (_, i) => event(`row${i}`, 3));
render(markers, 2, 0); assert.equal(c.nextTimeGroups[0].items.length, 8);

c.nextTimeFilter = 'night'; c.filteredEventMode = true;
markers = [event('early', 1), event('late', 22), event('middle', 23), event('day', 10)];
render(markers, 12, 0);
assert.deepEqual(Array.from(c.eventPlanningMarkers, m => m.id), ['late', 'middle', 'early']);
render(markers, 23, 30);
assert.deepEqual(Array.from(c.eventPlanningMarkers, m => m.id), ['late', 'middle', 'early']);
c.nextTimeFilter = null; c.filteredEventMode = false;

c.clockViewMode = 'fish';
c.expandedFishMarkers = [event('fish_a', 6), event('fish_b', 7)];
markers = c.expandedFishMarkers;
assert.deepEqual(render(markers, 5, 59), ['fish_a', 'fish_b']);
assert.deepEqual(render(markers, 6, 1), ['fish_b', 'fish_a']);
c.clockViewMode = 'events';
markers = [event('before-resume', 6), event('after-resume', 12)];
render(markers, 5, 59);
// Once the existing Palia clock publishes resumed time, ordering needs no marker mutation.
assert.deepEqual(render(markers, 10, 0), ['after-resume', 'before-resume']);
console.log('PASS: automatic Event rotation, next-cycle wrap, bell independence, equal-time stability, Now/overnight boundaries, disabled Events, group/row caps, planning and Fish ordering, resumed clock values');
