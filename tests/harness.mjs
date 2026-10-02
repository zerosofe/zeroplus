// مشترك: استخراج سكربت index.html وتشغيله في DOM وهمي
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createMockSupabase, TABLE_COLUMNS } from './mock-supabase.mjs';

export const ROOT = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ---------- استخراج سكربت التطبيق ----------
const marker = '// ============ 1. GLOBAL STATE';
const mIdx = html.indexOf(marker);
assert.ok(mIdx > 0, 'لم يتم العثور على سكربت التطبيق');
const scriptStart = html.lastIndexOf('<script>', mIdx) + '<script>'.length;
const scriptEnd = html.indexOf('</script>', mIdx);
const code = html.slice(scriptStart, scriptEnd);
assert.ok(code.length > 5000, 'سكربت التطبيق صغير بشكل غير متوقع');

// فحص صياغة JavaScript قبل التشغيل
new vm.Script(code, { filename: 'index-inline.js' });

// ---------- بيئة وهمية ----------
// نجمع كل المؤقّتات المفتوحة حتى يستطيع مُشغّل الاختبارات إغلاقها قبل الخروج
const allPendingTimers = new Set();
export function clearHarnessTimers() {
  allPendingTimers.forEach((id) => clearTimeout(id));
  allPendingTimers.clear();
}

export function createHarness() {
  const nodes = new Map();
  const makeNode = (id) => {
    const node = {
      id, className: '', innerHTML: '', innerText: '', textContent: '', title: '', src: '', value: '',
      files: [], style: {}, checked: false, open: false, disabled: false,
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
      querySelector() { return makeNode(id + ':child'); },
      appendChild() {}, remove() {}, focus() {}, scrollIntoView() {}, select() {},
    };
    return node;
  };
  const getNode = (id) => { if (!nodes.has(id)) nodes.set(id, makeNode(id)); return nodes.get(id); };

  const documentListeners = {};
  const windowListeners = {};
  const alerts = [];
  const notifications = [];          // كل إشعار أُرسل (عبر SW أو مباشرة)
  const swMessages = [];             // رسائل الصفحة للخدمة الخلفية
  const pendingTimers = new Set();
  const trackedSetTimeout = (cb, ms, ...args) => {
    const id = setTimeout(() => { pendingTimers.delete(id); allPendingTimers.delete(id); cb(...args); }, ms, ...args);
    pendingTimers.add(id); allPendingTimers.add(id);
    return id;
  };
  const trackedClearTimeout = (id) => { pendingTimers.delete(id); allPendingTimers.delete(id); clearTimeout(id); };

  // Notification API وهمية قابلة للتحكم من الاختبار
  class NotificationMock {
    constructor(title, opts) { notifications.push({ title, opts: opts || {}, direct: true }); }
    static permission = 'default';
    static requestPermission() { return Promise.resolve(NotificationMock.permission); }
    static addEventListener() {}
  }
  // Service Worker وهمي: controller للرسائل + ready.showNotification
  const serviceWorkerMock = {
    controller: { postMessage: (m) => swMessages.push(m) },
    ready: Promise.resolve({ showNotification: (title, opts) => { notifications.push({ title, opts: opts || {}, viaSW: true }); return Promise.resolve(); } }),
    register: () => Promise.resolve({ update() {} }),
    getRegistrations: () => Promise.resolve([]),
    addEventListener: () => {},
  };
  // Clipboard وهمي (ينجح افتراضياً، ويمكن إجباره على الفشل)
  const clipboardMock = {
    fail: false,
    lastText: null,
    writeText(text) {
      clipboardMock.lastText = text;
      return clipboardMock.fail ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve();
    },
  };
  const confirmations = [];
  let confirmAnswer = true;

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      if (localStorage.failKeys && localStorage.failKeys.includes(k)) {
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
      store.set(k, String(v));
    },
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
    failKeys: [],
    _dump: () => Object.fromEntries(store),
  };

  const supabaseMock = createMockSupabase();
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    localStorage,
    navigator: { onLine: true, userAgent: 'test', serviceWorker: serviceWorkerMock, clipboard: clipboardMock, wakeLock: undefined },
    document: {
      documentElement: { classList: (() => {
        const s = new Set();
        return { _s: s, add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c) };
      })() },
      visibilityState: 'visible',
      getElementById: getNode,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (tag) => {
        if (tag === 'canvas') {
          return { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,COMPRESSED' };
        }
        return makeNode(tag);
      },
      addEventListener: (ev, cb) => { (documentListeners[ev] ||= []).push(cb); },
      body: { appendChild() {}, style: {} },
    },
    window: null,
    location: { origin: 'https://test.local', href: 'https://test.local/', reload() { sandbox.__reloaded = (sandbox.__reloaded || 0) + 1; } },
    alert: (msg) => alerts.push(String(msg)),
    confirm: (msg) => { confirmations.push(String(msg)); return confirmAnswer; },
    Notification: NotificationMock,
    setTimeout: trackedSetTimeout, clearTimeout: trackedClearTimeout, setInterval: () => 0, clearInterval() {},
    TextEncoder, TextDecoder, crypto: webcrypto, Promise, Map, Set, Date, JSON, Math, Number, String, Array, Object, Error, RegExp,
    AudioContext: undefined,
    Image: class { constructor() { this.onload = null; this.onerror = null; } set src(v) { this._src = v; setTimeout(() => this.onload && this.onload(), 0); } },
    FileReader: class {
      constructor() { this.onload = null; this.onerror = null; }
      readAsDataURL() { setTimeout(() => this.onload && this.onload({ target: { result: 'data:image/png;base64,RAW' } }), 0); }
    },
    supabase: { createClient: () => supabaseMock },
    __nodes: nodes,
    __notifications: notifications,
    __swMessages: swMessages,
    __clipboard: clipboardMock,
    __pendingTimers: pendingTimers,
    __alerts: alerts,
    __confirmations: confirmations,
    __documentListeners: documentListeners,
    __windowListeners: windowListeners,
    __setConfirm: (v) => { confirmAnswer = v; },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.addEventListener = (ev, cb) => { (windowListeners[ev] ||= []).push(cb); };
  sandbox.removeEventListener = () => {};
  const epilogue = `
;globalThis.__api = {
  get userXP(){ return userXP; }, set userXP(v){ userXP = v; },
  get totalFocusMins(){ return totalFocusMins; }, set totalFocusMins(v){ totalFocusMins = v; },
  get tasks(){ return tasks; }, set tasks(v){ tasks = v; },
  get userForest(){ return userForest; }, set userForest(v){ userForest = v; },
  get lastSyncError(){ return lastSyncError; },
  get pendingCount(){ return pendingSyncCount(); },
  get currentUserName(){ return currentUserName; },
  get pomoRunning(){ return pomoRunning; },
  get pomoEndTimestamp(){ return pomoEndTimestamp; }, set pomoEndTimestamp(v){ pomoEndTimestamp = v; },
  get activeTabId(){ return activeTabId; },
  get currentPomoMins(){ return currentPomoMins; }
};`;
  vm.createContext(sandbox);
  vm.runInContext(code + epilogue, sandbox, { filename: 'index-inline.js' });
  return { sandbox, supabaseMock, localStorage, nodes, getNode, alerts, confirmations };
}

