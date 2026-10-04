// App shell: the top bar (sections, stock search, EGX30, scan progress, the ⚙ menu), each section's tabs, the phone's
// bottom bar, and page routing.
import {
  html, render, useState, useEffect, useStore, useRoute, pollStatus, loadStocks, setTheme, fmt, cls, go, stockHref,
  loadMe, api, toast, setStore, setLang, refreshAll, STATIC,
} from './lib.js';
import { t } from './i18n.js';
import { Icon, Toasts, JobControl, StockPicker, Field, Callout, Confirm, Change, Disclaimer } from './ui.js';
import { AuthScreen } from './pages/login.js';
import { UnlockScreen } from './pages/unlock.js';
import { AdminPage } from './pages/admin.js';
import { TodayPage } from './pages/today.js';
import { PicksPage, RecordPage } from './pages/picks.js';
import { MarketPage } from './pages/market.js';
import { HeatmapPage } from './pages/heatmap.js';
import { Egx30Page } from './pages/egx30.js';
import { PredictPage } from './pages/predict.js';
import { StockPage } from './pages/stock.js';
import { CalcPage } from './pages/calc.js';
import { ScreenerPage } from './pages/screener.js';
import { DividendsPage } from './pages/dividends.js';
import { WatchlistPage } from './pages/watchlist.js';
import { NewsPage } from './pages/news.js';
import { PortfolioPage } from './pages/portfolio.js';
import { PaperPage } from './pages/paper.js';
import { BacktestPage } from './pages/backtest.js';
import { SettingsPage } from './pages/settings.js';

// Opened inside Telegram (the bot's "Open the app" button, a mini app): Telegram puts who opened it after the # and the
// bot's page after ?go=. Both are read once and the address goes back to the page's own #/route.
const TELEGRAM = (() => {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const go = new URLSearchParams(location.search).get('go');
  const initData = hash.get('tgWebAppData');
  if (initData || go) {
    history.replaceState(null, '', location.pathname + '#/' + (go && /^[\w/.-]+$/.test(go) ? go : 'today'));
  }
  if (!initData) return null;
  const post = (type, data = {}) => {       // Telegram's own messages to its app (core.telegram.org/api/web-events)
    try {
      if (window.TelegramWebviewProxy) window.TelegramWebviewProxy.postEvent(type, JSON.stringify(data));
      else window.parent.postMessage(JSON.stringify({ eventType: type, eventData: data }), '*');
    } catch { /* not in Telegram after all */ }
  };
  post('web_app_ready');
  post('web_app_expand');
  return { initData };
})();

const MAC_ONLY = ['paper', 'backtest'];     // the GitHub Pages site has no paper trading or backtest
const PAGES = Object.fromEntries(Object.entries({
  today: TodayPage, signals: PicksPage, record: RecordPage, news: NewsPage, market: MarketPage, egx30: Egx30Page, heatmap: HeatmapPage, predict: PredictPage, dividends: DividendsPage,
  stock: StockPage, screener: ScreenerPage, watchlist: WatchlistPage, portfolio: PortfolioPage, paper: PaperPage,
  calc: CalcPage, backtest: BacktestPage, settings: SettingsPage, admin: AdminPage,
}).filter(([id]) => !(STATIC && MAC_ONLY.includes(id))));

// The top bar's four sections and their tabs. Every page keeps its own #/address, so links from Telegram and old
// bookmarks still work (#/signals is Picks, #/predict its Rankings). Settings and Admin sit in the ⚙ menu.
const SECTIONS = [
  { id: 'home', label: 'Home', icon: 'home',
    tabs: [['today', 'Summary'], ['market', 'Market'], ['egx30', 'EGX30'], ['heatmap', 'Heatmap'], ['dividends', 'Dividends & results'], ['news', 'News']] },
  { id: 'picks', label: 'Picks', icon: 'target', tabs: [['signals', 'Picks'], ['predict', 'Rankings'], ['record', 'Track record']] },
  { id: 'stocks', label: 'Stocks', icon: 'chart', tabs: [['stock', 'Stock'], ['screener', 'Screener'], ['watchlist', 'Watchlist']] },
  { id: 'portfolio', label: 'Portfolio', icon: 'briefcase',
    tabs: [['portfolio', 'My portfolio'], ['paper', 'Practice'], ['calc', 'Calculator'], ['backtest', 'Rules test']] },
].map(s => ({ ...s, tabs: s.tabs.filter(([id]) => id in PAGES) }));
const sectionOf = page => SECTIONS.find(s => s.tabs.some(([id]) => id === page));
const pageTitle = page => {
  for (const s of SECTIONS) for (const [id, label] of s.tabs) if (id === page) return label;
  return { settings: 'Settings', admin: 'Admin' }[page] || 'Summary';
};

// Counts on the sections: BUY signals for the next session, and your positions that need action.
function useCounts() {
  const status = useStore(s => s.status);
  const m = status && status.market;
  return { picks: (m && m.buys) || 0, signals: (m && m.buys) || 0, portfolio: (status && status.alerts) || 0 };
}
function Count({ id, counts }) {
  const n = counts[id];
  if (!n) return null;
  const alert = id === 'portfolio';
  return html`<span class=${cls('count', alert ? 'alert' : 'hot')}
    title=${t(alert ? 'Positions that need action' : 'BUY signals')}>${n}</span>`;
}

function TopBar({ page, onMenu, menuOpen }) {
  const lang = useStore(s => s.lang);
  const counts = useCounts();
  const sec = sectionOf(page);
  return html`<header class="topbar">
    <a class="brand" href="#/today" title="EGX Trading Agent"><span class="logo">EGX</span>
      <span class="brand-name">${t('Trading Agent')}</span></a>
    <nav class="sections">${SECTIONS.map(s => html`<a href=${`#/${s.tabs[0][0]}`} class=${cls(sec === s && 'active')}
      aria-current=${sec === s ? 'page' : undefined}><${Icon} name=${s.icon} /><span>${t(s.label)}</span>
      <${Count} id=${s.id} counts=${counts} /></a>`)}</nav>
    <div class="top-search"><${StockPicker} search hotkey value=${null} onChange=${sym => go(stockHref(sym))}
      placeholder=${t('Search stocks: symbol or Arabic name')} key=${lang} /></div>
    <${IndexChip} />
    <div class="top-right"><${JobControl} />
      <button class=${cls('icon-btn menu-btn', menuOpen && 'on')} onClick=${onMenu} aria-haspopup="menu"
        aria-expanded=${menuOpen} title=${t('Settings')} aria-label=${t('Settings')}><${Icon} name="sliders" /></button></div>
  </header>`;
}

// EGX30 at the last close, in the top bar.
function IndexChip() {
  const m = useStore(s => s.status && s.status.market);
  if (!m || m.egx30_close == null) return null;
  return html`<a class="index-chip" href="#/egx30" title=${t('Data: {date} close', { date: fmt.date(m.date) })}>
    <span class=${cls('dot', m.risk_off ? 'warn' : 'up')} title=${t(m.risk_off ? 'Weak market' : 'Market OK')}></span>
    <span class="faint">EGX30</span><b class="num">${fmt.int(m.egx30_close)}</b><${Change} value=${m.egx30_change} /></a>`;
}

// The section's tabs, under the top bar.
function SubNav({ page }) {
  const counts = useCounts();
  const sec = sectionOf(page);
  if (!sec || sec.tabs.length < 2) return null;
  return html`<nav class="subnav" aria-label=${t(sec.label)}>${sec.tabs.map(([id, label]) => html`<a href=${`#/${id}`}
    class=${cls(id === page && 'on')} aria-current=${id === page ? 'page' : undefined}>${t(label)}
    ${id === 'signals' && html`<${Count} id="signals" counts=${counts} />`}</a>`)}</nav>`;
}

// On a phone the sections move to a bar at the bottom of the screen, within reach of your thumb.
function BottomBar({ page, onMenu, menuOpen }) {
  const counts = useCounts();
  const sec = sectionOf(page);
  return html`<nav class="bottombar">${SECTIONS.map(s => html`<a href=${`#/${s.tabs[0][0]}`} class=${cls(sec === s && 'active')}
      aria-current=${sec === s ? 'page' : undefined}><span class="bb-icon"><${Icon} name=${s.icon} />
      <${Count} id=${s.id} counts=${counts} /></span><span>${t(s.label)}</span></a>`)}
    <button type="button" class=${cls((menuOpen || page === 'settings' || page === 'admin') && 'active')} onClick=${onMenu}
      aria-haspopup="menu" aria-expanded=${menuOpen}><span class="bb-icon"><${Icon} name="sliders" /></span><span>${t('More')}</span></button>
  </nav>`;
}

// The ⚙ menu: settings, admin, language, theme, and your account (or locking the site on this device).
function Menu({ onClose }) {
  const theme = useStore(s => s.theme);
  const lang = useStore(s => s.lang);
  const me = useStore(s => s.me);
  const [dialog, setDialog] = useState(null);
  const website = me && me.multi_user;
  useEffect(() => {
    const onKey = e => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  if (dialog === 'account') return html`<${AccountDialog} me=${me} onClose=${onClose} />`;
  if (dialog === 'lock') {
    return html`<${Confirm} title="Lock the site on this device?" confirmLabel="Lock"
      text="You'll need the group password to open it again. Your portfolio stays saved in this browser."
      onConfirm=${lockSite} onClose=${onClose} />`;
  }
  return html`<div class="menu-scrim" onClick=${onClose}></div>
    <div class="menu" role="menu">
      ${website && html`<button class="menu-item who" role="menuitem" onClick=${() => setDialog('account')}>
        <span class="avatar me">${(me.user.display_name || '?').slice(0, 1).toUpperCase()}</span>
        <span><b>${me.user.display_name}</b><small>${t('Password and sign out')}</small></span></button>`}
      <a class="menu-item" role="menuitem" href="#/settings" onClick=${onClose}><${Icon} name="sliders" />${t('Settings')}</a>
      ${website && me.user.is_admin && html`<a class="menu-item" role="menuitem" href="#/admin" onClick=${onClose}>
        <${Icon} name="users" />${t('Admin')}</a>`}
      <button class="menu-item" role="menuitem" lang=${lang === 'ar' ? 'en' : 'ar'} onClick=${() => { setLang(lang === 'ar' ? 'en' : 'ar'); onClose(); }}>
        <span class="menu-glyph">${lang === 'ar' ? 'EN' : 'ع'}</span>${lang === 'ar' ? 'English' : 'العربية'}</button>
      <button class="menu-item" role="menuitem" onClick=${() => { setTheme(theme === 'dark' ? 'light' : 'dark'); onClose(); }}>
        <${Icon} name=${theme === 'dark' ? 'sun' : 'moon'} />${t(theme === 'dark' ? 'Light theme' : 'Dark theme')}</button>
      ${STATIC && html`<button class="menu-item" role="menuitem" onClick=${() => setDialog('lock')}>
        <${Icon} name="shield" />${t('Lock this device')}</button>`}
      <div class="menu-note">${t('Not investment advice')}</div>
    </div>`;
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
        <div class="row" style="gap:8px"><button class="btn ghost" onClick=${onClose}>${t('Close')}</button>
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
  const lang = useStore(s => s.lang);
  useEffect(() => { pollStatus(); }, []);
  useEffect(() => { if (version) loadStocks(); }, [version, tick]);
  const page = PAGES[route.page] ? route.page : 'today';
  useEffect(() => {
    document.title = `${page === 'stock' && route.arg ? route.arg : t(pageTitle(page))} · EGX Trading Agent`;
    setMenu(false);
  }, [page, route.arg, lang]);
  const Page = PAGES[page];
  const flip = () => setMenu(m => !m);
  return html`<div class="shell">
    <${TopBar} page=${page} onMenu=${flip} menuOpen=${menu} />
    ${offline && (STATIC
      ? html`<div class="offline"><b>Can't reach the site.</b> Check your internet connection; your own data is safe
          in this browser.</div>`
      : html`<div class="offline"><b>Can't reach the agent.</b> It may have been stopped. Double-click
          “Start Trading Agent.command” in the project folder, then reload this page.</div>`)}
    <main class="content"><${SubNav} page=${page} /><${Page} route=${route} key=${page + lang} /><${Disclaimer} /></main>
    <${BottomBar} page=${page} onMenu=${flip} menuOpen=${menu} />
    ${menu && html`<${Menu} onClose=${() => setMenu(false)} />`}
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
      ? loadMe().then(() => import('./local/site.js'))
        .then(async site => (await site.resume()) || (TELEGRAM ? site.telegramUnlock(TELEGRAM.initData) : false))
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

// The website keeps an offline copy of itself (sw.js), so it opens at once, even with weak or no signal.
if (STATIC && 'serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => null);

// Your portfolio came from the Telegram bot: changed on another device, or brought to this one (local/api.js).
addEventListener('egx-book', () => {
  toast(t('Your portfolio was updated from your other device.'));
  refreshAll();
});
