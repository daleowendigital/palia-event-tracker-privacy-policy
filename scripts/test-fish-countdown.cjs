// Run the actual countdown memo and timer/foreground effect against a controlled clock.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const source = fs.readFileSync('app/(tabs)/index.tsx', 'utf8');
const tree = ts.createSourceFile('screen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = new Map(); let tickEffect;
function visit(n) {
  if ((ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) && n.name && ts.isIdentifier(n.name)) nodes.set(n.name.text, n);
  if (ts.isCallExpression(n) && n.expression.getText(tree) === 'useEffect' && n.getText(tree).includes('setTimeout(compute')) tickEffect = n;
  ts.forEachChild(n, visit);
}
visit(tree);
const epoch = new Date(2026, 0, 1, 12, 0, 0).getTime();
let elapsedMs = 0, currentMemo, foreground, timer;
const memoCache = new Map();
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [epoch + elapsedMs])); }
  static now() { return epoch + elapsedMs; }
}
const c = {
  Date: Clock, clockViewMode: 'fish', nextSectionMarkers: [], countdowns: {},
  useMemo: (fn, deps) => {
    const old = memoCache.get(currentMemo);
    if (old && deps.every((v, i) => Object.is(v, old.deps[i]))) return old.value;
    const value = fn(); memoCache.set(currentMemo, { deps, value }); return value;
  },
  pad2: x => String(x).padStart(2, '0'), markersRef: { current: [] },
  useEffect: fn => { c.cleanup = fn(); },
  setCountdowns: next => { c.countdowns = next; },
  setTimeout: fn => { timer = fn; return 1; }, clearTimeout: () => { timer = null; },
  AppState: { addEventListener: (name, fn) => { assert.equal(name, 'change'); foreground = fn; return { remove() {} }; } },
};
vm.createContext(c);
function run(text) { vm.runInContext(ts.transpile(text, { target: ts.ScriptTarget.ES2020 }), c); }
for (const name of ['getPaliaMinutesNow', 'getMsUntilNextPaliaTime', 'getSecondsUntilNextPaliaTime']) run(nodes.get(name).getText(tree));
function read() {
  for (const name of ['nextCountdownSeconds', 'nextCountdownLabel']) {
    currentMemo = name; run(`this.${name} = ${nodes.get(name).initializer.getText(tree)};`);
  }
  return [c.nextCountdownSeconds, c.nextCountdownLabel];
}
function atPalia(hour, minute = 0, seconds = 0) { elapsedMs = (hour * 60 + minute) * 2500 + seconds * 1000; }
const window = (hour, minute, extra = {}) => ({ id: 'fish_test__w1', baseId: 'fish_test', hour, minute, ...extra });

// Disjoint Morning/Evening windows: the base clock must not determine the selected window.
atPalia(12); c.nextSectionMarkers = [window(18, 0, { endHour: 21, endMinute: 0 })];
c.markersRef.current = [{ id: 'fish_test', hour: 3, minute: 0 }];
run(tickEffect.getText(tree));
assert.equal(c.countdowns.fish_test, 2250);
assert.deepEqual(read(), [900, '15:00']);
const selected = c.nextSectionMarkers;
elapsedMs += 1000; timer(); assert.deepEqual(read(), [899, '14:59']);
assert.equal(c.nextSectionMarkers, selected);
// Foreground recomputes absolute time without waiting for another scheduled timer.
elapsedMs += 300000; foreground('active'); assert.deepEqual(read(), [599, '9:59']);

// Single window and midnight wrapping; ceil prevents early 00:00.
atPalia(2); c.nextSectionMarkers = [window(3, 0)]; foreground('active'); assert.deepEqual(read(), [150, '2:30']);
atPalia(23, 59); c.nextSectionMarkers = [window(0, 0)]; foreground('active'); assert.deepEqual(read(), [3, '0:03']);
elapsedMs += 1000; timer(); assert.deepEqual(read(), [2, '0:02']);
atPalia(0); foreground('active'); assert.deepEqual(read(), [3600, '60:00']);
// Supply the existing list's next selected occurrence; do not change selection here.
atPalia(18); c.nextSectionMarkers = [window(3, 0)]; foreground('active'); assert.deepEqual(read(), [1350, '22:30']);

// Event mode continues to use the existing countdown map and lookup unchanged.
c.clockViewMode = 'events'; c.nextSectionMarkers = [{ id: 'custom_event', hour: 0, minute: 0 }];
c.countdowns = { custom_event: 123 }; assert.deepEqual(read(), [123, '2:03']);
c.countdowns = { custom_event: 122 }; assert.deepEqual(read(), [122, '2:02']);
c.nextSectionMarkers = []; assert.equal(read()[0], 0);

const nextGrid = nodes.get('NextFishGrid').getText(tree), nowGrid = nodes.get('NowFishGrid').getText(tree);
assert.ok(nextGrid.includes('Starts {format12hTime(m.hour, m.minute)}'));
assert.ok(!nextGrid.includes('Ends {format12hTime(m.hour, m.minute)}'));
assert.match(nextGrid, /filteredFishMode \? <View style=\{\{ flex: 1 \}\} \/> : \(/);
assert.ok(nowGrid.includes('`Ends ${it.endHour'));
assert.ok(source.includes('!nextTimeFilter && nextSectionMarkers.length ? ('));
c.cleanup();
console.log('PASS: Starts/Ends labels, planning visibility, selected-window countdown, 12:00 Morning/Evening example, single windows, midnight/cycle transitions, real-second ticks, foreground resume and unchanged Event countdowns');
