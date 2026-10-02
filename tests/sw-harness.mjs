// مشترك: تشغيل sw.js داخل سياق Service Worker وهمي للتحقق من مؤقّت الخلفية
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

export const ROOT = path.resolve(import.meta.dirname, '..');
const swCode = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

// فحص الصياغة قبل التشغيل
new vm.Script(swCode, { filename: 'sw.js' });

export function createSwHarness() {
  const listeners = {};
  const notifications = [];
  const clientMessages = [];
  const pageMessages = [];
  const cacheStore = new Map();
  const timers = [];

  const respond = (body) => ({ _body: String(body), text: () => Promise.resolve(String(body)) });

  const sw = {
    addEventListener: (ev, cb) => { (listeners[ev] ||= []).push(cb); },
    skipWaiting() {},
    registration: {
      showNotification: (title, opts) => { notifications.push({ title, opts: opts || {} }); return Promise.resolve(); },
    },
    clients: {
      matchAll: () => Promise.resolve([{ postMessage: (m) => clientMessages.push(m), focus() {}, navigate() {} }]),
      claim: () => Promise.resolve(),
      openWindow: () => Promise.resolve({}),
    },
    caches: {
      open: () => Promise.resolve({
        addAll: () => Promise.resolve(),
        put: (url, res) => { cacheStore.set(url, res); return Promise.resolve(); },
        match: (url) => Promise.resolve(cacheStore.get(url) || null),
      }),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(true),
    },
    // مؤقّتات يدوية حتى نتحكم بزمن الاختبار بدل الانتظار الحقيقي
    setTimeout: (cb, ms) => { const t = { cb, ms, cancelled: false, id: timers.length + 1 }; timers.push(t); return t.id; },
    clearTimeout: (id) => { const t = timers.find((x) => x.id === id); if (t) t.cancelled = true; },
    setInterval: (cb, ms) => { const t = { cb, ms, cancelled: false, interval: true, id: timers.length + 1 }; timers.push(t); return t.id; },
    clearInterval: (id) => { const t = timers.find((x) => x.id === id); if (t) t.cancelled = true; },
    Response: class { constructor(body) { this._body = String(body); } text() { return Promise.resolve(this._body); } },
    fetch: () => Promise.resolve({ status: 200, type: 'basic', clone() { return this; } }),
    Promise, Date, Math, Number, String, parseInt, Array, Object, JSON,
    console: { log() {}, warn() {}, error() {}, info() {} },
    __listeners: listeners,
    __notifications: notifications,
    __clientMessages: clientMessages,
    __pageMessages: pageMessages,
    __cache: cacheStore,
    __timers: timers,
    __fire: (ev, evt) => { (listeners[ev] || []).forEach((cb) => cb(evt || {})); },
    __message: (data, source) => {
      (listeners['message'] || []).forEach((cb) => cb({
        data,
        source: source || { postMessage: (m) => pageMessages.push(m) },
      }));
    },
    // تشغيل المؤقّتات المستحقة يدوياً
    __runTimers: (onlyActive = true) => {
      timers.filter((t) => !t.cancelled && (!onlyActive || !t.interval)).forEach((t) => { t.cancelled = true; t.cb(); });
    },
    __runWatchdog: () => { timers.filter((t) => !t.cancelled && t.interval).forEach((t) => t.cb()); },
    // هل اعترضت الخدمة الخلفية الطلب (respondWith) أم تركته للمتصفح؟
    __fetchHandled: (url) => {
      let handled = false;
      (listeners['fetch'] || []).forEach((cb) => cb({
        request: { url, method: 'GET' },
        respondWith: () => { handled = true; },
      }));
      return handled;
    },
  };

  sw.self = sw;   // sw.js يشير إلى نفسه عبر self
  vm.createContext(sw);
  vm.runInContext(swCode, sw, { filename: 'sw.js' });
  assert.ok(listeners['message'], 'sw.js لا يستمع لرسائل الصفحة (message)');
  assert.ok(listeners['notificationclick'], 'sw.js لا يستمع للضغط على الإشعار (notificationclick)');
  return sw;
}
