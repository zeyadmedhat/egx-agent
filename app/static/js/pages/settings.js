// Settings: Telegram alerts and the daily scan, every number the agent uses, the data status and refresh buttons.
import {
  html, useApi, useState, useEffect, useStore, api, toast, refreshAll, startJob, fmt, cls, todayISO, setOwner, watchForData,
} from '../lib.js';
import {
  Icon, Kpi, Callout, PageHead, Disclaimer, PageLoading, Field, Switch, Confirm, JobProgress, useJob,
} from '../ui.js';

const isNum = f => f.kind === 'float' || f.kind === 'int';

function toDraft(values, sections) {
  const d = {};
  for (const s of sections) for (const f of s.fields) {
    const v = values[f.key];
    if (isNum(f)) d[f.key] = v == null ? '' : String(+(v / (f.scale || 1)).toFixed(6));
    else if (f.kind === 'list') d[f.key] = (v || []).join(', ');
    else if (f.kind === 'map') d[f.key] = Object.entries(v || {}).map(([a, b]) => `${a}=${b}`).join(', ');
    else if (f.kind === 'multi') d[f.key] = [...(v || [])];
    else d[f.key] = v;
  }
  return d;
}

function fromDraft(draft, sections) {
  const out = {};
  for (const s of sections) for (const f of s.fields) {
    const v = draft[f.key];
    out[f.key] = isNum(f) ? (v === '' ? null : parseFloat(v) * (f.scale || 1)) : v;
  }
  return out;
}

const slug = t => 'sec-' + t.toLowerCase().replace(/[^a-z]+/g, '-');
const scrollTo = id => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

export function SettingsPage() {
  const { data, error } = useApi('/settings');
  const [draft, setDraft] = useState(null);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const { running } = useJob();
  useEffect(() => { if (data) { setDraft(toDraft(data.values, data.sections)); setErrors({}); } }, [data]);
  if (!data || !draft) return html`<${PageLoading} error=${error} />`;

  const original = toDraft(data.values, data.sections);
  const dirty = JSON.stringify(draft) !== JSON.stringify(original);
  const set = key => value => { setDraft(d => ({ ...d, [key]: value })); setSaved(false); };

  const save = async () => {
    setSaving(true);
    try {
      const r = await api('/settings', { method: 'PUT', body: fromDraft(draft, data.sections) });
      toast(r.message);
      setErrors({});
      setSaved(true);
      refreshAll();
    } catch (err) {
      setErrors((err.detail && err.detail.errors) || {});
      toast(err.message, 'error', 9000);
    } finally {
      setSaving(false);
    }
  };
  const restore = async () => {
    try {
      const r = await api('/settings/defaults', { method: 'POST' });
      toast(r.message);
      setSaved(true);
      refreshAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const website = data.multi_user;
  const admin = data.is_admin;
  return html`
    <${PageHead} title="Settings" sub=${website && !admin
      ? `Your own numbers: they size your BUY signals${data.static ? '' : ' and run your paper account'}. The strategy itself is the same for everyone.`
      : 'Changes apply from the next scan, or press Re-score now to apply them to the latest data.'}>
      <button class="btn ghost" onClick=${() => setConfirmReset(true)}>${admin ? 'Restore default rules' : 'Reset my settings'}</button><//>
    ${saved && admin && html`<div style="margin-bottom:14px"><${Callout} tone="ok"><div class="row" style="gap:12px">
      <span style="flex:1">Saved. Re-score to see today's signals with the new settings (takes a few seconds, no download).</span>
      <button class="btn sm primary" disabled=${running} onClick=${() => startJob('/jobs/scan', { update_data: false })}>
        <${Icon} name="refresh" />Re-score now</button></div><//></div>`}
    <div class="settings-layout">
      <nav class="settings-nav">
        <a role="button" onClick=${() => scrollTo('sec-alerts')}>${data.static ? 'This device' : 'Alerts'}</a>
        ${data.sections.map(s => html`<a role="button" onClick=${() => scrollTo(slug(s.title))}>${s.title}</a>`)}
        <a role="button" onClick=${() => scrollTo('sec-data')}>Data</a>
      </nav>
      <div class="stack">
        ${data.static ? html`<${DeviceCard} telegram=${data.telegram} scanUrl=${data.scan_url} />` : html`<${AlertsCard} />`}
        ${data.sections.map(s => html`<div class="card settings-section" id=${slug(s.title)}>
          <div class="card-title" style="font-size:14px;color:var(--text)">${s.title}${website && admin && html`
            <span class=${cls('scope-tag', s.scope === 'strategy' && 'everyone')}>${s.scope === 'strategy'
              ? 'Everyone: the strategy' : 'Only you'}</span>`}</div>
          <div class="fields">${s.fields.map(f => html`<${SettingField} f=${f} value=${draft[f.key]}
            onChange=${set(f.key)} error=${errors[f.key]} />`)}</div>
        </div>`)}
        ${dirty && html`<div class="savebar"><span class="msg"><${Icon} name="info" size=${15} /> You have unsaved changes.</span>
          <button class="btn ghost" onClick=${() => { setDraft(original); setErrors({}); }}>Discard</button>
          <button class="btn primary" disabled=${saving} onClick=${save}><${Icon} name="check" />Save settings</button></div>`}
        <${DataCard} d=${data.data} running=${running} admin=${admin} />
      </div>
    </div>
    ${confirmReset && html`<${Confirm} title=${admin ? 'Restore the default rules?' : 'Reset your settings?'}
      confirmLabel=${admin ? 'Restore defaults' : 'Reset'}
      text=${admin ? `All rules go back to the tested defaults${website ? ' for everyone' : ''}. Your capital, paper capital and fees are kept.`
        : `Your risk limits${data.static ? ' and Shariah filter' : ', Shariah filter and paper-trading choice'} go back to the defaults. Your capital and fees are kept.`}
      onConfirm=${restore} onClose=${() => setConfirmReset(false)} />`}
    <${Disclaimer} />`;
}

function SettingField({ f, value, onChange, error }) {
  const label = f.unit ? html`${f.label} <span class="faint">(${f.unit})</span>` : f.label;
  if (isNum(f)) {
    return html`<${Field} label=${label} help=${f.help} error=${error}>
      <input class=${cls('input', error && 'invalid')} type="number" step=${f.step} min=${f.min} max=${f.max}
        value=${value} onInput=${e => onChange(e.target.value)} /><//>`;
  }
  if (f.kind === 'select') {
    return html`<${Field} label=${label} help=${f.help} error=${error}>
      <select class="input" value=${value} onChange=${e => onChange(e.target.value)}>
        ${f.options.map(o => html`<option value=${o.value}>${o.label}</option>`)}</select><//>`;
  }
  if (f.kind === 'list' || f.kind === 'map') {
    return html`<${Field} className="wide" label=${label} help=${f.help} error=${error}>
      <input class=${cls('input', error && 'invalid')} value=${value} placeholder=${f.placeholder}
        onInput=${e => onChange(e.target.value.toUpperCase())} spellcheck=${false} /><//>`;
  }
  if (f.kind === 'multi') {
    return html`<${Field} label=${label} help=${f.help} error=${error}><div class="checks">
      ${f.options.map(o => html`<label class="check"><input type="checkbox" checked=${value.includes(o.value)}
        onChange=${e => onChange(e.target.checked ? [...value, o.value] : value.filter(x => x !== o.value))} />${o.label}</label>`)}
      </div><//>`;
  }
  if (f.kind === 'choice') {
    return html`<${Field} className="wide" label=${label} help=${f.help} error=${error}><div class="radio-cards">
      ${f.options.map(o => html`<label class=${cls('radio-card', value === o.value && 'on')}>
        <input type="radio" checked=${value === o.value} onChange=${() => onChange(o.value)} />${o.label}</label>`)}
      </div><//>`;
  }
  return html`<${Field} className="wide" help=${f.help} error=${error}>
    <${Switch} checked=${!!value} onChange=${onChange} label=${f.label} /><//>`;
}

function DataCard({ d, running, admin }) {
  return html`<div class="card settings-section" id="sec-data">
    <div class="card-title" style="font-size:14px;color:var(--text)">Data</div>
    <div class="kpis">
      <${Kpi} compact label="Stocks (from Kashif)" value=${d.stocks} />
      <${Kpi} compact label="With price history" value=${d.priced} />
      <${Kpi} compact label="Latest price bar" value=${fmt.date(d.last_bar)} />
      <${Kpi} compact label="Kashif checked" value=${d.kashif_checked ? fmt.date(d.kashif_checked) : 'never'} />
    </div>
    ${d.missing.length > 0 && html`<div class="missing-list" style="margin-top:16px">
      <div class="muted">Stocks without usable prices. They're checked again weekly and join the scan by themselves
        once they trade and build enough history.</div>
      ${d.missing.map(g => html`<div><b>${g.note}</b><div class="syms">${g.symbols.map(s => html`<code>${s}</code>`)}</div></div>`)}
    </div>`}
    ${admin ? html`<div class="row" style="margin-top:18px">
      <button class="btn" disabled=${running} onClick=${() => startJob('/jobs/scan', { update_data: false })}>
        <${Icon} name="refresh" />Re-score now (no download)</button>
      <button class="btn" disabled=${running} onClick=${() => startJob('/jobs/scan', { update_data: true })}>
        <${Icon} name="download" />Download latest prices + scan</button>
      <button class="btn" disabled=${running} onClick=${() => startJob('/jobs/kashif')}>
        <${Icon} name="shield" />Refresh Kashif Shariah data</button>
    </div>
    <div style="margin-top:14px"><${JobProgress} /></div>` : html`<p class="faint" style="font-size:12.5px;margin-top:14px">
      The site downloads the latest prices and scans by itself after every close.</p>`}
  </div>`;
}

// ------------------------------------------------------------------ the GitHub Pages site: your data lives here
function DeviceCard({ telegram, scanUrl }) {
  const [restore, setRestore] = useState(null);
  const owner = useStore(s => s.owner);
  const download = async () => {
    const site = await import('../local/site.js');
    const blob = new Blob([site.backupText(site.loadBook())], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `egx-portfolio-${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Backup downloaded. Keep it somewhere safe, for example in your email or cloud drive.');
  };
  const pick = e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    file.text().then(async text => {
      const site = await import('../local/site.js');
      const book = site.readBackup(text);
      const n = book.trades.filter(t => t.account === 'real' && t.status === 'open').length;
      setRestore({ book, text: `It has ${n} open position${n === 1 ? '' : 's'}${book.trades.length ? '' : ' and nothing else'}. `
        + 'Everything saved in this browser now is replaced by the backup.' });
    }).catch(err => toast(err.message, 'error', 9000));
  };
  const apply = async () => {
    const site = await import('../local/site.js');
    site.saveBook(restore.book);
    toast('Backup restored.');
    refreshAll();
  };
  return html`<div class="card settings-section" id="sec-alerts">
    <div class="card-title" style="font-size:14px;color:var(--text)"><${Icon} name="shield" size=${16} />Your data on this device</div>
    <p class="muted" style="font-size:13px">Your portfolio and settings are saved only in this browser.
      Nobody else can see them, not even the person who runs the site. They don't move to your other phone or computer by
      themselves: download a backup here and restore it there.</p>
    <div class="device-actions">
      <button class="btn primary" onClick=${download}><${Icon} name="download" />Download a backup</button>
      <label class="btn"><${Icon} name="refresh" />Restore from a backup
        <input type="file" accept="application/json,.json" hidden onChange=${pick} /></label>
    </div>
    <p class="faint" style="font-size:12.5px;margin-top:12px">On iPhone, use the site from its Home Screen icon (Share →
      Add to Home Screen): Safari may delete a website's saved data if you don't open it for 7 days.</p>
    <div class="sub-block"><h3>Alerts on your phone (Telegram)</h3>
      ${telegram ? html`
        <div class="muted" style="font-size:12.5px">After each close, the bot sends you the day's signals: what to buy,
          up to which price, the stop and the target. Your share counts are here on the site.</div>
        <ol class="steps" style="margin-top:10px">
          <li><div>Press <b>Connect Telegram</b> below, then <b>Start</b> in Telegram.</div></li>
          <li><div>The bot answers <b>"Connected"</b> within about 3 hours: it checks for new people a few times a day.
            Then you get the latest signals, and new ones after each close.</div></li>
        </ol>
        <div class="device-actions">
          <a class="btn primary" href=${telegram.link} target="_blank" rel="noopener noreferrer">
            <${Icon} name="send" />Connect Telegram</a>
        </div>
        <p class="faint" style="font-size:12.5px;margin-top:10px">To stop, send <b>/stop</b> to @${telegram.bot}. Keep this
          button's link to yourself: anyone who opens it gets the messages too.</p>`
      : html`<div class="muted" style="font-size:12.5px">The site has no Telegram alerts yet. Open it after each close
          (from about 4 pm Cairo time) for the next session's orders.</div>`}
    </div>
    ${scanUrl && html`<div class="sub-block"><h3>Run a scan now (for the person who runs the site)</h3>
      <div class="muted" style="font-size:12.5px">The site scans by itself after every close. To scan now, open the
        scan on GitHub and press <b>Run workflow</b>, then the green <b>Run workflow</b> button. It needs your GitHub
        sign-in, so it only works for you. The new data shows here in about 5 minutes. During trading hours the
        prices aren't final: the site scans again after the close.</div>
      <div class="device-actions">
        <a class="btn" href=${scanUrl} target="_blank" rel="noopener noreferrer" onClick=${() => watchForData()}>
          <${Icon} name="refresh" />Run scan on GitHub</a>
      </div>
      <label class="check" style="font-size:13px"><input type="checkbox" checked=${owner}
        onChange=${e => setOwner(e.target.checked)} />Show a Run scan button at the top of every page on this device</label>
    </div>`}
    ${restore && html`<${Confirm} title="Restore this backup?" confirmLabel="Restore" danger text=${restore.text}
      onConfirm=${apply} onClose=${() => setRestore(null)} />`}
  </div>`;
}

// ------------------------------------------------------------------ alerts: Telegram + the daily scan
function AlertsCard() {
  const [reload, setReload] = useState(0);
  const { data, error } = useApi(`/alerts?r=${reload}`);   // reloads on its own, so unsaved rule edits stay
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [changeBot, setChangeBot] = useState(false);
  const [link, setLink] = useState(null);
  const tg = data && data.telegram;
  const needLink = !!(tg && tg.token_set && tg.bot && !tg.connected);
  useEffect(() => {   // your personal link to the bot: opening it and pressing Start tells the agent your chat
    if (!needLink) return;
    api('/alerts/telegram/link', { method: 'POST' }).then(r => setLink(r.url)).catch(() => setLink(null));
  }, [needLink, reload]);
  if (!data) {
    return html`<div class="card settings-section" id="sec-alerts">${error
      ? html`<${Callout} tone="bad">Couldn't load the alert settings: ${error.message}<//>`
      : html`<div class="skeleton" style="height:120px"></div>`}</div>`;
  }
  const website = data.multi_user;
  const sc = data.schedule;
  const run = async (name, call) => {
    setBusy(name);
    try {
      const r = await call();
      if (r && r.message) toast(r.message, 'ok', 9000);
    } catch (err) {
      toast(err.message, 'error', 12000);
    } finally {
      setBusy(null);
      setReload(x => x + 1);
    }
  };
  const saveToken = e => {
    e.preventDefault();
    run('token', async () => {
      const r = await api('/alerts/telegram', { method: 'POST', body: { token: token.trim() } });
      setToken('');
      setChangeBot(false);
      return r;
    });
  };
  const bot = tg.bot && tg.bot.username;
  const tokenForm = html`<form class="row" onSubmit=${saveToken}>
    <input class="input token-input" type="password" autocomplete="off" spellcheck=${false}
      placeholder="123456789:AA…" value=${token} onInput=${e => setToken(e.target.value)} />
    <button class="btn primary" type="submit" disabled=${!token.trim() || !!busy}>Save token</button></form>`;

  let body;
  if (tg.connected) {
    body = html`<div class="connected"><${Icon} name="checkCircle" />
        <div class="who">Sending to <b>${tg.chat_name || 'you'}</b>${bot ? html` through <b>@${bot}</b>` : ''}${tg.last_sent
          ? ` · last message ${fmt.datetime(tg.last_sent)}` : ''}</div>
        <button class="btn sm" disabled=${!!busy} onClick=${() => run('test', () => api('/alerts/telegram/test', { method: 'POST' }))}>
          <${Icon} name="send" />Send the latest summary</button>
        <button class="btn sm ghost" disabled=${!!busy} onClick=${() => setConfirmOff(true)}><${Icon} name="unlink" />Disconnect</button>
      </div>
      <div style="margin-top:14px"><${Switch} checked=${tg.only_action} label="Only message me on days with something to do"
        onChange=${v => run('quiet', () => api('/alerts/options', { method: 'PUT', body: { only_action: v } }))} /></div>`;
  } else if (!tg.token_set || !bot) {
    body = tg.can_set_bot
      ? html`<ol class="steps">
          <li><div><b>Create the bot.</b> In Telegram, open <a href="https://t.me/BotFather" target="_blank"
            rel="noopener">@BotFather</a>, send <b>/newbot</b> and answer its two questions: a name (for example
            “EGX alerts”) and a username ending in “bot”. It replies with a long token.</div></li>
          <li><div><b>Paste the token here.</b> It stays on ${website ? 'the server' : 'this Mac'} and is never shown again.
            ${website ? ' Everyone on the site gets their alerts through this one bot.' : ''}${tokenForm}</div></li>
          <li><div><b>Connect your own Telegram</b>, in the next step that appears here.</div></li>
        </ol>`
      : html`<${Callout}>Telegram alerts aren't set up on this site yet. Ask the person who runs it to add the bot.<//>`;
  } else {
    body = html`<ol class="steps">
        <li><div><b>Open the bot through your link.</b>${' '}${link
          ? html`<a class="btn sm primary" style="margin-left:6px" href=${link} target="_blank" rel="noopener">
              <${Icon} name="send" />Open @${bot} in Telegram</a>`
          : html`<span class="faint">Preparing your link…</span>`}</div></li>
        <li><div><b>Press Start</b> at the bottom of the chat.</div></li>
        <li><div><b>Come back and press Connect.</b>
          <div class="row"><button class="btn primary" disabled=${!link || !!busy}
            onClick=${() => run('connect', () => api('/alerts/telegram/connect', { method: 'POST' }))}>
            <${Icon} name="check" />Connect</button></div></div></li>
      </ol>`;
  }
  return html`<div class="card settings-section" id="sec-alerts">
    <div class="card-title" style="font-size:14px;color:var(--text)"><${Icon} name="bell" size=${16} />Alerts on your phone (Telegram)</div>
    <p class="muted" style="font-size:13px;margin-bottom:16px">After each scan, your orders for the next session arrive in Telegram:
      what to sell, which stops to move up and what to buy. Free, and set up once.</p>
    ${body}
    ${tg.error && html`<div style="margin-top:12px"><${Callout} tone="bad">The last message failed
      (${fmt.datetime(tg.error.at)}): ${tg.error.message}<//></div>`}
    ${tg.can_set_bot && tg.token_set && bot && html`<div class="sub-block">
      <h3>The bot</h3>
      <div class="muted" style="font-size:12.5px">@${bot} · token ${tg.token_hint}.${website
        ? ' If you change the bot, everyone has to connect again.' : ''}${' '}
        <button class="linkish" onClick=${() => setChangeBot(x => !x)}>${changeBot ? 'Cancel' : 'Use a different bot'}</button></div>
      ${changeBot && tokenForm}
    </div>`}

    ${sc && html`<div class="sub-block">
      <h3>Daily scan</h3>
      ${sc.supported
        ? html`<${Switch} checked=${sc.on} label="Scan by itself every trading day, even when the dashboard is closed"
            onChange=${on => run('schedule', () => api('/alerts/schedule', { method: 'POST', body: { on } }))} />
          <div class="f-help" style="font-size:12.5px;color:var(--text-3)">Sunday–Thursday at ${sc.times[0]}, and again
            at ${sc.times.slice(1).join(' and ')} if prices were late. Your Mac needs to be on; if it's asleep, the scan runs as
            soon as it wakes. ${tg.connected ? 'Each new close is sent to Telegram.' : 'Connect Telegram above to get the results on your phone.'}</div>
          ${sc.moved && html`<${Callout} tone="warn">The project folder has moved since the daily scan was turned on.
            Turn it off and on again.<//>`}
          ${sc.last_run && html`<div class="muted" style="font-size:12.5px">Last run ${fmt.datetime(sc.last_run.at)}:${' '}
            <span class=${sc.last_run.ok ? '' : 'down'}>${sc.last_run.message}</span></div>`}`
        : html`<p class="muted" style="font-size:13px">The daily scan can only be set up on a Mac. While the dashboard is
            open it still scans by itself.</p>`}
    </div>`}
    ${confirmOff && html`<${Confirm} title="Disconnect Telegram?" confirmLabel="Disconnect" danger
      text=${website ? "You'll stop getting messages. You can connect again any time."
        : 'The agent stops sending messages and the bot token is removed from this Mac. You can connect again any time.'}
      onConfirm=${() => run('off', () => api('/alerts/telegram', { method: 'DELETE' }))} onClose=${() => setConfirmOff(false)} />`}
  </div>`;
}
