// Exercise the real local Back action and focus subscription with controlled hooks.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const source = fs.readFileSync('app/(tabs)/index.tsx', 'utf8');
const tree = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
function visit(n) {
  if ((ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) && n.name && ts.isIdentifier(n.name)) declarations.set(n.name.text, n);
  ts.forEachChild(n, visit);
}
visit(tree);
const listeners = new Set(), refs = [];
let refIndex = 0, focus, layout;
const pickers = ['hourPickerOpen', 'minutePickerOpen', 'endHourPickerOpen', 'endMinutePickerOpen', 'locationPickerOpen', 'folderPickerOpen'];
const c = {
  Platform: { OS: 'android' }, screen: 'home', addMarkerOpen: false, editingId: null,
  useRef: value => refs[refIndex++] || (refs[refIndex - 1] = { current: value }),
  useCallback: fn => fn, useLayoutEffect: fn => { layout = fn; }, useFocusEffect: fn => { focus = fn; },
  BackHandler: { addEventListener: (name, fn) => {
    assert.equal(name, 'hardwareBackPress'); listeners.add(fn);
    return { remove: () => listeners.delete(fn) };
  } },
  closeMenu: () => {}, requestAnimationFrame: fn => fn(),
};
for (const picker of pickers) c[picker] = false;
for (const name of source.matchAll(/\b(set[A-Z]\w*)\(/g)) {
  const setter = name[1], state = setter[3].toLowerCase() + setter.slice(4);
  c[setter] = value => { c[state] = value; };
}
vm.createContext(c);
function run(text) { vm.runInContext(ts.transpile(text, { target: ts.ScriptTarget.ES2020 }), c); }
run(declarations.get('resetForm').getText(tree));
run('this.goToHome = ' + declarations.get('goToHome').initializer.getText(tree));
const start = source.indexOf('  const androidBackActionRef =');
const end = source.indexOf('  // Folder open/close:', start);
const block = source.slice(start, end).replace('const androidBackActionRef =', 'this.androidBackActionRef =');
function render() { refIndex = 0; run(block); layout(); }
function press() { assert.equal(listeners.size, 1); return [...listeners][0](); }
render(); let cleanup = focus();
assert.equal(press(), false); assert.equal(c.screen, 'home');
c.screen = 'marker_setup'; render();
assert.equal(press(), true); assert.equal(c.screen, 'home');
for (const picker of pickers) {
  c.screen = 'marker_setup'; c.addMarkerOpen = true; c[picker] = true; render();
  assert.equal(press(), true);
  assert.ok(pickers.every(p => c[p] === false));
  assert.equal(c.screen, 'marker_setup'); assert.equal(c.addMarkerOpen, true);
  render(); assert.equal(press(), true);
  assert.equal(c.addMarkerOpen, false); assert.equal(c.screen, 'marker_setup');
  render(); assert.equal(press(), true); assert.equal(c.screen, 'home');
}
c.screen = 'marker_setup'; c.editingId = 'custom_test'; c.newNotes = 'unsaved'; render();
assert.equal(press(), true); assert.equal(c.editingId, null); assert.equal(c.newNotes, '');
assert.equal(c.screen, 'marker_setup');
cleanup(); assert.equal(listeners.size, 0);
for (let i = 0; i < 20; i++) {
  render(); cleanup = focus(); assert.equal(listeners.size, 1);
  render(); assert.equal(listeners.size, 1); // Render updates action without adding a subscription.
  cleanup(); assert.equal(listeners.size, 0);
}
for (const os of ['ios', 'web']) {
  c.Platform.OS = os; render(); assert.equal(focus(), undefined); assert.equal(listeners.size, 0);
}
assert.ok(!/onRequestClose|setSetupOpen|setMenuVisible/.test(block.replace('// Native Modals retain their own onRequestClose handling.', '')));
console.log('PASS: Home fallthrough, Setup navigation, all six picker priorities, Add/Edit cleanup, fresh state, Android-only focus subscription and repeated blur/unmount cleanup');
