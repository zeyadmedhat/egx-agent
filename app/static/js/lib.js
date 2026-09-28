// Shared plumbing: Preact + htm, the API client, a tiny global store, routing and number formatting.
import { h, render, Fragment } from 'preact';
import { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } from 'preact/hooks';
import htm from 'htm';

export const html = htm.bind(h);
export { h, render, Fragment, useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect };

// ------------------------------------------------------------------ API
export class ApiError extends Error {
  constructor(message, status, detail) { super(message); this.status = status; this.detail = detail; }
}

// The GitHub Pages site: no server, so requests are answered in the browser (js/local/).
export const STATIC = document.documentElement.dataset.mode === 'static';

async function localApi(path, options) {
  const local = await import('./local/api.js');
  try {
    return await local.localApi(path, options);
  } catch (e) {
    if (e.locked) setStore({ auth: 'unlock' });
    throw new ApiError(e.message, e.status || 500, e.detail || null);
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  if (STATIC) return localApi(path, { method, body });
  const opts = { method, headers: { 'X-EGX-Agent': '1' } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch('/api' + path, opts);
  } catch (e) {
    throw new ApiError("Can't reach the agent. Is it still running?", 0, null);
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const d = data && data.detail;
    let msg = `Request failed (${res.status})`;
    if (typeof d === 'string') msg = d;
    else if (Array.isArray(d)) msg = d.map(x => `${(x.loc || []).slice(-1)[0] || 'value'}: ${x.msg}`).join('; ');
    else if (d && d.message) msg = d.message;
    // The website: signed out (or never signed in), or the first-login notice isn't accepted yet.
    if (res.status === 401 && d && d.login && store.me) setStore({ auth: 'login' });
    if (res.status === 403 && d && d.terms && store.me) setStore({ auth: 'terms' });
    throw new ApiError(msg, res.status, d);
  }
  return data;
}

// ------------------------------------------------------------------ store
const listeners = new Set();
export const store = {
  status: null,      // /api/status
  version: null,     // data version: changes after every scan / Kashif refresh
  tick: 0,           // bumped after anything you change, so pages reload
  stocks: null,      // all stocks for search and pickers
  toasts: [],
  offline: false,
  theme: document.documentElement.dataset.theme || 'dark',
  me: null,          // /api/me: { multi_user, user } (on your Mac: you, as admin, no login)
  auth: null,        // the website only: 'login' or 'terms' while that screen is needed
};
export const isAdmin = () => !store.me || !!store.me.user.is_admin;
export const multiUser = () => !!(store.me && store.me.multi_user);

// Who is using the dashboard. Returns 'ok', 'login' or 'terms'.
export async function loadMe() {
  try {
    const me = await api('/me');
    setStore({ me, auth: me.user.accepted_terms ? null : 'terms' });
    return me.user.accepted_terms ? 'ok' : 'terms';
  } catch (e) {
    if (e.status === 401) { setStore({ me: null, auth: 'login' }); return 'login'; }
    throw e;
  }
}
export function setStore(patch) {
  Object.assign(store, patch);
  listeners.forEach(l => l());
}
export function useStore(select) {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force(x => x + 1);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  return select(store);
}
export const refreshAll = () => setStore({ tick: store.tick + 1 });

let toastId = 0;
export function toast(message, tone = 'ok', ms = 6000) {
  const id = ++toastId;
  setStore({ toasts: [...store.toasts, { id, message, tone }] });
  if (ms) setTimeout(() => dismissToast(id), ms);
}
export const dismissToast = id => setStore({ toasts: store.toasts.filter(t => t.id !== id) });

// Loads an API path and reloads it when the data changes (new scan) or after your own changes.
export function useApi(path) {
  const version = useStore(s => s.version);
  const tick = useStore(s => s.tick);
  const [state, setState] = useState({ path, data: null, error: null, loading: !!path });
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setState(s => (s.path === path ? { ...s, loading: true } : { path, data: null, error: null, loading: true }));
    api(path)
      .then(data => alive && setState({ path, data, error: null, loading: false }))
      .catch(error => alive && setState(s => ({ ...s, path, error, loading: false })));
    return () => { alive = false; };
  }, [path, version, tick]);
  const data = state.path === path ? state.data : null;
  return { data, error: state.error, loading: state.loading };
}

// ------------------------------------------------------------------ status polling (scan progress etc.)
let pollTimer = null;
export async function pollStatus() {
  clearTimeout(pollTimer);
  if (STATIC) return pollSite();
  try {
    const s = await api('/status');
    const prev = store.status;
    const patch = { status: s, offline: false };
    if (store.version !== s.version) patch.version = s.version;
    const pj = prev && prev.job, j = s.job;
    if (pj && j && pj.id === j.id && pj.state === 'running' && j.state !== 'running') {
      if (j.silent) { /* someone else's backtest: nothing to tell you */ }
      else if (j.state === 'done') toast(j.summary || `${j.label} finished.`, 'ok', 9000);
      else toast(`${j.label} failed: ${j.error}`, 'error', 0);
      patch.tick = store.tick + 1;
    }
    setStore(patch);
  } catch (e) {
    if (store.auth) return;           // signed out: the login screen takes over, stop asking
    setStore({ offline: true });
  }
  const running = store.status && store.status.job && store.status.job.state === 'running';
  pollTimer = setTimeout(pollStatus, running ? 1000 : store.offline ? 5000 : 15000);
}

// The GitHub Pages site: look for a newer scan every few minutes; pages reload when there is one.
async function pollSite() {
  if (store.auth) return;
  try {
    const site = await import('./local/site.js');
    await site.newData();
    const s = await api('/status');
    const patch = { status: s, offline: false };
    if (store.version !== s.version) patch.version = s.version;
    setStore(patch);
  } catch (e) {
    if (!store.auth) setStore({ offline: true });
  }
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollSite, store.offline ? 30000 : 300000);
}

export async function startJob(path, body) {
  try {
    const res = await api(path, { method: 'POST', body: body || {} });
    setStore({ status: { ...(store.status || {}), job: res.job } });
    pollStatus();
    return res.job;
  } catch (e) {
    toast(e.message, 'error', 8000);
    return null;
  }
}

export async function loadStocks() {
  try { setStore({ stocks: await api('/stocks') }); } catch { /* retried on next version change */ }
}

// ------------------------------------------------------------------ routing (#/page/arg?query)
export function parseHash(hash = location.hash) {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  return {
    page: parts[0] || 'today',
    arg: parts[1] ? decodeURIComponent(parts[1]) : null,
    query: Object.fromEntries(new URLSearchParams(query)),
  };
}
export function useRoute() {
  const [route, setRoute] = useState(parseHash());
  useEffect(() => {
    const onChange = () => { setRoute(parseHash()); window.scrollTo(0, 0); };
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
export const go = to => { location.hash = to; };
export const stockHref = sym => `#/stock/${encodeURIComponent(sym)}`;

// ------------------------------------------------------------------ formatting
const nfCache = {};
const nf = (min, max = min) => (nfCache[`${min}-${max}`] ||= new Intl.NumberFormat('en-US', {
  minimumFractionDigits: min, maximumFractionDigits: max,
}));
const bad = v => v === null || v === undefined || Number.isNaN(v);
const minus = s => s.replace('-', '−');

export const fmt = {
  num: (v, d = 2) => (bad(v) ? '–' : minus(nf(d).format(v))),
  int: v => (bad(v) ? '–' : minus(nf(0).format(Math.round(v)))),
  signed: (v, d = 0) => (bad(v) ? '–' : (v > 0 ? '+' : '') + minus(nf(d).format(v))),
  egp: (v, d = 0) => (bad(v) ? '–' : `${minus(nf(d).format(v))} EGP`),
  short(v) {
    if (bad(v)) return '–';
    const a = Math.abs(v);
    if (a >= 1e9) return minus(nf(2).format(v / 1e9)) + 'B';
    if (a >= 1e6) return minus(nf(2).format(v / 1e6)) + 'M';
    if (a >= 1e4) return minus(nf(1).format(v / 1e3)) + 'k';
    return minus(nf(0).format(v));
  },
  pct: (v, d = 1, sign = true) => (bad(v) ? '–' : (sign && v > 0 ? '+' : '') + minus(nf(d).format(v * 100)) + '%'),
  date(s, withYear = true) {
    if (!s) return '–';
    const d = new Date(String(s).slice(0, 10) + 'T00:00:00');
    return d.toLocaleDateString('en-GB', withYear ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
  },
  datetime(s) {
    if (!s) return '–';
    const d = new Date(s);
    return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  },
  price: v => (bad(v) ? '–' : minus(nf(2, v < 10 ? 3 : 2).format(v))),
};
export const tone = v => (bad(v) || v === 0 ? '' : v > 0 ? 'up' : 'down');
export const todayISO = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
export const cls = (...xs) => xs.filter(Boolean).join(' ');

// ------------------------------------------------------------------ theme
export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('egx-theme', theme); } catch { /* private mode */ }
  setStore({ theme });
}
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
export function remember(key, value) {
  try {
    if (value === undefined) return localStorage.getItem('egx-' + key);
    localStorage.setItem('egx-' + key, value);
  } catch { return null; }
  return value;
}

// Works without clipboard permissions, as long as it runs from a click.
export function copyText(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}
