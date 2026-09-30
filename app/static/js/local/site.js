// The GitHub Pages site's data. Two kinds:
//  - the daily files the scan publishes (prices, signals, the model…), the same for everyone and encrypted with the
//    group password: data/<name>.bin = 12-byte IV + AES-256-GCM(gzip(JSON)), key = PBKDF2-SHA256(password);
//  - your own "book" (portfolio, paper account, settings), which never leaves this browser.
const KEY = 'egx-site-key';
const BOOK = 'egx-book';
const enc = new TextEncoder();

let info = null;          // data/site.json: { salt, iter, stamp, built }
let key = null;           // the AES key's raw bytes, once unlocked
const files = new Map();  // name → Promise of its JSON, for the current stamp

const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export async function siteInfo(fresh = false) {
  if (info && !fresh) return info;
  let res;
  try {
    res = await fetch('data/site.json', { cache: 'no-store' });
  } catch {
    throw new Error("Can't reach the site. Check your internet connection.");
  }
  if (!res.ok) throw new Error("The site's data isn't published yet. Try again after the next scan.");
  const next = await res.json();
  if (info && info.stamp !== next.stamp) files.clear();
  info = next;
  return info;
}

async function derive(password, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations: iter },
    base, 256);
  return new Uint8Array(bits);
}

async function openBox(buf, raw) {
  const k = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, k, buf.slice(12));
  const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

async function fetchBox(name) {
  const s = await siteInfo();
  const path = name.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`data/${path}.bin?v=${s.stamp}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Couldn't load the site's data (${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

// One of the published files, decrypted. null if the site doesn't have it (for example a stock without prices).
export function load(name) {
  if (!key) return Promise.reject(Object.assign(new Error('locked'), { locked: true }));
  if (!files.has(name)) {
    const p = fetchBox(name).then(buf => (buf ? openBox(buf, key) : null));
    p.catch(() => files.delete(name));
    files.set(name, p);
  }
  return files.get(name);
}

function storedKey() {
  for (const box of [localStorage, sessionStorage]) {
    try {
      const v = JSON.parse(box.getItem(KEY) || 'null');
      if (v && v.key) return v;
    } catch { /* storage blocked */ }
  }
  return null;
}

// Opens the site with the key this browser remembered. Returns false if there is none or it no longer works
// (the owner changed the password).
export async function resume() {
  const saved = storedKey();
  if (!saved) return false;
  const s = await siteInfo();
  if (saved.salt !== s.salt || saved.iter !== s.iter) { lock(); return false; }
  try {
    const buf = await fetchBox('core');
    await openBox(buf, unb64(saved.key));
    key = unb64(saved.key);
    return true;
  } catch (e) {
    if (e.name === 'OperationError') { lock(); return false; }
    throw e;
  }
}

// Checks the group password against the published data. Throws "wrong password" when it doesn't open it.
export async function unlock(password, remember) {
  const s = await siteInfo(true);
  const raw = await derive(password, s.salt, s.iter);
  const buf = await fetchBox('core');
  if (!buf) throw new Error("The site's data isn't published yet. Try again after the next scan.");
  try {
    await openBox(buf, raw);
  } catch {
    throw new Error("That password doesn't open the site. Check it with the person who sent you the link.");
  }
  key = raw;
  files.clear();
  const value = JSON.stringify({ salt: s.salt, iter: s.iter, key: b64(raw) });
  try {
    (remember ? localStorage : sessionStorage).setItem(KEY, value);
    if (remember && navigator.storage && navigator.storage.persist) navigator.storage.persist();
  } catch { /* private mode: it stays open until the tab closes */ }
}

// Inside Telegram (the bot's "Open the app" button): Telegram vouches for who opened it, and the bot gives a
// connected friend the site's key and their portfolio link, so there's no password to type there.
export async function telegramUnlock(initData) {
  const s = await siteInfo(true);
  if (!s.worker || !initData) return false;
  let res;
  try {
    res = await fetch(s.worker.replace(/\/$/, '') + '/miniapp', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData }) });
  } catch {
    return false;
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.key || out.key.salt !== s.salt || out.key.iter !== s.iter) return false;
  const raw = unb64(out.key.key);
  try {
    await openBox(await fetchBox('core'), raw);
  } catch {
    return false;
  }
  key = raw;
  files.clear();
  try {
    localStorage.setItem(KEY, JSON.stringify({ salt: s.salt, iter: s.iter, key: out.key.key }));
    if (out.token) localStorage.setItem('egx-bot-link', JSON.stringify({ url: s.worker, token: out.token }));
    localStorage.setItem('egx-accepted', new Date().toISOString());
  } catch { /* storage blocked: open until the app closes */ }
  return true;
}

export function lock() {
  key = null;
  files.clear();
  for (const box of [localStorage, sessionStorage]) {
    try { box.removeItem(KEY); } catch { /* storage blocked */ }
  }
}

// Has the scan published something newer since this page loaded?
export async function newData() {
  const before = info && info.stamp;
  try {
    const s = await siteInfo(true);
    return !!before && s.stamp !== before;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ your own data, in this browser only
export const emptyBook = () => ({
  v: 1, next_id: 1, trades: [], fills: [], dividends: [], adjustments: [], checklist: {}, settings: {}, meta: {},
  watchlist: [],
});

export function validBook(b) {
  return !!b && typeof b === 'object' && ['trades', 'fills', 'dividends', 'adjustments'].every(k => Array.isArray(b[k]));
}

export function loadBook() {
  try {
    const b = JSON.parse(localStorage.getItem(BOOK) || 'null');
    if (validBook(b)) return { ...emptyBook(), ...b };
  } catch { /* nothing saved, or storage blocked */ }
  return emptyBook();
}

// Each change is stamped, so the copy linked to the Telegram bot knows which device has the newest (api.js).
// keepStamp: a copy brought from the bot keeps its own.
export function saveBook(book, keepStamp = false) {
  if (!keepStamp) book.meta = { ...(book.meta || {}), changed: new Date().toISOString() };
  try {
    localStorage.setItem(BOOK, JSON.stringify(book));
  } catch {
    throw new Error("This browser wouldn't save your data (its storage may be full or blocked). "
      + 'Download a backup from Settings before closing the page.');
  }
}

export function backupText(book) {
  return JSON.stringify({ app: 'egx-trading-agent', kind: 'portfolio-backup', exported: new Date().toISOString(), book },
    null, 1);
}

export function readBackup(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("This file isn't a backup from this site."); }
  if (!data || data.app !== 'egx-trading-agent' || data.kind !== 'portfolio-backup' || !validBook(data.book)) {
    throw new Error("This file isn't a backup from this site.");
  }
  return { ...emptyBook(), ...data.book };
}
