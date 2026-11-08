// Exercise the actual screen callbacks with controlled native/storage promises.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const source = fs.readFileSync('app/(tabs)/index.tsx', 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function callback(name) {
  const start = source.indexOf(`  const ${name} = useCallback(`);
  const end = source.indexOf('\n  }, [', start);
  return source.slice(start, source.indexOf('\n', end + 1));
}
function setup(enabled = true) {
  const c = {
    useCallback: fn => fn, Platform: { OS: 'android' }, __DEV__: false, console: { warn() {} },
    resetInProgressRef: { current: false }, notificationRequestGenerationRef: { current: 0 },
    hydrated: true, caughtFishWriteRef: { current: Promise.resolve() }, caughtFish: {},
    markersWriteRef: { current: Promise.resolve() }, notificationPrefsWriteRef: { current: Promise.resolve() },
    nextCountWriteRef: { current: Promise.resolve() }, nextCountLoadGenerationRef: { current: 0 }, resetMarkersRef: { current: null },
    diagnosticsWriteRef: { current: Promise.resolve() },
    notifEnabledRef: { current: enabled }, markersRef: { current: [{ enabled: true, notify: true }] },
    reminderRef: { current: 0 }, webTimerIdsRef: { current: [] },
    resyncGateRef: { current: { inFlight: false, queued: false, lastAt: 0, completion: null } },
    groupEnabledMarkersByTime: m => m, ensurePermission: async () => ({ ok: true }),
    scheduled: [], errors: [], writes: [], resets: 0, success: false,
    DEFAULT_MARKERS: [], errMsg: e => e.message, clearTimeout,
  };
  for (const key of ['STORAGE_MARKERS', 'STORAGE_REPEATABLE_NOTIF_DEFAULTED', 'STORAGE_NOTIF_PREFS', 'STORAGE_NOTIF_DEFAULTED', 'NEXT_TIME_COUNT_KEY', 'HELP_DIAGNOSTICS_OPTIN_KEY', 'CLOSED_TEST_POPUP_SEEN_KEY']) c[key] = key;
  for (const name of ['setNotifEnabled', 'setReminderLeadSeconds', 'setNextTimeCount', 'setHelpIncludeDiagnostics', 'setClosedTestOpen']) c[name] = () => {};
  for (const name of ['ClockViewMode', 'NextTimeFilter', 'NowSectionOpen', 'NextSectionOpen', 'AllDaySectionOpen', 'DefaultMarkersOpen', 'CustomMarkersOpen', 'RepeatableMarkersOpen', 'FishMarkersOpen', 'ExpandedNextNotesId', 'ExpandedNowNotesId', 'ExpandedEventNotesId', 'NextTimeCount', 'ReminderLeadSeconds']) {
    c['set' + name] = value => { c[name] = value; };
  }
  c.markers = [];
  c.STORAGE_CAUGHT_FISH = 'STORAGE_CAUGHT_FISH';
  c.setCaughtFish = update => { c.caughtFish = typeof update === 'function' ? update(c.caughtFish) : update; };
  c.useEffect = fn => fn();
  c.setMarkers = update => {
    c.resets++;
    c.markers = typeof update === 'function' ? update(c.markers) : update;
    queueMicrotask(() => runEffect(c, '// SECTION 13.1) Persist markers', '}, [hydrated, markers]);'));
  };
  c.setShowResetConfirm = () => { c.success = true; };
  c.Alert = { alert: (...args) => c.errors.push(args) };
  c.AsyncStorage = { setItem: async (k, v) => { c.writes.push([k, v]); }, multiRemove: async () => {} };
  c.Notifications = {
    cancelAllScheduledNotificationsAsync: async () => { c.scheduled = []; },
    getAllScheduledNotificationsAsync: async () => [],
  };
  c.scheduleTimeGroupOccurrences = async () => { c.scheduled.push('request'); return ['request']; };
  vm.createContext(c);
  const helpers = ts.createSourceFile('screen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set(['parseFishSchedule', 'isUnconfirmedFish', 'fishFieldLabel', 'fishAppearsToPeriodsFlags', 'fishAppearsIsAnyTime', 'extractFishFieldFromNotes', 'isAllDayFish', 'canNotifyMarker']);
  function loadHelper(node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)) {
      vm.runInContext(ts.transpile(node.getText(helpers), { target: ts.ScriptTarget.ES2020 }), c);
    }
    ts.forEachChild(node, loadHelper);
  }
  loadHelper(helpers);
  const code = ['resyncTimeNotifications', 'toggleNotifications', 'performReset', 'toggleCaughtStandard', 'toggleCaughtStar'].map(callback).join('\n') + '\nthis.api = {resyncTimeNotifications, toggleNotifications, performReset, toggleCaughtStandard, toggleCaughtStar};';
  vm.runInContext(ts.transpile(code, { target: ts.ScriptTarget.ES2020 }), c);
  return c;
}
function runEffect(context, label, endText) {
  const start = source.indexOf('  useEffect(() => {', source.indexOf(label));
  const end = source.indexOf(endText, start) + endText.length;
  vm.runInContext(ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2020 }), context);
}
(async () => {
  // Active group completes after reset starts; final cancellation must follow it.
  let c = setup(); const scheduling = deferred();
  c.scheduleTimeGroupOccurrences = async () => { await scheduling.promise; c.scheduled.push('late'); return ['late']; };
  const active = c.api.resyncTimeNotifications(); await tick();
  const reset = c.api.performReset(); assert.equal(c.notifEnabledRef.current, false);
  await tick(); assert.equal(c.success, false);
  scheduling.resolve(); await Promise.all([active, reset]);
  assert.equal(c.scheduled.length, 0); assert.equal(c.success, true);

  // Storage is pending: foreground/tap calls remain OFF, duplicate reset is ignored.
  c = setup(); const storage = deferred(); let removals = 0;
  c.AsyncStorage.multiRemove = async () => { removals++; await storage.promise; };
  const pending = c.api.performReset(); await tick();
  await c.api.performReset(); await c.api.resyncTimeNotifications(); await c.api.resyncTimeNotifications();
  await c.api.toggleNotifications();
  assert.equal(removals, 1); assert.equal(c.success, false); assert.equal(c.scheduled.length, 0);
  storage.resolve(); await pending; assert.equal(c.resets, 1);

  // Native failure remains OFF, reports failure, preserves reset data for retry.
  c = setup(); c.Notifications.cancelAllScheduledNotificationsAsync = async () => { throw Error('native failure'); };
  await c.api.performReset(); assert.equal(c.success, false); assert.equal(c.errors.length, 1);
  assert.equal(c.notifEnabledRef.current, false); assert.equal(c.resets, 0);
  c.Notifications.cancelAllScheduledNotificationsAsync = async () => { c.scheduled = []; };
  await c.api.performReset(); assert.equal(c.success, true);

  // Pending permission cannot enable after reset; a new user request still can.
  c = setup(false); const permission = deferred();
  c.ensurePermission = () => permission.promise;
  const enabling = c.api.toggleNotifications(); await c.api.performReset();
  permission.resolve({ ok: true }); await enabling;
  assert.equal(c.notifEnabledRef.current, false); assert.equal(c.scheduled.length, 0);
  c.ensurePermission = async () => ({ ok: true });
  await c.api.toggleNotifications(); assert.equal(c.notifEnabledRef.current, true);
  assert.ok(c.scheduled.length > 0);

  // Already OFF and delayed durable preference write: no early success.
  c = setup(false); const durable = deferred(); let writes = 0;
  c.AsyncStorage.setItem = async () => { if (++writes === 2) await durable.promise; };
  const offReset = c.api.performReset(); await tick(); assert.equal(c.success, false);
  durable.resolve(); await offReset; assert.equal(c.success, true); assert.equal(c.scheduled.length, 0);
  console.log('PASS: eight required reset orderings, cancellation retry, and awaited preference persistence');

  // Use the real Event defaults and Fish merge effect, without network or React.
  function fishSetup() {
    const context = setup();
    for (const name of ['BASE_DEFAULT_MARKERS', 'BASE_REPEATABLE_MARKERS']) {
      const start = source.indexOf(`const ${name}:`);
      const end = source.indexOf('];', start) + 2;
      vm.runInContext(ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2020 }), context);
    }
    vm.runInContext('DEFAULT_MARKERS = [...BASE_DEFAULT_MARKERS, ...BASE_REPEATABLE_MARKERS];', context);
    context.hydrated = true;
    context.remoteFishStatus = 'ready';
    context.useEffect = fn => fn();
    context.normalizeRemoteFish = value => value;
    context.isBlockedFishEntry = () => false;
    context.fishAppearsToWindow = () => ({ hour: 0, minute: 0, hasRange: false });
    context.buildFishNotes = fish => `Appears: ${fish.appears}`;
    context.console.log = () => {};
    return context;
  }
  function mergeFish(context) {
    const start = source.indexOf('useEffect(() => {', source.indexOf('// SECTION 12.X) Sync remote fish'));
    const endText = '}, [hydrated, remoteFishStatus, remoteFish]);';
    const end = source.indexOf(endText, start) + endText.length;
    vm.runInContext(ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2020 }), context);
  }
  const enabledFish = Object.freeze({ id: 'fish_one', name: 'One', enabled: true, notify: true, hour: 6, minute: 0, notes: 'Appears: Morning', imageUrl: 'local-test' });
  const disabledFish = Object.freeze({ id: 'fish_two', name: 'Two', enabled: false, notify: false, hour: 0, minute: 0, notes: 'Appears: Any Time' });
  c = fishSetup();
  c.markers = [{ id: 'custom_event' }, { ...c.DEFAULT_MARKERS[0], enabled: false }, enabledFish, disabledFish];
  const caught = { fish_one: { standard: true, star: true }, fish_two: { standard: true, star: true } };
  c.caughtFish = caught;
  let removedKeys;
  c.AsyncStorage.multiRemove = async keys => { removedKeys = [...keys]; };
  await c.api.performReset();
  assert.equal(c.success, true);
  assert.equal(c.markers.length, c.DEFAULT_MARKERS.length + 2);
  for (const marker of c.DEFAULT_MARKERS) {
    assert.equal(c.markers.filter(m => m.id === marker.id).length, 1);
    assert.equal(JSON.stringify(c.markers.find(m => m.id === marker.id)), JSON.stringify({ ...marker, notify: false }));
  }
  assert.equal(c.markers.some(m => m.id === 'custom_event'), false);
  assert.equal(JSON.stringify(c.markers.find(m => m.id === enabledFish.id)), JSON.stringify({ ...enabledFish, notify: false }));
  assert.equal(JSON.stringify(c.markers.find(m => m.id === disabledFish.id)), JSON.stringify({ ...disabledFish, notify: false }));
  assert.equal(JSON.stringify(c.caughtFish), '{}');
  assert.ok(c.writes.some(([key, value]) => key === c.STORAGE_CAUGHT_FISH && value === '{}'));
  assert.equal(removedKeys.some(k => /CAUGHT|REMOTE_FISH|TEXT_SIZE/.test(k)), false);
  assert.equal(c.notifEnabledRef.current, false);
  assert.equal(c.scheduled.length, 0);
  // Existing view inputs still contain enabled Fish immediately, even offline.
  assert.ok(c.markers.some(m => m.id === enabledFish.id && m.enabled));
  assert.ok(c.markers.every(m => m.notify === false));
  assert.equal(c.NextTimeCount, 1);
  assert.equal(c.ClockViewMode, 'events');
  assert.equal(c.NextTimeFilter, null);
  for (const section of ['Now', 'Next', 'AllDay']) {
    assert.equal(c[section + 'SectionOpen'], true);
  }
  for (const folder of ['DefaultMarkers', 'CustomMarkers', 'RepeatableMarkers', 'FishMarkers']) {
    assert.equal(c[folder + 'Open'], false);
  }
  assert.ok(c.writes.some(([key, value]) => key === c.NEXT_TIME_COUNT_KEY && value === '1'));
  assert.ok(c.writes.some(([key, value]) => key === c.STORAGE_NOTIF_DEFAULTED && value === '1'));
  assert.ok(c.writes.some(([key, value]) => key === c.STORAGE_REPEATABLE_NOTIF_DEFAULTED && value === '1'));
  await c.api.performReset();
  assert.equal(c.markers.length, c.DEFAULT_MARKERS.length + 2);

  // Catalogue arrives before, during or after reset; exercise the actual merge.
  for (const arrival of ['before', 'during', 'after']) {
    c = fishSetup(); c.remoteFish = [{ id: 'loaded', title: 'Loaded', appears: 'Any Time' }];
    const gate = deferred();
    c.AsyncStorage.multiRemove = () => gate.promise;
    if (arrival === 'before') mergeFish(c);
    const operation = c.api.performReset(); await tick();
    if (arrival === 'during') mergeFish(c);
    gate.resolve(); await operation;
    if (arrival === 'after') mergeFish(c);
    assert.equal(c.markers.filter(m => m.id === 'fish_loaded').length, 1);
    assert.equal(c.markers.find(m => m.id === 'fish_loaded').enabled, false);
    assert.equal(c.notifEnabledRef.current, false);
    assert.equal(c.scheduled.length, 0);
  }
  console.log('PASS: Fish identity/preferences, disabled Fish, Event defaults/custom removal, caught/cache scope, offline retention and catalogue arrival orderings');

  // Execute the actual caught-progress persistence effect on simulated renders.
  function persistCaught(context) {
    const start = source.indexOf('  useEffect(() => {', source.indexOf('// SECTION 13.2) Persist caught fish'));
    const endText = '}, [hydrated, caughtFish]);';
    const end = source.indexOf(endText, start) + endText.length;
    vm.runInContext(ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2020 }), context);
  }
  c = setup(); c.caughtFish = caught;
  const oldWrite = deferred(), emptyWrite = deferred(); let stored = null; let emptyStarted = false;
  c.AsyncStorage.setItem = async (key, value) => {
    if (key !== c.STORAGE_CAUGHT_FISH) return;
    if (value !== '{}') await oldWrite.promise;
    else { emptyStarted = true; await emptyWrite.promise; }
    stored = value;
  };
  persistCaught(c); await tick();
  const caughtReset = c.api.performReset(); await tick();
  assert.equal(emptyStarted, false); assert.equal(c.success, false);
  c.api.toggleCaughtStandard('fish_new'); c.api.toggleCaughtStar('fish_new');
  assert.equal(c.caughtFish, caught);
  persistCaught(c); // Reset guard prevents another stale write.
  oldWrite.resolve(); await tick();
  assert.equal(emptyStarted, true); assert.equal(c.success, false);
  emptyWrite.resolve(); await caughtReset;
  assert.equal(stored, '{}'); assert.equal(JSON.stringify(c.caughtFish), '{}');
  c.api.toggleCaughtStandard('fish_new'); c.api.toggleCaughtStar('fish_new');
  persistCaught(c); await c.caughtFishWriteRef.current;
  assert.equal(JSON.parse(stored).fish_new.standard, true);
  assert.equal(JSON.parse(stored).fish_new.star, true);

  c = setup(); c.caughtFish = caught; let failCaught = true;
  c.AsyncStorage.setItem = async key => { if (key === c.STORAGE_CAUGHT_FISH && failCaught) throw Error('caught storage failed'); };
  await c.api.performReset();
  assert.equal(c.success, false); assert.equal(c.errors.length, 1);
  assert.equal(c.notifEnabledRef.current, false); assert.equal(c.caughtFish, caught);
  failCaught = false; await c.api.performReset();
  assert.equal(c.success, true); assert.equal(JSON.stringify(c.caughtFish), '{}');

  c = setup(); c.hydrated = false;
  await c.api.performReset(); assert.equal(c.success, false); assert.equal(c.writes.length, 0);
  // Launch hydration finishes before reset is allowed to clear its loaded map.
  c.setCaughtFish(caught); c.hydrated = true;
  await c.api.performReset(); assert.equal(c.success, true); assert.equal(JSON.stringify(c.caughtFish), '{}');
  console.log('PASS: caught write ordering, awaited empty write, toggle blocking, new catches, failure/retry and hydration guard');

  // Required reset writes must wait for old writes and must report failures.
  for (const [ref, key] of [['markersWriteRef', 'STORAGE_MARKERS'], ['notificationPrefsWriteRef', 'STORAGE_NOTIF_PREFS'], ['nextCountWriteRef', 'NEXT_TIME_COUNT_KEY']]) {
    c = setup(); const older = deferred(); let value = 'old';
    c[ref].current = older.promise.then(() => { value = 'stale'; });
    c.AsyncStorage.setItem = async (k, v) => { if (k === c[key]) value = v; };
    const operation = c.api.performReset(); await tick(); assert.equal(c.success, false);
    older.resolve(); await operation;
    assert.equal(c.success, true); assert.notEqual(value, 'stale');
  }
  for (const key of ['STORAGE_MARKERS', 'STORAGE_NOTIF_PREFS', 'NEXT_TIME_COUNT_KEY']) {
    c = setup(); let fail = true;
    c.AsyncStorage.setItem = async k => { if (k === c[key] && fail) throw Error('required persistence failure'); };
    await c.api.performReset(); assert.equal(c.success, false); assert.equal(c.errors.length, 1);
    assert.equal(c.notifEnabledRef.current, false);
    fail = false; await c.api.performReset(); assert.equal(c.success, true);
  }

  // A late count hydration read must not undo explicit reset or write old values.
  c = setup(); const countRead = deferred();
  c.AsyncStorage.getItem = () => countRead.promise;
  runEffect(c, 'const [expandedNowNotesId', '}, []);');
  await c.api.performReset(); countRead.resolve('3'); await tick();
  assert.equal(c.NextTimeCount, 1);

  // Persist/rehydrate actual preference transformations, including one-time flags.
  c = fishSetup(); c.markers = [enabledFish, disabledFish];
  const saved = new Map();
  c.AsyncStorage.setItem = async (k, v) => saved.set(k, v);
  c.AsyncStorage.getItem = async k => saved.get(k) ?? null;
  c.AsyncStorage.multiRemove = async keys => keys.forEach(k => saved.delete(k));
  await c.api.performReset(); assert.ok(c.markers.every(m => !m.notify));
  assert.equal(c.ReminderLeadSeconds, 0);
  for (const name of ['ExpandedNextNotesId', 'ExpandedNowNotesId', 'ExpandedEventNotesId']) assert.equal(c[name], null);
  c.NextTimeCount = 2;
  runEffect(c, 'const [expandedNowNotesId', '}, []);');
  await tick(); assert.equal(c.NextTimeCount, 1);
  assert.match(source, /\[clockViewMode, setClockViewMode\] = useState<"events" \| "fish">\("events"\)/);
  c.groupEnabledMarkersByTime = markers => markers;
  c.markersRef.current = c.markers;
  await c.api.toggleNotifications(); assert.equal(c.scheduled.length, 0);
  const defaultId = c.markers.find(m => m.id.startsWith('default_')).id;
  const repeatId = c.markers.find(m => m.id.startsWith('repeat_')).id;
  c.markers = c.markers.map(m => [enabledFish.id, defaultId, repeatId].includes(m.id) ? { ...m, enabled: true, notify: true } : m);
  c.markersRef.current = c.markers;
  runEffect(c, '// SECTION 13.1) Persist markers', '}, [hydrated, markers]);');
  c.notifEnabled = true; c.reminderLeadSeconds = 30;
  runEffect(c, '// SECTION 13.3) Persist notification prefs', '}, [hydrated, notifEnabled, reminderLeadSeconds]);');
  await Promise.all([c.markersWriteRef.current, c.notificationPrefsWriteRef.current]);
  const restored = JSON.parse(saved.get(c.STORAGE_MARKERS));
  for (const id of [enabledFish.id, defaultId, repeatId]) assert.equal(restored.find(m => m.id === id).notify, true);
  assert.equal(JSON.parse(saved.get(c.STORAGE_NOTIF_PREFS)).enabled, true);
  assert.equal(saved.get(c.STORAGE_NOTIF_DEFAULTED), '1');
  assert.equal(saved.get(c.STORAGE_REPEATABLE_NOTIF_DEFAULTED), '1');
  // Real default-normalisation helpers preserve these choices on ordinary launch.
  for (const [startText, endText] of [['const REPEATABLE_CANON_BY_ID', '// Legacy defaults']]) {
    const start = source.indexOf(startText), end = source.indexOf(endText, start);
    vm.runInContext(ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2020 }), c);
  }
  c.restored = restored;
  vm.runInContext('restored = ensureDefaultDefaults(ensureRepeatableDefaults(restored));', c);
  for (const id of [enabledFish.id, defaultId, repeatId]) assert.equal(c.restored.find(m => m.id === id).notify, true);
  c.markers = c.restored; c.markersRef.current = c.markers;
  c.remoteFish = [{ id: 'one', title: 'One', appears: 'Morning' }, { id: 'two', title: 'Two', appears: 'Any Time' }];
  mergeFish(c); assert.equal(c.markers.find(m => m.id === enabledFish.id).notify, true);
  c.markersRef.current = c.markers;
  await c.api.toggleNotifications(); assert.equal(c.notifEnabledRef.current, false);
  assert.equal(c.markers.find(m => m.id === enabledFish.id).notify, true);
  await c.api.toggleNotifications(); assert.ok(c.scheduled.length > 0);
  assert.ok(c.markers.filter(m => m.notify).every(m => [enabledFish.id, defaultId, repeatId].includes(m.id)));
  await c.api.performReset(); assert.ok(c.markers.every(m => !m.notify));
  assert.equal(c.notifEnabledRef.current, false); assert.equal(c.scheduled.length, 0);
  console.log('PASS: required persistence waits/failures, stale count hydration, reset-only muting, startup normalisation, catalogue merge and master OFF/ON bell persistence');
  c = fishSetup(); c.remoteFish = [{ id: 'batched', title: 'Batched', appears: 'Any Time' }];
  const originalSetMarkers = c.setMarkers; let merged = false;
  c.setMarkers = update => {
    originalSetMarkers(update);
    if (c.resetMarkersRef.current?.target && !merged) { merged = true; mergeFish(c); }
  };
  await c.api.performReset();
  assert.equal(c.success, true); assert.equal(c.markers.find(m => m.id === 'fish_batched').notify, false);
  console.log('PASS: catalogue merge batched after reset updater persists without waiting for an intermediate render');
})().catch(error => { console.error(error); process.exitCode = 1; });
