// Actual source helpers/callbacks with controlled native promises; no device writes.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const source = fs.readFileSync('app/(tabs)/index.tsx', 'utf8');
const tree = ts.createSourceFile('screen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = new Map(); let guardedBells = 0;
function visit(n) {
  if ((ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) && n.name && ts.isIdentifier(n.name)) nodes.set(n.name.text, n);
  if (ts.isJsxElement(n) && n.openingElement.tagName.getText(tree) === 'ScalePressable' && /toggleNotify\((marker|m)\.id\)/.test(n.getText(tree))) {
    assert.ok(ts.isConditionalExpression(n.parent));
    assert.match(n.parent.condition.getText(tree), /^canNotifyMarker\((marker|m)\)$/);
    assert.equal(n.parent.whenFalse.getText(tree), 'null');
    guardedBells++;
  }
  ts.forEachChild(n, visit);
}
visit(tree); assert.equal(guardedBells, 6);
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
const helpers = ['fishAppearsToPeriodsFlags', 'fishAppearsIsAnyTime', 'extractFishFieldFromNotes', 'isAllDayFish', 'canNotifyMarker', 'normaliseFishNotification', 'isRecord', 'toIntInRange', 'normalizeStoredMarker', 'groupEnabledMarkersByTime'];
function setup() {
  const c = {
    Platform: { OS: 'android' }, __DEV__: false, useCallback: fn => fn,
    console: { warn: (...args) => c.warnings.push(args), log() {} }, warnings: [],
    timeKeyFor: (h, m) => `${h}:${m}`, makeId: () => 'generated', errMsg: e => e.message,
    notifEnabledRef: { current: true }, reminderRef: { current: 0 }, markersRef: { current: [] },
    resyncGateRef: { current: { queued: false, inFlight: false, completion: null, lastAt: 0 } },
    pending: [], scheduledMembers: [], operations: [], ensurePermission: async () => ({ ok: true }),
  };
  c.Notifications = {
    getAllScheduledNotificationsAsync: async () => c.pending,
    cancelAllScheduledNotificationsAsync: async () => { c.operations.push('cancel-all'); c.pending = []; },
    cancelScheduledNotificationAsync: async id => { c.operations.push('cancel:' + id); c.pending = c.pending.filter(n => n.identifier !== id); },
  };
  c.scheduleTimeGroupOccurrences = async ({ group }) => {
    c.operations.push('schedule'); c.scheduledMembers.push(...group.markers.map(m => m.id));
    c.pending.push({ identifier: 'new', content: { data: { type: 'time_group', markerIds: group.markers.map(m => m.id) } } });
    return ['new'];
  };
  vm.createContext(c);
  for (const name of helpers) vm.runInContext(ts.transpile(nodes.get(name).getText(tree), { target: ts.ScriptTarget.ES2020 }), c);
  for (const name of ['resyncTimeNotifications', 'toggleNotify']) vm.runInContext(ts.transpile(`this.${name} = ${nodes.get(name).initializer.getText(tree)}`, { target: ts.ScriptTarget.ES2020 }), c);
  vm.runInContext(ts.transpile(nodes.get('setNotifyForMany').getText(tree), { target: ts.ScriptTarget.ES2020 }), c);
  c.setMarkers = update => { c.markersRef.current = update(c.markersRef.current); };
  return c;
}
const fish = (id, appears, extra = {}) => ({ id: 'fish_' + id, name: id, hour: 0, minute: 0, enabled: true, notify: true, notes: 'Description for all ponds, any bait\n' + (appears == null ? '' : 'Appears: ' + appears), ...extra });
(async () => {
  let c = setup();
  for (const label of ['Any Time', 'All Day', 'Morning, Day, Evening and Night']) assert.equal(c.isAllDayFish(fish(label, label)), true);
  for (const label of ['Morning', 'Day', 'Evening', 'Night', 'Evening and Night', 'Morning and Day', 'Many locations', null, '']) assert.equal(c.isAllDayFish(fish(String(label), label)), false);
  assert.equal(c.isAllDayFish({ ...fish('event', 'Any Time'), id: 'custom_event' }), false);
  const all = fish('all', 'Any Time'), timed = fish('timed', 'Night'), unknown = fish('unknown', null);
  const restored = c.normalizeStoredMarker(all);
  assert.equal(restored.notify, false); assert.equal(restored.enabled, all.enabled);
  assert.equal(restored.notes, all.notes);
  assert.equal(c.normalizeStoredMarker(JSON.parse(JSON.stringify(restored))).notify, false);
  assert.equal(c.normalizeStoredMarker(timed).notify, true);
  assert.equal(c.normalizeStoredMarker(unknown).notify, true);
  c.markersRef.current = [all, timed, unknown];
  c.toggleNotify(all.id); assert.equal(c.markersRef.current[0].notify, false);
  c.setNotifyForMany([all.id, timed.id, unknown.id], true);
  assert.deepEqual(c.markersRef.current.map(m => m.notify), [false, true, true]);
  assert.equal(c.markersRef.current.filter(c.canNotifyMarker).every(m => m.notify), true);

  // Exercise the real catalogue merge in both directions, with generated notes.
  c.useEffect = fn => fn(); c.hydrated = true; c.remoteFishStatus = 'ready';
  c.normalizeRemoteFish = rows => rows; c.isBlockedFishEntry = () => false;
  c.fishAppearsToWindow = () => ({ hour: 0, minute: 0, hasRange: false });
  vm.runInContext(ts.transpile(nodes.get('buildFishNotes').getText(tree), { target: ts.ScriptTarget.ES2020 }), c);
  const mergeStart = source.indexOf('useEffect(() => {', source.indexOf('// SECTION 12.X) Sync remote fish'));
  const mergeEnd = source.indexOf('}, [hydrated, remoteFishStatus, remoteFish]);', mergeStart) + '}, [hydrated, remoteFishStatus, remoteFish]);'.length;
  function merge(appears) {
    c.remoteFish = [{ id: 'timed', title: 'Timed', appears }];
    vm.runInContext(ts.transpile(source.slice(mergeStart, mergeEnd), { target: ts.ScriptTarget.ES2020 }), c);
  }
  c.markersRef.current = [timed]; merge('Any Time'); assert.equal(c.markersRef.current[0].notify, false);
  merge('Night'); assert.equal(c.markersRef.current[0].notify, false);
  assert.equal(c.markersRef.current[0].enabled, true);
  c.toggleNotify('fish_timed'); assert.equal(c.markersRef.current[0].notify, true);

  // Native and web source inputs and snapshot expectations all use the safeguard.
  assert.equal((source.match(/filter\(\(m\) => m.enabled && m.notify && canNotifyMarker\(m\)\)/g) || []).length, 3);
  c = setup(); c.Platform.OS = 'web'; c.markersRef.current = [all, timed];
  c.webTimerIdsRef = { current: [] }; const webNames = [];
  c.clearTimeout = () => {};
  c.ensureWebNotificationPermission = async () => ({ ok: true });
  c.getMsUntilNextPaliaTime = () => 60000;
  c.buildGroupNotificationText = group => { webNames.push(...group.markers.map(m => m.id)); return { title: 'test', body: 'test' }; };
  c.setTimeout = () => 1;
  await c.resyncTimeNotifications();
  assert.ok(webNames.length > 0); assert.ok(webNames.every(id => id === timed.id));
  c = setup(); const event = { ...timed, id: 'default_midnight', name: 'Event' };
  c.markersRef.current = [all, timed, event];
  c.pending = [{ identifier: 'old-mixed', content: { data: { type: 'time_group' } } }];
  assert.equal(await c.resyncTimeNotifications(), true);
  assert.deepEqual(c.scheduledMembers.sort(), [event.id, timed.id].sort());
  assert.ok(c.operations.indexOf('cancel:old-mixed') < c.operations.indexOf('schedule'));
  // Incomplete Android metadata must not strand old requests beside readable groups.
  c.pending.push({ identifier: 'unknown-old', content: {} });
  await c.resyncTimeNotifications(); assert.ok(c.operations.includes('cancel-all'));

  for (const check of [async () => ({ ok: false }), async () => { throw Error('permission check failed'); }]) {
    c = setup(); c.markersRef.current = [all, timed];
    c.pending = [{ identifier: 'old', content: { data: { type: 'time_group' } } }];
    c.ensurePermission = check;
    assert.equal(await c.resyncTimeNotifications(), false);
    assert.equal(c.pending.length, 0); assert.equal(c.scheduledMembers.length, 0);
    assert.match(c.warnings[0][0], /permission check failed/);
  }
  c = setup(); c.markersRef.current = [all, timed]; c.pending = [{ identifier: 'old', content: {} }];
  c.Notifications.cancelAllScheduledNotificationsAsync = async () => { throw Error('cancel failed'); };
  assert.equal(await c.resyncTimeNotifications(), false);
  assert.equal(c.scheduledMembers.length, 0); assert.match(c.warnings[0][0], /cancel existing failed/);

  // An old pass may finish, but a queued eligibility update cleans it before completion.
  c = setup(); const blocked = deferred(); let passes = 0;
  c.markersRef.current = [timed];
  const schedule = c.scheduleTimeGroupOccurrences;
  c.scheduleTimeGroupOccurrences = async args => { if (++passes === 1) await blocked.promise; return schedule(args); };
  const first = c.resyncTimeNotifications(); await tick();
  c.markersRef.current = [all]; const second = c.resyncTimeNotifications();
  blocked.resolve(); await Promise.all([first, second]); assert.equal(c.pending.length, 0);
  assert.equal(c.resyncGateRef.current.inFlight, false);
  console.log('PASS: strict Fish classification, six UI guards, migration/restart, bulk eligibility, catalogue transitions, native/web/snapshot exclusions, mixed groups, permission/cancellation failures and queued eligibility changes');
})().catch(error => { console.error(error); process.exitCode = 1; });
