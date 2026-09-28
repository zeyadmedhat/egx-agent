// App shell: sidebar navigation, stock search, scan progress and page routing.
import {
  html, render, useState, useEffect, useStore, useRoute, pollStatus, loadStocks, setTheme, fmt, tone, cls, go, stockHref,
  loadMe, api, toast, setStore, STATIC,
} from './lib.js';
import { Icon, Toasts, JobControl, StockPicker, Field, Callout, Confirm } from './ui.js';
import { AuthScreen } from './pages/login.js';
import { UnlockScreen } from './pages/unlock.js';
import { AdminPage } from './pages/admin.js';
import { TodayPage } from './pages/today.js';
import { MarketPage } from './pages/market.js';
import { PredictPage } from './pages/predict.js';
import { StockPage } from './pages/stock.js';
import { CalcPage } from './pages/calc.js';
import { ScreenerPage } from './pages/screener.js';
import { DividendsPage } from './pages/dividends.js';
import { WatchlistPage } from './pages/watchlist.js';
import { PortfolioPage } from './pages/portfolio.js';
import { PaperPage } from './pages/paper.js';
import { BacktestPage } from './pages/backtest.js';
import { SettingsPage } from './pages/settings.js';

const MAC_ONLY = ['paper', 'backtest'];     // the GitHub Pages site has no paper trading or backtest
const PAGES = Object.fromEntries(Object.entries({
  today: TodayPage, market: MarketPage, predict: PredictPage, screener: ScreenerPage, watchlist: WatchlistPage, stock: StockPage, calc: CalcPage, dividends: DividendsPage, portfolio: PortfolioPage, paper: PaperPage,
  backtest: BacktestPage, settings: SettingsPage, admin: AdminPage,
}).filter(([id]) => !(STATIC && MAC_ONLY.includes(id))));
const NAV = [
  ['today', 'Today', 'activity'], ['market', 'Market', 'bars'], ['predict', 'Predict', 'target'], ['screener', 'Screener', 'search'], ['watchlist', 'Watchlist', 'eye'], ['stock', 'Stock', 'chart'], ['calc', 'Calculator', 'coins'], ['dividends', 'Dividends', 'percent'],
  ['portfolio', 'My Portfolio', 'briefcase'],
  ['paper', 'Paper Trading', 'flask'], ['backtest', 'Backtest', 'history'], ['settings', 'Settings', 'sliders'],
].filter(([id]) => id in PAGES);

function Sidebar({ page, onNav }) {
  const status = useStore(s => s.status);
  const theme = useStore(s => s.theme);
  const me = useStore(s => s.me);
  const [account, setAccount] = useState(false);
  const website = me && me.multi_user;
  const nav = website && me.user.is_admin ? [...NAV, ['admin', 'Admin', 'users']] : NAV;
  const m = status && status.market;
  const badge = id => {
    if (id === 'today' && m && m.buys) return html`<span class="count hot" title="BUY signals">${m.buys}</span>`;
    if (id === 'portfolio' && status && status.alerts) {
      return html`<span class="count alert" title="Positions that need action">${status.alerts}</span>`;
    }
    return null;
  };
  return html`<aside class="sidebar">
    <div class="brand"><div class="logo">EGX</div>
      <div><div class="brand-name">Trading Agent</div><div class="brand-sub">Swing trades · 2–4 weeks</div></div></div>
    <nav class="nav">${nav.map(([id, label, icon]) => html`<a href=${`#/${id}`} class=${page === id ? 'active' : ''}
      onClick=${onNav}><${Icon} name=${icon} />${label}${badge(id)}</a>`)}</nav>
    ${m && html`<div class="side-market">
      <div class="label">EGX30</div>
      <div class="value">${fmt.int(m.egx30_close)} <span class=${tone(m.egx30_change)} style="font-size:13px">${fmt.pct(m.egx30_change, 2)}</span></div>
      <div style="margin-top:6px">${m.risk_off
        ? html`<span class="chip riskoff"><span class="dot"></span>Risk-off</span>`
        : html`<span class="chip riskon"><span class="dot"></span>Market OK</span>`}</div>
      <div class="meta">Data: ${fmt.date(m.date)} close</div>
    </div>`}
    <div class="side-foot">${website
      ? html`<button class="account-btn" onClick=${() => setAccount(true)} title="Your account">
          <span class="avatar">${(me.user.display_name || '?').slice(0, 1).toUpperCase()}</span>
          <span class="who">${me.user.display_name}</span></button>`
      : html`<small>Not investment advice</small>`}
      ${STATIC && html`<button class="icon-btn" title="Lock: forget the password on this device"
        onClick=${() => setAccount(true)}><${Icon} name="shield" /></button>`}
      <button class="icon-btn" title=${theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        onClick=${() => setTheme(theme === 'dark' ? 'light' : 'dark')}><${Icon} name=${theme === 'dark' ? 'sun' : 'moon'} /></button></div>
    ${account && (STATIC
      ? html`<${Confirm} title="Lock the site on this device?" confirmLabel="Lock"
          text="You'll need the group password to open it again. Your portfolio stays saved in this browser."
          onConfirm=${lockSite} onClose=${() => setAccount(false)} />`
      : html`<${AccountDialog} me=${me} onClose=${() => setAccount(false)} />`)}
  </aside>`;
}

export async function lockSite() {
  const site = await import('./local/site.js');
  site.lock();
  setStore({ auth: 'unlock', status: null, version: null });
  go('#/');
}

function AccountDialog({ me, onClose }) {
  const [old, setOld] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const out = async path => {
    try { await api(path, { method: 'POST' }); } catch { /* signed out anyway */ }
    setStore({ me: null, auth: 'login', status: null });
    go('#/');
  };
  const change = async e => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api('/auth/password', { method: 'POST', body: { old, new: pw } });
      toast(r.message);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="modal-bg" onMouseDown=${e => e.target === e.currentTarget && onClose()}>
    <div class="modal" role="dialog" aria-modal="true">
      <h3>${me.user.display_name}</h3>
      <p>Logged in as <b>${me.user.username}</b>${me.user.is_admin ? ' (admin)' : ''}.</p>
      <form class="stack" style="margin-top:14px" onSubmit=${change}>
        <input type="text" autocomplete="username" value=${me.user.username} hidden readonly />
        <${Field} label="Current password"><input class="input" type="password" autocomplete="current-password"
          value=${old} onInput=${e => setOld(e.target.value)} required /><//>
        <${Field} label="New password" help="At least 10 characters."><input class="input" type="password"
          autocomplete="new-password" value=${pw} onInput=${e => setPw(e.target.value)} required minlength="10" /><//>
        ${error && html`<${Callout} tone="bad">${error}<//>`}
        <button class="btn primary" type="submit" disabled=${busy}>Change password</button>
      </form>
      <div class="actions" style="justify-content:space-between;flex-wrap:wrap">
        <button class="btn ghost" onClick=${() => out('/auth/logout-all')}>Sign out everywhere</button>
        <div class="row" style="gap:8px"><button class="btn ghost" onClick=${onClose}>Close</button>
          <button class="btn" onClick=${() => out('/auth/logout')}><${Icon} name="x" />Sign out</button></div>
      </div>
    </div></div>`;
}

function App() {
  const route = useRoute();
  const [menu, setMenu] = useState(false);
  const version = useStore(s => s.version);
  const tick = useStore(s => s.tick);
  const offline = useStore(s => s.offline);
  useEffect(() => { pollStatus(); }, []);
  useEffect(() => { if (version) loadStocks(); }, [version, tick]);
  useEffect(() => {
    const title = (NAV.find(([id]) => id === route.page) || NAV[0])[1];
    document.title = `${route.page === 'stock' && route.arg ? route.arg : title} · EGX Trading Agent`;
    setMenu(false);
  }, [route.page, route.arg]);
  const Page = PAGES[route.page] || TodayPage;
  return html`<div class=${cls('shell', menu && 'menu-open')}>
    <${Sidebar} page=${PAGES[route.page] ? route.page : 'today'} onNav=${() => setMenu(false)} />
    <div class="scrim" onClick=${() => setMenu(false)}></div>
    <main class="main">
      <header class="topbar">
        <button class="icon-btn only-mobile" onClick=${() => setMenu(true)} aria-label="Menu"><${Icon} name="menu" /></button>
        <${StockPicker} search hotkey value=${null} onChange=${sym => go(stockHref(sym))}
          placeholder="Search stocks: symbol or Arabic name" />
        <div class="topbar-right"><${JobControl} /></div>
      </header>
      ${offline && (STATIC
        ? html`<div class="offline"><b>Can't reach the site.</b> Check your internet connection; your own data is safe
            in this browser.</div>`
        : html`<div class="offline"><b>Can't reach the agent.</b> It may have been stopped. Double-click
            “Start Trading Agent.command” in the project folder, then reload this page.</div>`)}
      <div class="content"><${Page} route=${route} key=${route.page} /></div>
    </main>
    <${Toasts} />
  </div>`;
}

// On the website you log in first (and accept the notice once); on the GitHub Pages site you enter the group
// password once per device; on your Mac the dashboard opens straight away.
function Root() {
  const route = useRoute();
  const auth = useStore(s => s.auth);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState('');
  useEffect(() => {
    const start = STATIC
      ? loadMe().then(() => import('./local/site.js')).then(site => site.resume())
        .then(ok => setStore({ auth: ok ? null : 'unlock' }))
        .catch(e => { setBootError(e.message); setStore({ auth: 'unlock' }); })
      : loadMe().catch(() => setStore({ offline: true }));
    start.finally(() => setReady(true));
  }, []);
  if (!ready) return html`<div class="boot"><span class="spinner"></span></div>`;
  if (STATIC && auth) {
    return html`<${UnlockScreen} error=${bootError}
      onDone=${() => { setBootError(''); setStore({ auth: null, version: null }); }} />`;
  }
  if (auth || route.page === 'join' || route.page === 'reset') {
    return html`<${AuthScreen} onDone=${async () => { await loadMe(); go('#/today'); pollStatus(); }} /><${Toasts} />`;
  }
  return html`<${App} />`;
}

render(html`<${Root} />`, document.getElementById('app'));
