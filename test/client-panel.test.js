// Client panel structural test: loads the real client module, registers its
// settings section against a fake client graph, and renders the section with
// a minimal React-compatible dispatcher. Any ReferenceError/TypeError inside
// a component body — the class of bug that renders an empty section — fails
// this test. With REMOTE_SESSIONS_REACT_ROOT set, the real react is used
// instead (renderToString) for a full-fidelity render.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

function miniReact() {
  // Single-pass hooks dispatcher: enough to execute every component body once.
  let hooks = [], cursor = 0;
  const createElement = (type, props, ...children) => ({ type, props: { ...(props ?? {}) }, children: children.flat() });
  const react = {
    createElement,
    useState(initial) { const index = cursor++; if (hooks[index] === undefined) hooks[index] = [typeof initial === 'function' ? initial() : initial, () => {}]; return hooks[index]; },
    useEffect() { cursor++; },
    useCallback(fn) { cursor++; return fn; },
    useMemo(fn) { const index = cursor++; if (hooks[index] === undefined) hooks[index] = [fn()]; return hooks[index][0]; },
    useRef(value) { const index = cursor++; if (hooks[index] === undefined) hooks[index] = { current: value }; return hooks[index][0] ?? hooks[index]; },
  };
  react.render = function render(element, depth = 0) {
    assert.ok(depth < 200, 'client render descended too deep');
    if (element === null || element === undefined || element === false) return 0;
    if (typeof element === 'string' || typeof element === 'number') return 1;
    if (Array.isArray(element)) return element.reduce((total, item) => total + render(item, depth + 1), 0);
    assert.ok(element && typeof element === 'object' && 'type' in element, `unexpected node ${JSON.stringify(element)}`);
    if (typeof element.type === 'function') {
      cursor = hooks.length; // fresh hooks per component instance
      const before = hooks.length;
      const rendered = element.type(element.props ?? {});
      assert.ok(hooks.length >= before, 'hook state must not shrink');
      return render(rendered, depth + 1) + 1;
    }
    if (typeof element.type === 'string') return (element.children ?? []).reduce((total, item) => total + render(item, depth + 1), 0) + 1;
    return 0;
  };
  return react;
}

function loadClientModule(React, ReactDOM) {
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: entry => { captured = entry; } }, location: { protocol: 'https:' } },
    document: undefined,
    fetch: async () => { throw new Error('no network in client panel test'); },
    console, setTimeout, clearTimeout, Error, TypeError, RangeError, Object, Array, JSON, String, Boolean, Number, Math, Promise, Date, RegExp, Symbol, Proxy, WeakMap, Map, Set,
  };
  sandbox.window.__ModuleLoader__ = sandbox.__ModuleLoader__ = sandbox.window.__ModuleLoader__;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox, { filename: 'client.js' });
  assert.ok(captured, 'the client module must register through window.__ModuleLoader__.load');
  assert.equal(captured.id, 'dsh-remote-sessions', 'the loader id is the package name');
  const exports = captured.factory(specifier => {
    if (specifier === 'react') return React;
    if (specifier === 'react-dom') return ReactDOM;
    throw new Error('unexpected client require: ' + specifier);
  });
  return exports;
}

function fakeClientGraph() {
  const registrations = [];
  const slots = {
    register: (options, component) => { registrations.push({ slot: options.name, options, component }); return () => {}; },
  };
  slots.inject = (name, install) => install();
  return {
    ctx: {
      slots,
      locale: { bind: ns => key => key, register: () => () => {} },
      workspaces: { create: async () => ({ workspaceId: 'w1' }), list: { getSnapshot: () => ({ items: [] }) } },
      sessions: { create: async () => 's1' },
      effect: fn => { fn(); return () => {}; }, // run effects immediately, like a started fiber
    },
    registrations,
  };
}

test('client registers one settings section and renders real content', () => {
  const realRoot = process.env.REMOTE_SESSIONS_REACT_ROOT;
  const React = realRoot ? createRequire(realRoot)('react') : miniReact();
  const ReactDOM = realRoot
    ? { createPortal: null, render: element => createRequire(realRoot)('react-dom/server').renderToString(element) }
    : miniReact();
  const exports = loadClientModule(React, ReactDOM);
  assert.deepEqual([...exports.inject], ['slots', 'locale', 'workspaces', 'sessions']); // vm realm array: copy out
  const graph = fakeClientGraph();
  exports.apply(graph.ctx);
  const registration = graph.registrations.find(entry => entry.slot === 'settings.section');
  assert.ok(registration, 'settings.section must be registered');
  assert.equal(registration.options.id, 'remote-sessions');
  assert.equal(typeof registration.options.order, 'number');
  assert.equal(typeof registration.options.label, 'function');
  const Component = registration.component;
  assert.equal(typeof Component, 'function');
  // The injected locale binding must survive as props.
  const props = registration.options.inject ? registration.options.inject() : {};
  const rendered = ReactDOM.render ? ReactDOM.render(React.createElement(Component, props))
    : (() => { const mini = ReactDOM; return mini.render(React.createElement(Component, props)); })();
  if (realRoot) {
    assert.ok(rendered.length > 500, `the section must render substantial HTML, got ${rendered.length}`);
    assert.ok(rendered.includes('machines.'), 'the machines card renders');
    assert.ok(rendered.includes('workspaces.'), 'the workspaces card renders');
  } else {
    // The first render is the loading skeleton (machines === null); a real
    // tree here means no component threw — the empty-section failure mode.
    assert.ok(rendered > 20, `the section must render a real tree, got ${rendered} nodes`);
  }
  // The post-load branches (data present, load failed) crash-proof check:
  // the fatal "blank section" class lives exactly there, after the first
  // async resolve, which a single-pass render never reaches.
  for (const seeded of [
    { machines: [], workspaces: [] },
    { machines: [{ name: 'dl1', ssh: ['ssh-host'], remoteNode: '/n', socketPath: '/s.sock', remoteCwd: '/' }], workspaces: [{ localPath: '/a', target: 'dl1', remotePath: '/srv/main' }] },
    { machines: false, workspaces: [], loadError: new Error('REQUEST_NOT_ADMITTED') },
    { machines: [{ name: 'old', ssh: ['legacy.invalid'], migrationRequired: true }], workspaces: [] },
  ]) {
    const pass = ReactDOM.render ? ReactDOM.render(React.createElement(Component, { ...props, initialState: seeded }))
      : miniRender(React.createElement(Component, { ...props, initialState: seeded }));
    if (realRoot) assert.ok(String(pass).length > 500, `the loaded branch must render substantial HTML, got ${String(pass).length}`);
    else assert.ok(pass > 20, `the loaded branch must render a real tree, got ${pass} nodes`);
  }

  // Only the settings surface is allowed; the rejected surfaces stay rejected.
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  for (const forbidden of ['slots.inject(\'main\'', 'sidebar.panellist', 'sidebarRight', 'conversation.hero', 'sidebar.workspaces.directoryFlow', 'shell.overlay', 'iframe']) {
    assert.equal(source.includes(forbidden), false, `client must not reference rejected surface ${forbidden}`);
  }
});

test('client dictionary keys stay complete in both locales', () => {
  const React = miniReact(), ReactDOM = miniReact();
  const exports = loadClientModule(React, ReactDOM);
  const graph = fakeClientGraph();
  exports.apply(graph.ctx);
  const captured = {};
  const ctx = {
    ...graph.ctx,
    locale: {
      bind: () => key => key,
      register: (ns, dictionaries) => { captured[ns] = dictionaries; return () => {}; },
    },
  };
  exports.apply(ctx);
  const dictionaries = captured['remote-sessions'];
  assert.ok(dictionaries?.zh && dictionaries?.en, 'both locales must be registered');
  const zh = Object.keys(dictionaries.zh), en = Object.keys(dictionaries.en);
  assert.deepEqual([...zh].sort(), [...en].sort(), 'zh and en keys must match');
});
