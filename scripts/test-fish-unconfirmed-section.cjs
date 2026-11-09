// Exercise production grouping with future Fish fixtures, without device or data writes.
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
const opened = [], alerts = [];
const c = {
  useMemo: fn => fn(), useCallback: fn => fn, clockViewMode: 'fish', filteredFishMode: false,
  paliaTime: { hour: 12, minute: 0 }, pad2: n => String(n).padStart(2, '0'),
  getSecondsUntilNextPaliaTime: () => 900,
  Linking: { openURL: async url => opened.push(url) }, Alert: { alert: (...args) => alerts.push(args) },
};
vm.createContext(c);
const run = text => vm.runInContext(ts.transpile(text, { target: ts.ScriptTarget.ES2020 }), c);
for (const name of ['parseFishSchedule', 'fishAppearsToWindow', 'fishAppearsToWindows', 'fishAppearsToPeriodsFlags', 'fishAppearsIsAnyTime', 'fishFieldLabel', 'fishBestBaitShort', 'buildFishNotes', 'extractFishFieldFromNotes', 'isAllDayFish', 'isUnconfirmedFish', 'canNotifyMarker', 'fishAppearsInPeriod', 'minutesUntil']) run(nodes.get(name).getText(tree));
function memo(name) { return run(`this.${name} = ${nodes.get(name).initializer.getText(tree)};`); }
function fish(id, appears) {
  const row = { id, title: id, appears, description: 'Known description', rarity: 'Rare', locations: ['Known lake'], bestBait: ['Worm'] };
  return { id: 'fish_' + id, name: id, notes: c.buildFishNotes(row), imageUrl: 'https://example.com/fish.png', enabled: true, ...c.fishAppearsToWindow(appears) };
}
const unknown = fish('future_unknown', null), timed = fish('timed', 'Evening');
const midnight = fish('midnight', '12:00 AM - 3:00 AM'), any = fish('any', 'Any Time'), allDay = fish('all_day', 'All Day');
c.enabledMarkers = [unknown, timed, midnight, any, allDay];
memo('expandedFishMarkers'); memo('homeListMarkers'); memo('allDayFish');
c.nowItems = [];
memo('nextSectionMarkers'); memo('unconfirmedFish'); memo('unconfirmedFishGridPairs');
assert.deepEqual(Array.from(c.nextSectionMarkers, m => m.baseId), [timed.id, midnight.id]);
assert.deepEqual(Array.from(c.allDayFish, m => m.baseId).sort(), [allDay.id, any.id].sort());
assert.equal(c.unconfirmedFish.length, 1);
assert.equal(c.unconfirmedFish[0].baseId, unknown.id);
assert.equal(c.unconfirmedFish[0].imageUrl, unknown.imageUrl);
assert.equal(c.unconfirmedFish[0].notes, unknown.notes);
assert.match(c.unconfirmedFish[0].notes, /Known lake/);
assert.match(c.unconfirmedFish[0].notes, /Best bait: Worm/);
assert.match(c.unconfirmedFish[0].notes, /Rarity: Rare/);
assert.equal(c.canNotifyMarker(c.unconfirmedFish[0]), false);
assert.equal(c.unconfirmedFish[0].hour, -1);
assert.equal(midnight.hour, 0);
c.countdowns = {};
assert.equal(memo('nextCountdownSeconds'), 900);

// Active known Fish are still excluded; future unknown IDs deduplicate and pair fully.
c.nowItems = [{ id: c.nextSectionMarkers[0].id, baseId: timed.id }];
memo('nextSectionMarkers');
assert.deepEqual(Array.from(c.nextSectionMarkers, m => m.baseId), [midnight.id]);
c.homeListMarkers.push({ ...c.unconfirmedFish[0], id: unknown.id + '__duplicate' }, fish('new_unknown', ''), fish('third_unknown', 'Unconfirmed'));
memo('unconfirmedFish'); memo('unconfirmedFishGridPairs');
assert.equal(c.unconfirmedFish.length, 3);
assert.deepEqual(Array.from(c.unconfirmedFishGridPairs, row => row.length), [2, 1]);
assert.equal(memo('showUnconfirmedFish'), true);

for (const period of ['morning', 'day', 'evening', 'night']) {
  c.nextTimeFilter = period; c.filteredFishMode = true;
  memo('filteredFishLists');
  assert.equal(c.filteredFishLists.allDay.length, 2);
  assert.equal(c.filteredFishLists.specific.some(m => c.isUnconfirmedFish(m)), false);
  assert.equal(memo('showUnconfirmedFish'), false);
}
c.filteredFishMode = false;
c.clockViewMode = 'events';
assert.equal(memo('showUnconfirmedFish'), false);
c.clockViewMode = 'fish'; c.homeListMarkers = [timed];
memo('unconfirmedFish'); memo('unconfirmedFishGridPairs');
assert.equal(c.unconfirmedFish.length, 0);
assert.equal(c.unconfirmedFishGridPairs.length, 0);
assert.equal(memo('showUnconfirmedFish'), false);

// Presentation reuses the existing interactive cards, base-ID lookup and caught state.
const section = source.slice(source.indexOf('{showUnconfirmedFish && ('), source.indexOf('{/* SECTION 19.6)'));
assert.match(section, /\{unconfirmedFish.length\} Fish/);
assert.match(section, /Appearance times for these Fish haven't been confirmed\. They may still be catchable\. Check the Official Palia Wiki or in-game information for further details\./);
assert.match(section, /accessibilityRole="link" accessibilityLabel="Official Palia Wiki"/);
for (const prop of ['markerMap', 'caughtFish', 'toggleCaughtStandard', 'toggleCaughtStar', 'expandedNextNotesId', 'setExpandedNextNotesId']) assert.ok(section.includes(`${prop}={${prop}}`));
assert.match(nodes.get('NextFishGrid').getText(tree), /markerMap.get\(\(m as any\).baseId \?\? m.id\)/);

(async () => {
  memo('openFishWiki');
  await c.openFishWiki();
  assert.deepEqual(opened, ['https://palia.wiki.gg/wiki/Fish']);
  c.Linking.openURL = async () => { throw new Error('No browser'); };
  await c.openFishWiki();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0][1], /https:\/\/palia.wiki.gg\/wiki\/Fish/);
  console.log('PASS: Unconfirmed/Next grouping, counts, deduplication, midnight, Any Time, filters, retained card details/interactions, empty visibility and safe Wiki linking');
})().catch(error => { console.error(error); process.exitCode = 1; });
