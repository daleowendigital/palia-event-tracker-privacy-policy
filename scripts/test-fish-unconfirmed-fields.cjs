// Execute production helpers and list memos with isolated records; no catalogue writes.
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
const c = { useMemo: fn => fn(), pad2: n => String(n).padStart(2, '0'), getSecondsUntilNextPaliaTime: () => 900, clockViewMode: 'fish', paliaTime: { hour: 12, minute: 0 } };
vm.createContext(c);
const run = text => vm.runInContext(ts.transpile(text, { target: ts.ScriptTarget.ES2020 }), c);
for (const name of ['parseFishSchedule', 'fishAppearsToWindow', 'fishAppearsToWindows', 'fishAppearsToPeriodsFlags', 'fishAppearsIsAnyTime', 'fishAvailabilityDisplayLabel', 'fishTimeSortKey', 'fishFieldLabel', 'fishBestBaitShort', 'buildFishNotes', 'extractFishFieldFromNotes', 'isAllDayFish', 'isUnconfirmedFish', 'canNotifyMarker', 'normaliseFishNotification', 'isRecord', 'toIntInRange', 'normalizeStoredMarker', 'format12hTime', 'minutesUntil']) run(nodes.get(name).getText(tree));
function memo(name) { return run(`this.${name} = ${nodes.get(name).initializer.getText(tree)};`); }
function fish(id, extra = {}) {
  const row = { id, title: id, description: 'A fish with confirmed location and bait.', rarity: 'Rare', locations: ['Royal Highlands'], biomes: ['Royal Highlands Bay'], bestBait: ['Glow Worm'], appears: 'Morning', value: { basic: 0, quality: 50 }, ...extra };
  return { ...row, marker: { id: 'fish_' + id, name: row.title, ...c.fishAppearsToWindow(row.appears), notes: c.buildFishNotes(row), enabled: true, notify: true } };
}

// Every existing usable catalogue schedule remains recognised; fixtures cover unpublished fish.
for (const path of ['fish.json', 'docs/fish.json']) {
  for (const row of JSON.parse(fs.readFileSync(path, 'utf8')).fish) {
    if (row.appears) assert.notEqual(c.parseFishSchedule(row.appears).kind, 'unconfirmed', row.id);
  }
}
for (const id of ['copper_sturgeon', 'ooh_barracuda', 'ragdoll_sturgeon', 'sillyfin']) {
  const row = fish(id, { appears: null, description: 'Source prose says any time of day; structured availability is missing.' });
  assert.equal(c.fishAvailabilityDisplayLabel(row.appears), 'Unconfirmed');
  assert.equal(c.fishAppearsToWindows(row.appears).length, 0);
  assert.equal(row.marker.hour, -1);
  assert.equal(row.marker.hasRange, false);
  assert.equal(c.isAllDayFish(row.marker), false);
  assert.equal(c.canNotifyMarker(row.marker), false);
  assert.equal(c.fishTimeSortKey(row.appears).group, 2);
  assert.match(row.marker.notes, /Best bait: Glow Worm/);
  assert.match(row.marker.notes, /Locations: Royal Highlands/);
  const restored = c.normalizeStoredMarker(JSON.parse(JSON.stringify({ ...row.marker, hour: 0, minute: 0 })));
  assert.equal(restored.notify, false);
  assert.equal(restored.hour, -1);
  assert.equal(restored.enabled, true);
  assert.equal(restored.id, row.marker.id);
  assert.equal(restored.notes, row.marker.notes);
  assert.equal(c.normalizeStoredMarker(JSON.parse(JSON.stringify(restored))).notify, false);
}
for (const value of [undefined, '', '  ', 123, {}, 'Unconfirmed', 'Many locations', 'not available during Morning', 'Morning (99:00 AM - 99:00 PM)', 'Morning (6:00 AM - 6:00 PM)', 'Any Time uncertain', 'Night (?)', '12:00 AM - 12:00 AM']) {
  assert.equal(c.parseFishSchedule(value).kind, 'unconfirmed', String(value));
  assert.equal(c.fishAvailabilityDisplayLabel(value), 'Unconfirmed');
  assert.equal(c.canNotifyMarker({ id: 'fish_bad', notes: 'Appears: ' + (value ?? '') }), false);
}
assert.equal(c.extractFishFieldFromNotes('Appears: \nBest bait: Morning', 'Appears'), '');
for (const value of ['Any Time', 'All Day', 'Morning, Day, Evening and Night']) {
  assert.equal(c.fishAvailabilityDisplayLabel(value), 'Any Time');
  assert.equal(c.canNotifyMarker(fish('any', { appears: value }).marker), false);
  assert.equal(c.fishTimeSortKey(value).group, 1);
}
const cases = [
  ['Morning (3:00 AM - 6:00 AM)', '3:00 AM - 6:00 AM'],
  ['Night (9:00 PM - 3:00 AM)', '9:00 PM - 3:00 AM'],
  ['Morning (3:00 AM - 6:00 AM) and Evening (6:00 PM - 9:00 PM)', '3:00 AM - 6:00 AM\n6:00 PM - 9:00 PM'],
  ['12:00 AM - 3:00 AM', '12:00 AM - 3:00 AM'],
  ['10:00 PM - 12:00 AM', '10:00 PM - 12:00 AM'],
];
for (const [value, expected] of cases) {
  assert.equal(c.fishAvailabilityDisplayLabel(value), expected);
  assert.equal(c.canNotifyMarker(fish('timed', { appears: value }).marker), true);
  assert.equal(c.fishTimeSortKey(value).group, 0);
}
assert.equal(c.fishAppearsToWindow('12:00 AM - 3:00 AM').hour, 0);
assert.equal(c.fishTimeSortKey('12:00 AM - 3:00 AM').start, 0);

const missingBait = fish('bait', { bestBait: [] });
assert.match(missingBait.marker.notes, /Best bait: Unconfirmed/);
assert.match(missingBait.marker.notes, /Locations: Royal Highlands/);
assert.equal(c.fishAvailabilityDisplayLabel(missingBait.appears), '3:00 AM - 6:00 AM');
assert.equal(c.canNotifyMarker(missingBait.marker), true);
const missingLocation = fish('location', { locations: [], biomes: [] });
assert.match(missingLocation.marker.notes, /Locations: Unconfirmed\nBiomes: Unconfirmed/);
assert.match(missingLocation.marker.notes, /Best bait: Glow Worm/);
assert.equal(c.canNotifyMarker(missingLocation.marker), true);
assert.equal(c.fishBestBaitShort(''), 'Unconfirmed');
for (const value of ['None', 'No Bait', 'Worm']) assert.equal(c.fishBestBaitShort(value), value);
assert.equal(c.fishFieldLabel(['']), 'Unconfirmed');
for (const value of [null, undefined, { basic: 0, quality: 0 }, { basic: 25, quality: 50 }]) {
  const row = fish('value_case', { value: value === null ? { basic: null, quality: null } : value });
  delete row.marker;
  if (value === undefined) delete row.value;
  const before = JSON.stringify(row);
  const notes = c.buildFishNotes(row);
  assert.doesNotMatch(notes, /^Value:/m);
  assert.equal(notes, [
    'A fish with confirmed location and bait.', '', 'Rarity: Rare',
    'Appears: Morning', 'Locations: Royal Highlands', 'Biomes: Royal Highlands Bay',
    'Best bait: Glow Worm',
  ].join('\n'));
  assert.equal(JSON.stringify(row), before);
}
const partial = fish('partial', { rarity: null, description: null, value: { basic: 0, quality: null } });
assert.match(partial.marker.notes, /Description: Unconfirmed/);
assert.match(partial.marker.notes, /Rarity: Unconfirmed/);
assert.doesNotMatch(partial.marker.notes, /^Value:/m);

// Unknown fish remain visible, sort last in Home, and cannot supply a countdown.
const unknown = fish('unknown', { appears: null }).marker;
const timed = fish('timed').marker;
c.enabledMarkers = [unknown, timed];
memo('expandedFishMarkers');
assert.equal(c.expandedFishMarkers.length, 2);
memo('homeListMarkers');
assert.deepEqual(Array.from(c.homeListMarkers, m => m.baseId), [timed.id, unknown.id]);
c.nextSectionMarkers = c.homeListMarkers;
c.countdowns = {};
assert.equal(memo('nextDigitalLabel'), '3:00 AM');
assert.ok(memo('nextCountdownSeconds') > 0);
c.nextSectionMarkers = [unknown];
assert.equal(memo('nextDigitalLabel'), 'Unconfirmed');
assert.equal(memo('nextCountdownSeconds'), 0);
assert.equal(memo('nextCountdownLabel'), 'Unconfirmed');
c.enabledMarkers = [unknown];
assert.equal(memo('nextTimeKey'), null);
for (const name of ['timeLabel', 'timeText']) {
  c.fishAvailabilityLabels = new Map([[unknown.id, 'Unconfirmed']]);
  c.m = c.eventDetailsMarker = unknown; c.hasRange = false;
  assert.equal(run(nodes.get(name).initializer.getText(tree)), 'Unconfirmed');
}
// A real midnight non-Fish event keeps its schedule and notification preference.
const event = { id: 'custom_midnight', name: 'Midnight event', hour: 0, minute: 0, enabled: true, notify: true };
assert.equal(c.canNotifyMarker(event), true);
assert.equal(c.normalizeStoredMarker(event).hour, 0);
assert.equal(c.normalizeStoredMarker(event).notify, true);

// Exercise the real catalogue merge with isolated missing fields, retaining IDs,
// enabled preferences, unrelated Events and caught-state data.
c.hydrated = true; c.remoteFishStatus = 'ready'; c.useEffect = fn => fn();
c.console = { log() {} }; c.normalizeRemoteFish = rows => rows; c.isBlockedFishEntry = () => false;
c.markers = [{ ...event, notes: 'Custom Event notes: Value: keep this text' }, { ...timed, notify: true, notes: timed.notes + '\nValue: Unconfirmed (basic), Unconfirmed (quality)' }];
const preservedEvent = c.markers[0];
c.caughtFish = { [timed.id]: { standard: true, star: true } };
const catches = c.caughtFish;
c.setMarkers = update => { c.markers = update(c.markers); };
c.remoteFish = [
  { id: 'timed', title: 'Timed', appears: null, bestBait: ['Glow Worm'], locations: ['Royal Highlands'] },
  { id: 'missing_location', title: 'Missing location', appears: 'Morning', bestBait: ['Worm'] },
  { id: 'known_biome', title: 'Known biome', appears: 'Morning', locations: [], biomes: ['Known river'], bestBait: [] },
];
const mergeStart = source.indexOf('useEffect(() => {', source.indexOf('// SECTION 12.X) Sync remote fish'));
const mergeEnd = source.indexOf('}, [hydrated, remoteFishStatus, remoteFish]);', mergeStart) + '}, [hydrated, remoteFishStatus, remoteFish]);'.length;
run(source.slice(mergeStart, mergeEnd));
assert.equal(c.markers[0], preservedEvent);
assert.equal(c.markers[1].id, timed.id);
assert.equal(c.markers[1].enabled, true);
assert.equal(c.markers[1].notify, false);
assert.equal(c.markers[1].hour, -1);
assert.match(c.markers[1].notes, /Best bait: Glow Worm/);
assert.doesNotMatch(c.markers[1].notes, /^Value:/m);
assert.equal(c.markers[2].name, 'Missing location - Unconfirmed');
assert.equal(c.canNotifyMarker(c.markers[2]), true);
assert.equal(c.markers[3].name, 'Known biome - Known river');
assert.match(c.markers[3].notes, /Best bait: Unconfirmed/);
assert.equal(c.caughtFish, catches);
assert.equal(c.caughtFish[timed.id].standard, true);
assert.equal(c.caughtFish[timed.id].star, true);
console.log('PASS: isolated uncertain Fish, strict schedule validation, midnight/overnight/disjoint windows, per-field fallbacks, stored preferences, visible Home entries and safe countdowns');
