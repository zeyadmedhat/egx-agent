// My Portfolio: account tiles, then three tabs. Positions: open positions (sell, bonus shares, dividends,
// transactions), log a buy, closed trades. Health: sectors, money at risk, how your stocks move together, your
// account against EGX30. Journal: how your closed trades did, including after inflation.
import {
  html, useApi, useState, useEffect, useStore, api, toast, refreshAll, fmt, tone, cls, go, todayISO, STATIC,
} from '../lib.js';
import {
  Icon, StatusChip, Kpi, PageHead, SectionHead, PageLoading, DataTable, StockCell, DayBar, Field,
  StockPicker, Confirm, Callout, Seg, Empty, LiveQuotes, LIVE_NOTE, Fold, More,
} from '../ui.js';
import { t, tn } from '../i18n.js';
import { LineChart } from '../charts.js';
import { equityCurve, correlations, sectorMix, stopRisk, journal, inMoney, checkup } from '../insights.js';

const TABS = [{ value: 'positions', label: 'Positions' }, { value: 'health', label: 'Health' },
  { value: 'journal', label: 'Journal' }];

export function PortfolioPage({ route }) {
  const { data, error } = useApi('/portfolio');
  const [openId, setOpenId] = useState(route.query.open ? Number(route.query.open) : null);
  useEffect(() => { if (route.query.open) setOpenId(Number(route.query.open)); }, [route.query.open]);
  if (!data) return html`<${PageLoading} error=${error} />`;
  const s = data.summary;
  const scrollToBuy = () => document.getElementById('buy-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const posColumns = [
    { key: 'symbol', label: 'Stock', render: r => html`<${StockCell} symbol=${r.symbol} info=${r.info}
        sub=${r.n_buys > 1 ? `${r.n_buys} buys combined` : r.info.name_ar} />` },
    { key: 'status', label: 'Status', sortValue: r => ['ADJUST', 'EXIT', 'REVIEW', 'TIGHTEN STOP', 'HOLD'].indexOf(r.status),
      render: r => html`<${StatusChip} status=${r.status} />` },
    { key: 'reason', label: 'What to do', sortable: false, render: r => html`<span class="muted" style="font-size:12.5px">${tn(r.reason)}</span>` },
    { key: 'shares', label: 'Shares', align: 'r', fmt: v => fmt.int(v) },
    { key: 'avg_price', label: 'Avg price', align: 'r', fmt: v => fmt.price(v) },
    { key: 'last', label: 'Last', align: 'r', fmt: v => fmt.price(v) },
    { key: 'pnl', label: 'P&L after fees', align: 'r', render: r => html`<div class=${tone(r.pnl)}><b>${fmt.signed(r.pnl)}</b>
        <div class="sub" style="color:inherit;opacity:.85">${fmt.pct(r.pnl_pct)}</div></div>` },
    { key: 'stop', label: 'Stop now', align: 'r', fmt: v => html`<span class="down">${fmt.price(v)}</span>` },
    { key: 'target', label: 'Target', align: 'r', fmt: v => html`<span class="up">${fmt.price(v)}</span>` },
    { key: 'day', label: 'Held', width: '140px', render: r => html`<${DayBar} day=${r.day} max=${data.max_hold_days} review=${data.review_day} />` },
    { key: 'open', label: '', sortable: false, render: r => html`<span class="faint"><${Icon} name=${openId === r.id ? 'down' : 'chevron'} size=${16} /></span>` },
  ];
  const closedColumns = [
    { key: 'symbol', label: 'Stock', render: r => html`<${StockCell} symbol=${r.symbol} sub=${false} />` },
    { key: 'entry_date', label: 'First buy', fmt: v => fmt.date(v) },
    { key: 'entry_price', label: 'Avg cost', align: 'r', fmt: v => fmt.price(v) },
    { key: 'exit_date', label: 'Sold', fmt: v => fmt.date(v) },
    { key: 'exit_price', label: 'Sell price', align: 'r', fmt: v => fmt.price(v) },
    { key: 'shares', label: 'Shares', align: 'r', fmt: v => fmt.int(v) },
    { key: 'return_pct', label: 'Return', align: 'r', fmt: v => html`<span class=${tone(v)}>${fmt.pct(v)}</span>` },
    { key: 'pnl', label: 'P&L (EGP)', align: 'r', fmt: v => html`<b class=${tone(v)}>${fmt.signed(v)}</b>` },
    { key: 'exit_reason', label: 'Reason', render: r => html`<span class="muted">${r.exit_reason || '–'}</span>` },
  ];
  const cs = data.closed_stats;
  const tab = TABS.some(x => x.value === route.query.tab) ? route.query.tab : 'positions';
  const pickTab = v => go(v === 'positions' ? '#/portfolio' : `#/portfolio?tab=${v}`);
  return html`
    <${PageHead} title="My Portfolio"
      sub="Log the trades you place with your broker. After each close the agent checks every position against the exit rules.">
      <button class="btn primary" onClick=${scrollToBuy}><${Icon} name="plus" />${t('Log a buy')}</button><//>
    ${data.nothing_saved && html`<div style="margin-bottom:14px"><${Callout} tone="warn"><b>Nothing is saved in this
      browser yet.</b> Your portfolio is kept only in the browser where you entered it, and links opened from Telegram
      or another app can open a different browser. Open the site there, or bring your portfolio here with${' '}
      <a href="#/settings">Settings → Restore from a backup</a>.<//></div>`}
    <div class="kpis">
      <${Kpi} label="Account value" value=${fmt.short(s.equity)}
        sub=${`${fmt.pct(s.return_pct)} ${t('since start')} · ${t('cash {value}', { value: fmt.short(s.cash) })}`}
        subClass=${s.cash < 0 ? 'warn' : tone(s.return_pct)} />
      <${Kpi} label="Open P&L" value=${fmt.signed(s.unrealized)} valueClass=${tone(s.unrealized)} sub="EGP, before selling fees" />
      <${Kpi} label="Realized P&L" value=${fmt.signed(s.realized)} valueClass=${tone(s.realized)}
        sub=${s.dividends ? `EGP, after fees · incl. ${fmt.int(s.dividends)} dividends` : 'EGP, after fees'} />
      <${Kpi} label="Loss if all stops hit" value=${fmt.short(s.open_risk)}
        sub=${s.equity ? `from your buy prices: ${fmt.pct(s.open_risk / s.equity, 1, false)} of your account` : ''} />
    </div>
    <p class="faint" style="font-size:12.5px;margin-top:10px">Starting capital ${fmt.egp(s.start)}${' '}
      (<a href="#/settings">change it in Settings</a>). P&L includes ${data.fee_pct}% fees per side.</p>
    <div style="margin-top:16px"><${Seg} options=${TABS} value=${tab} onChange=${pickTab} /></div>
    ${tab === 'health' ? html`<${HealthTab} data=${data} />` : tab === 'journal' ? html`<${JournalTab} data=${data} />` : html`
    <section class="section">
      <${SectionHead} title="Open positions" count=${data.positions.length}
        hint="Click a position to sell some or all of it, see its transactions or delete it." />
      <div class="card flush"><${DataTable} columns=${posColumns} rows=${data.positions} rowKey=${r => r.id}
        expandedKey=${openId} onRowClick=${r => setOpenId(id => (id === r.id ? null : r.id))}
        renderExpanded=${r => html`<${PositionDetail} p=${r} data=${data} onDone=${() => setOpenId(null)} />`}
        empty="No open positions. After you buy at your broker, log it below." /></div>
      <${More} label="What the statuses mean"><p>EXIT: sell at the next open · REVIEW: 2 weeks without progress,
        consider exiting · TIGHTEN STOP: move your stop order up · HOLD: nothing to do · UPDATE SHARES: the company
        gave bonus shares or split its shares, so enter your new share count</p><//>
      ${data.positions.length > 0 && html`<${Fold} title="Live prices" hint="TradingView, about 15 minutes late">
        <div class="live-list"><${LiveQuotes} symbols=${data.positions.map(p => p.symbol)} title="Your stocks now" /></div>
        <p class="faint note">${t(LIVE_NOTE)}</p><//>`}
    </section>

    <section class="section" id="buy-form" style="scroll-margin-top:80px">
      <${SectionHead} title="Log a buy" hint="Record a buy you placed at your broker." />
      <${BuyForm} data=${data} query=${route.query} />
      ${STATIC && html`<${Fold} title="Add from a screenshot"
        hint="A picture of your broker's portfolio screen (Thndr or another): the holdings fill in by themselves.">
        <${ImportPanel} data=${data} /><//>`}
    </section>

    <section class="section">
      <${SectionHead} title="Closed trades" count=${cs.count}
        hint=${cs.count ? `Win rate ${fmt.pct(cs.win_rate, 0, false)} · total ${fmt.signed(cs.total)} EGP` : ''} />
      <div class="card flush"><${DataTable} columns=${closedColumns} rows=${data.closed} rowKey=${r => r.id}
        empty="Nothing closed yet." /></div>
    </section>`}`;
}

// ------------------------------------------------------------------ Health tab
const togetherWords = r => (r >= 0.7 ? 'move closely together' : r >= 0.4 ? 'often move together' : r >= 0.1
  ? 'move a little together' : 'move independently');

const UNITS = [{ value: 'egp', label: 'In pounds' }, { value: 'usd', label: 'In dollars' }, { value: 'gold', label: 'In gold' }];
const UNIT_HINT = {
  egp: 'Its value after every session since your first buy (cash plus your shares at each close), next to EGX30 and a bank deposit as if you had put the same money in them.',
  usd: "The same, in dollars at each day's rate: a rise in pounds can be a fall in dollars when the pound weakens.",
  gold: "The same, in grams of 24-carat gold at each day's price: how many grams your account would buy.",
};

function HealthTab({ data }) {
  const { data: h, error } = useApi('/portfolio/history');
  const [unit, setUnit] = useState('egp');
  const s = data.summary;
  const mix = sectorMix(data.positions, s.cash);
  const risk = stopRisk(data.positions, s.equity);
  const held = data.positions.map(p => p.symbol);
  const corr = h ? correlations(h.series, held) : null;
  const base = h ? equityCurve(h) : null;
  const units = UNITS.filter(u => u.value === 'egp' || (base && inMoney(base, h.money, u.value)));
  const curve = base && (inMoney(base, h.money, unit) || inMoney(base, h.money, 'egp'));
  const top = Math.max(...mix.map(m => m.pct), 0.01);
  const issues = data.limits ? checkup({ positions: data.positions, summary: s, limits: data.limits, mix, corr }) : [];
  const series = key => curve.time.map((d, i) => ({ time: d, value: curve[key][i] }));
  const lines = curve && [
    { title: t('Your account'), data: series('value'), area: true },
    { title: t('EGX30, same start'), color: '--text-3', dashed: true, width: 1.5, data: series('index') },
    ...(curve.deposit ? [{ title: t('Bank deposit, same start'), color: '--info', dashed: true, width: 1.5, data: series('deposit') }] : []),
  ];
  return html`
    ${data.positions.length > 0 && html`<section class="section">
      <${SectionHead} title="Checkup" hint="Your portfolio against your own limits in Settings, and what to do about anything out of line." />
      <div class="card">${issues.length ? html`<ul class="checkup">${issues.map(x => html`<li class=${x.level}>
          <${Icon} name=${x.level === 'bad' ? 'xCircle' : 'alert'} />
          <div><b>${t(x.title[0], { ...x.title[1], sector: x.title[1].sector && tn(x.title[1].sector) })}</b>
            <span>${t(x.todo[0], { ...x.todo[1], sector: x.todo[1].sector && tn(x.todo[1].sector) })}</span></div></li>`)}</ul>`
        : html`<div class="checkup-ok"><${Icon} name="checkCircle" /><span>${t('Nothing to fix: no stock or sector is too big, and your risk is inside your limits.')}</span></div>`}
      </div>
    </section>`}
    <section class="section">
      <${SectionHead} title="Your account against EGX30" hint=${UNIT_HINT[unit]}>
        ${units.length > 1 && html`<${Seg} options=${units} value=${unit} onChange=${setUnit} />`}<//>
      ${!h ? html`<${PageLoading} error=${error} />` : !curve ? html`<div class="card"><${Empty} icon="chart"
        title="No buys yet" text="Once you log a buy, your account's value is drawn here after every session." /></div>` : html`
        <div class="kpis">
          <${Kpi} label="Your account" value=${fmt.pct(curve.ret, 1)} valueClass=${tone(curve.ret)}
            sub=${`since ${fmt.date(curve.time[0])}`} />
          <${Kpi} label="EGX30 over the same time" value=${fmt.pct(curve.index_ret, 1)} valueClass=${tone(curve.index_ret)}
            sub=${curve.ret >= curve.index_ret ? 'you did better' : 'EGX30 did better'} />
          ${curve.deposit_ret != null && html`<${Kpi} label="A bank deposit" value=${fmt.pct(curve.deposit_ret, 1)}
            valueClass=${tone(curve.deposit_ret)} sub=${curve.ret >= curve.deposit_ret ? 'you did better' : 'the deposit did better'} />`}
          <${Kpi} label="Worst drop from a high" value=${fmt.pct(curve.max_drawdown, 1)}
            valueClass=${curve.max_drawdown < -0.1 ? 'down' : ''} sub="your account's biggest fall" />
        </div>
        <div class="card flush" style="margin-top:14px"><${LineChart} key=${unit} lines=${lines} height=${300}
          format=${unit === 'gold' ? 'grams' : unit === 'usd' ? 'usd' : 'egp'} /></div>
        ${curve.deposit && html`<p class="faint" style="font-size:12px;margin-top:8px">${t('The bank deposit earns the interbank rate of each day, added daily: close to what a bank certificate paid over the same time.')}</p>`}`}
    </section>

    <div class="grid grid-2" style="margin-top:4px;align-items:start">
      <section class="section">
        <${SectionHead} title="Where your money is" hint="Each sector's share of your account, at the last close." />
        <div class="card">${mix.map(m => html`<div class="mix-row">
          <div class="mix-label"><b>${tn(m.sector)}</b><span class="faint">${m.symbols.join(', ')}</span></div>
          <div class="gauge"><b class="gauge-v">${fmt.pct(m.pct, 0, false)}</b>
            <div class=${cls('bar', m.sector === 'Cash' ? '' : m.pct > 0.4 ? 'warn' : 'up')}><span style=${`width:${(m.pct / top) * 100}%`}></span></div></div>
          <span class="faint mix-value">${fmt.short(m.value)}</span></div>`)}
          ${mix.some(m => m.sector !== 'Cash' && m.pct > 0.4) && html`<p class="faint" style="font-size:12px;margin-top:10px">
            More than 40% in one sector: news about that sector moves much of your account at once.</p>`}
        </div>
      </section>

      <section class="section">
        <${SectionHead} title="If every stop were hit" hint="What you'd lose from today's prices if every position fell to its stop." />
        <div class="card">
          ${data.positions.length ? html`
            <div class="calc-shares down" style="font-size:26px">${fmt.egp(risk.total ? -risk.total : 0)}${' '}
              <span>${fmt.pct(risk.pct, 1, false)} of your account</span></div>
            <div class="stat-list" style="margin-top:10px">${risk.rows.map(r => html`
              <span class="k">${r.symbol}${r.locked ? html` <span class="tag">stop above your price</span>` : ''}</span>
              <span class="v">${r.loss ? fmt.egp(-r.loss) : '0 EGP'}<span class="faint" style="font-weight:500"> ${fmt.pct(-r.pct, 1)}</span></span>`)}</div>
            <p class="faint" style="font-size:12px;margin-top:10px">Your limit of ${data.max_open_risk_pct}% counts the risk
              from your buy prices: ${fmt.pct(s.equity ? s.open_risk / s.equity : 0, 1, false)} now${s.equity && s.open_risk / s.equity * 100 > data.max_open_risk_pct
              ? ', over the limit, so the agent sizes new buys at 0 until it comes down' : ''}. A gap through a stop can lose more.</p>`
          : html`<p class="muted" style="font-size:13px">No open positions.</p>`}
        </div>
      </section>
    </div>

    <section class="section">
      <${SectionHead} title="How your stocks move together"
        hint="Correlation of daily moves over the last 60 sessions: 1 means they rise and fall together, 0 means unrelated." />
      <div class="card">${held.length < 2 ? html`<p class="muted" style="font-size:13px">This needs at least two open positions.</p>`
        : !corr ? html`<${PageLoading} error=${error} />` : html`
        <p style="font-size:13.5px;margin-bottom:12px">${corr.average == null ? 'Not enough shared history yet.'
          : html`On average your stocks <b>${togetherWords(corr.average)}</b> (${fmt.num(corr.average, 2)}).${' '}
            ${corr.average >= 0.5 ? 'A bad day for one is likely a bad day for most: your risk adds up more than the stops suggest.'
              : 'That spreads your risk: they rarely all fall together.'}`}</p>
        <div class="stat-list">${corr.pairs.map(p => html`
          <span class="k">${p.a} & ${p.b}</span>
          <span class="v"><b class=${p.r >= 0.7 ? 'warn' : ''}>${fmt.num(p.r, 2)}</b>
            <span class="faint" style="font-weight:500"> ${togetherWords(p.r)}</span></span>`)}</div>`}
      </div>
    </section>`;
}

// ------------------------------------------------------------------ Journal tab
function JournalTab({ data }) {
  const { data: h, error } = useApi('/portfolio/history');
  if (!data.closed.length) {
    return html`<section class="section"><div class="card"><${Empty} icon="listCheck" title="Nothing closed yet"
      text="Your journal fills in as you sell: win rate, average win and loss, where your trades came from, and what's left after inflation." /></div></section>`;
  }
  if (!h) return html`<section class="section"><${PageLoading} error=${error} /></section>`;
  const j = journal(data.closed, h);
  const month = m => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  const groupCols = first => [
    { key: 'label', label: first, render: g => html`<b>${first === 'Month' ? month(g.label) : g.label}</b>` },
    { key: 'n', label: 'Trades', align: 'r' },
    { key: 'win_rate', label: 'Won', align: 'r', fmt: v => fmt.pct(v, 0, false) },
    { key: 'avg_return', label: 'Avg return', align: 'r', fmt: v => html`<span class=${tone(v)}>${fmt.pct(v, 1)}</span>` },
    { key: 'pnl', label: 'P&L (EGP)', align: 'r', fmt: v => html`<b class=${tone(v)}>${fmt.signed(v)}</b>` },
  ];
  const tradeCols = [
    { key: 'symbol', label: 'Stock', render: r => html`<${StockCell} symbol=${r.symbol} sub=${false} />` },
    { key: 'entry_date', label: 'Bought', fmt: v => fmt.date(v) },
    { key: 'exit_date', label: 'Sold', fmt: v => fmt.date(v) },
    { key: 'days', label: 'Days', align: 'r' },
    { key: 'return_pct', label: 'Return', align: 'r', fmt: v => html`<span class=${tone(v)}>${fmt.pct(v, 1)}</span>` },
    { key: 'pnl', label: 'P&L', align: 'r', fmt: v => html`<b class=${tone(v)}>${fmt.signed(v)}</b>` },
    { key: 'real_return', label: 'After inflation', align: 'r', title: "The return minus Egypt's inflation over the days you held it",
      render: r => (r.inflation == null ? html`<span class="faint">–</span>` : html`<span class=${tone(r.real_return)}>${fmt.pct(r.real_return, 1)}</span>`) },
    { key: 'source', label: 'From', render: r => html`<span class="muted">${r.source}</span>` },
    { key: 'exit_reason', label: 'Why sold', render: r => html`<span class="muted">${r.exit_reason || '–'}</span>` },
  ];
  return html`
    <section class="section">
      <div class="kpis">
        <${Kpi} label="Closed trades" value=${fmt.int(j.n)} sub=${`held ${fmt.num(j.avg_days, 0)} days on average`} />
        <${Kpi} label="Won" value=${fmt.pct(j.win_rate, 0, false)} valueClass=${j.win_rate >= 0.5 ? 'up' : ''}
          sub=${`avg win ${fmt.pct(j.avg_win, 1)} · avg loss ${fmt.pct(j.avg_loss, 1)}`} />
        <${Kpi} label="Profit factor" value=${j.profit_factor == null ? 'no losses' : fmt.num(j.profit_factor, 2)}
          valueClass=${j.profit_factor == null || j.profit_factor >= 1 ? 'up' : 'down'} sub="money won ÷ money lost (above 1 = profitable)" />
        <${Kpi} label="Total P&L" value=${fmt.signed(j.pnl)} valueClass=${tone(j.pnl)}
          sub=${`EGP after fees and dividends · ${fmt.signed(j.per_trade)} a trade`} />
        ${j.has_inflation && html`<${Kpi} label="After inflation" value=${fmt.signed(j.real_pnl)} valueClass=${tone(j.real_pnl)}
          sub=${`inflation took ${fmt.int(j.pnl - j.real_pnl)} EGP while your money was in`} />`}
      </div>
    </section>
    <div class="grid grid-2" style="align-items:start">
      <section class="section"><${SectionHead} title="Where your trades came from"
          hint="A BUY signal in the week before your buy (its setup), or your own idea." />
        <div class="card flush"><${DataTable} columns=${groupCols('From')} rows=${j.by_source} rowKey=${g => g.label} /></div></section>
      <section class="section"><${SectionHead} title="How they ended" hint="The reason you gave when selling." />
        <div class="card flush"><${DataTable} columns=${groupCols('Why sold')} rows=${j.by_exit} rowKey=${g => g.label} /></div></section>
    </div>
    <section class="section"><${SectionHead} title="By month" hint="By the month you sold." />
      <div class="card flush"><${DataTable} columns=${groupCols('Month')} rows=${j.by_month} rowKey=${g => g.label} /></div></section>
    <section class="section"><${SectionHead} title="Every closed trade" count=${j.n}
        hint="After inflation: the return minus Egypt's yearly inflation for the days you held it (CAPMAS figures via TradingView)." />
      <div class="card flush"><${DataTable} columns=${tradeCols} rows=${j.trades} rowKey=${r => r.id} /></div></section>`;
}

function PositionDetail({ p, data, onDone }) {
  const fee = data.fee_pct / 100;
  const [form, setForm] = useState({ date: todayISO(), shares: String(p.shares), price: String(p.last), reason: data.sell_reasons[0] });
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showDividend, setShowDividend] = useState(false);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const qty = parseInt(form.shares, 10) || 0;
  const price = parseFloat(form.price) || 0;
  const valid = qty >= 1 && qty <= p.shares && price > 0 && !!form.date;
  const pnl = valid ? (price - p.avg_price) * qty - (p.fees * qty) / p.shares - price * qty * fee : null;

  const submit = async e => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      const r = await api('/portfolio/sell', { method: 'POST', body: { trade_id: p.id, date: form.date, price, shares: qty, reason: form.reason } });
      toast(r.message);
      onDone();
      refreshAll();
    } catch (err) {
      toast(err.message, 'error', 9000);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    try {
      const r = await api(`/portfolio/${p.id}`, { method: 'DELETE' });
      toast(r.message);
      onDone();
      refreshAll();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  };
  const removeDividend = async id => {
    try {
      toast((await api(`/dividends/${id}`, { method: 'DELETE' })).message);
      refreshAll();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  };
  const part = f => setForm(x => ({ ...x, shares: String(Math.max(1, Math.floor(p.shares * f))) }));

  const sellForm = html`<form onSubmit=${submit}>
      <h4>Sell ${p.symbol}: all or part of your ${fmt.int(p.shares)} shares</h4>
      <div class="form-grid">
        <${Field} label="Sell date"><input class="input" type="date" value=${form.date} onInput=${set('date')} required /><//>
        <${Field} label="Shares to sell" error=${qty > p.shares ? `You hold ${fmt.int(p.shares)}` : null}>
          <input class=${cls('input', qty > p.shares && 'invalid')} type="number" min="1" max=${p.shares} step="1"
            value=${form.shares} onInput=${set('shares')} required /><//>
        <${Field} label="Sell price"><input class="input" type="number" min="0.01" step="0.01" value=${form.price}
          onInput=${set('price')} required /><//>
        <${Field} label="Reason"><select class="input" value=${form.reason} onChange=${set('reason')}>
          ${data.sell_reasons.map(r => html`<option value=${r}>${r}</option>`)}</select><//>
      </div>
      <div class="row" style="margin-top:10px;gap:6px">
        <span class="faint" style="font-size:12px">Quick:</span>
        <button type="button" class="btn sm ghost" onClick=${() => part(0.25)}>25%</button>
        <button type="button" class="btn sm ghost" onClick=${() => part(0.5)}>50%</button>
        <button type="button" class="btn sm ghost" onClick=${() => part(1)}>All</button>
      </div>
      <div class="form-foot">
        <span class="preview">${valid
          ? html`${qty === p.shares ? 'Closes the position' : `${fmt.int(p.shares - qty)} shares stay open at ${fmt.price(p.avg_price)}`}
              · P&L after fees <b class=${tone(pnl)}>${fmt.signed(pnl)} EGP</b>`
          : 'Enter the shares and price you sold at.'}</span>
        <button class="btn primary" type="submit" disabled=${!valid || busy}><${Icon} name="sell" />${t('Record sale')}</button>
      </div>
    </form>`;

  return html`<div class="pos-detail">
    ${p.adjust ? html`<${AdjustPanel} p=${p} onDone=${onDone} />` : sellForm}
    <div>
      <h4>Transactions in this position${p.n_buys > 1 ? ` · ${p.n_buys} buys combined at the average price` : ''}</h4>
      <table class="mini-table"><thead><tr><th>Date</th><th>Side</th><th class="r">Shares</th><th class="r">Price</th>
        <th class="r">Fees</th><th>Note</th></tr></thead>
        <tbody>${p.fills.map(f => html`<tr><td>${fmt.date(f.date)}</td><td><span class=${`side-tag ${f.side}`}>${f.side.toUpperCase()}</span></td>
          <td class="r">${f.side === 'bonus' ? fmt.signed(f.shares) : fmt.int(f.shares)}</td>
          <td class="r">${f.side === 'bonus' ? '–' : fmt.price(f.price)}</td>
          <td class="r">${f.side === 'buy' || f.side === 'sell' ? fmt.num(f.fees, 2) : '–'}</td>
          <td class="muted">${f.side === 'dividend' ? html`<b class="up">+${fmt.num(f.amount, 2)} EGP</b> ${f.note}
            <button class="x-btn" title="Remove this dividend" onClick=${() => removeDividend(f.dividend_id)}><${Icon} name="x" size=${13} /></button>`
            : f.note || ''}</td></tr>`)}</tbody></table>
      ${showDividend
        ? html`<${DividendForm} p=${p} onClose=${() => setShowDividend(false)} />`
        : html`<button class="linkish" style="margin-top:10px" onClick=${() => setShowDividend(true)}>
            <${Icon} name="coins" size=${14} /> Record a cash dividend</button>`}
      <div class="row" style="margin-top:14px;justify-content:space-between">
        <span class="faint" style="font-size:12px">First buy ${fmt.date(p.first_buy)} · sell by ${fmt.date(p.sell_by)}</span>
        <button class="btn sm danger-ghost" type="button" onClick=${() => setConfirmDelete(true)}>
          <${Icon} name="trash" size=${14} />Logged by mistake</button>
      </div>
    </div>
    ${confirmDelete && html`<${Confirm} title=${`Delete the ${p.symbol} position?`} danger confirmLabel="Delete position"
      text="This removes the position and all its transactions, as if you never logged it. Use it only for mistakes. To record a sale, use Record sale instead."
      onConfirm=${remove} onClose=${() => setConfirmDelete(false)} />`}
  </div>`;
}

// A bonus issue or split: past prices were divided by a ratio, so the position needs the new share count.
function AdjustPanel({ p, onDone }) {
  const a = p.adjust;
  const [shares, setShares] = useState(String(a.shares_expected));
  const [busy, setBusy] = useState(false);
  const n = parseInt(shares, 10) || 0;
  const ratio = n / p.shares;
  const send = async body => {
    setBusy(true);
    try {
      toast((await api(`/portfolio/${p.id}/adjust`, { method: 'POST', body: { event_id: a.event_id, ...body } })).message);
      onDone();
      refreshAll();
    } catch (err) {
      toast(err.message, 'error', 10000);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="adjust-panel">
    <h4><${Icon} name="split" size=${15} /> ${p.symbol}: bonus shares or a split from ${fmt.date(a.ex_date)}</h4>
    <div class="muted" style="font-size:13px">TradingView divided all past ${p.symbol} prices by ${fmt.num(a.factor, 4)}:
      that's <b>${a.describe}</b>. Your broker should now show about <b>${fmt.int(a.shares_expected)}</b> shares instead of ${fmt.int(p.shares)}.
      Until you confirm, this position's stop can't be checked.</div>
    <div class="row" style="align-items:flex-end">
      <${Field} label="Shares you hold now (check your broker)">
        <input class="input" type="number" min="1" step="1" value=${shares} onInput=${e => setShares(e.target.value)} /><//>
      <span class="preview" style="font-size:12.5px;color:var(--text-2);flex:1;min-width:220px">${n >= 1
        ? html`Average price ${fmt.price(p.avg_price)} → <b>${fmt.price(p.avg_price / ratio)}</b>. Stop and target move by the same
            ratio. What you paid in total doesn't change.` : 'Enter your share count.'}</span>
    </div>
    <div class="row">
      <button class="btn primary" disabled=${busy || n < 1} onClick=${() => send({ shares: n })}><${Icon} name="check" />Update position</button>
      <button class="btn ghost" disabled=${busy} onClick=${() => send({ ignore: true })}>My shares didn't change</button>
    </div>
  </div>`;
}

function DividendForm({ p, onClose }) {
  const [form, setForm] = useState({ date: todayISO(), amount: '', note: '' });
  const [busy, setBusy] = useState(false);
  const amount = parseFloat(form.amount) || 0;
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const submit = async e => {
    e.preventDefault();
    if (amount <= 0) return;
    setBusy(true);
    try {
      toast((await api(`/portfolio/${p.id}/dividend`, { method: 'POST', body: { date: form.date, amount, note: form.note } })).message);
      onClose();
      refreshAll();
    } catch (err) {
      toast(err.message, 'error', 9000);
    } finally {
      setBusy(false);
    }
  };
  return html`<form class="preview-box" style="margin-top:12px;gap:10px" onSubmit=${submit}>
    <b>Cash dividend on ${p.symbol}</b>
    <div class="form-grid">
      <${Field} label="Paid on"><input class="input" type="date" value=${form.date} onInput=${set('date')} required /><//>
      <${Field} label="Amount received (EGP)" help="As your broker paid it, after tax.">
        <input class="input" type="number" min="0.01" step="0.01" value=${form.amount} onInput=${set('amount')} required /><//>
      <${Field} label="Note (optional)"><input class="input" value=${form.note} onInput=${set('note')} maxlength="200" /><//>
    </div>
    <div class="row">
      <span style="flex:1">${amount > 0 ? html`${fmt.num(amount / p.shares, 3)} EGP per share on your ${fmt.int(p.shares)} shares. It adds to this position's P&L.` : ''}</span>
      <button class="btn ghost sm" type="button" onClick=${onClose}>${t('Cancel')}</button>
      <button class="btn primary sm" type="submit" disabled=${busy || amount <= 0}><${Icon} name="check" />${t('Save dividend')}</button>
    </div>
  </form>`;
}

function BuyForm({ data, query }) {
  const stocks = useStore(s => s.stocks);
  const blank = { symbol: '', date: todayISO(), price: '', shares: '', stop: '', notes: '' };
  const [form, setForm] = useState(() => ({ ...blank, symbol: query.buy || '', price: query.price || '', shares: query.shares || '' }));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!query.buy) return;
    setForm(f => ({ ...f, symbol: query.buy, price: query.price || f.price, shares: query.shares || f.shares }));
    setTimeout(() => document.getElementById('buy-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }, [query.buy, query.price, query.shares]);

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const pick = sym => {
    const st = stocks && stocks.find(x => x.symbol === sym);
    setForm(f => ({ ...f, symbol: sym, price: st && st.close != null ? String(st.close) : f.price }));
  };
  const price = parseFloat(form.price);
  const shares = parseInt(form.shares, 10);
  const stop = parseFloat(form.stop) || 0;
  const badStop = stop > 0 && price > 0 && stop >= price;
  const valid = !!form.symbol && price > 0 && shares >= 1 && !!form.date && !badStop;
  const held = data.positions.find(p => p.symbol === form.symbol);
  const signals = data.signals.map(x => x.symbol);

  let preview = null;
  if (valid) {
    const cost = price * shares, fees = (cost * data.fee_pct) / 100;
    preview = html`<div class="preview-box">
      <span>Cost <b>${fmt.egp(cost)}</b> + fees <b>${fmt.egp(fees, 2)}</b> · cash after <b class=${data.summary.cash - cost - fees < 0 ? 'down' : ''}>${fmt.egp(data.summary.cash - cost - fees)}</b></span>
      <span>${held
        ? html`Joins your ${held.symbol} position: ${fmt.int(held.shares)} → <b>${fmt.int(held.shares + shares)}</b> shares at a new average of
            <b>${fmt.price((held.avg_price * held.shares + cost) / (held.shares + shares))}</b>. Stop and target are recalculated from the average${stop ? ' (using your stop)' : ''}.`
        : stop ? html`New position with your stop at <b>${fmt.price(stop)}</b>.`
          : 'New position. The stop is set automatically just under the nearest support on the chart that day (4–12% below your price), or 2× the daily range when there is none; each evening it rises to the newest support.'}</span></div>`;
  }

  const submit = async e => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      const r = await api('/portfolio/buy', { method: 'POST', body: {
        symbol: form.symbol, date: form.date, price, shares, stop: stop || null, notes: form.notes } });
      toast(r.message);
      setForm(blank);
      if (query.buy) go('#/portfolio');
      refreshAll();
    } catch (err) {
      toast(err.message, 'error', 9000);
    } finally {
      setBusy(false);
    }
  };

  return html`<form class="card" onSubmit=${submit}>
    <div class="buy-grid">
      <${Field} label="Stock"><${StockPicker} value=${form.symbol} onChange=${pick} starred=${signals}
        placeholder="Search symbol or name…" /><//>
      <${Field} label="Buy date"><input class="input" type="date" value=${form.date} onInput=${set('date')} required /><//>
      <${Field} label="Price paid"><input class="input" type="number" min="0.01" step="0.01" value=${form.price}
        onInput=${set('price')} placeholder="0.00" required /><//>
      <${Field} label="Shares"><input class="input" type="number" min="1" step="1" value=${form.shares}
        onInput=${set('shares')} placeholder="0" required /><//>
    </div>
    <div class="buy-grid-2">
      <${Field} label="Stop-loss (optional)" error=${badStop ? 'Must be below the price you paid' : null}
        help="Leave empty to use the agent's rule."><input class=${cls('input', badStop && 'invalid')} type="number" min="0"
        step="0.01" value=${form.stop} onInput=${set('stop')} placeholder="automatic" /><//>
      <${Field} label="Notes (optional)"><input class="input" value=${form.notes} onInput=${set('notes')} maxlength="500" /><//>
    </div>
    <div class="form-foot">
      <div style="flex:1;min-width:260px">${preview || html`<span class="faint" style="font-size:12.5px">⭐ = today's BUY signals.
        Buying more of a stock you already hold adds the shares to that position at the average price, and the 1-month
        limit keeps counting from your first buy.</span>`}</div>
      <button class="btn primary" type="submit" disabled=${!valid || busy}><${Icon} name="plus" />${t('Save buy')}</button>
    </div>
  </form>`;
}

// ------------------------------------------------------------------ holdings from a broker screenshot
// The site's bot reads the picture with Cloudflare's free AI (worker/bot.js read, local/api.js readScreenshot); you
// check every row here before anything is added, and each row is logged like a buy on the form above.
const plainName = x => String(x || '').toLowerCase().replace(/[ً-ٰٟـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي')
  .replace(/ة/g, 'ه').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// A smaller JPEG of the picture (the site's page rules allow data: pictures, not blob: ones).
function shrink(file, most = 1600) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error(t("That file isn't a picture this browser can open.")));
    const reader = new FileReader();
    reader.onerror = fail;
    reader.onload = () => {
      const img = new Image();
      img.onerror = fail;
      img.onload = () => {
        const k = Math.min(1, most / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.88));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function matchStock(stocks, h) {
  if (h.symbol && stocks.some(s => s.symbol === h.symbol)) return h.symbol;
  const name = plainName(h.name);
  if (name.length >= 3) {
    const hit = stocks.find(s => { const n = plainName(s.name_ar); return n && (n.includes(name) || name.includes(n)); });
    if (hit) return hit.symbol;
  }
  return h.symbol || '';
}

function ImportPanel({ data }) {
  const stocks = useStore(s => s.stocks) || [];
  const [linked, setLinked] = useState(null);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState(null);
  const [date, setDate] = useState(todayISO());
  useEffect(() => { import('../local/api.js').then(m => setLinked(m.botStatus() === 'linked')); }, []);
  if (linked === null) return null;
  if (!linked) {
    return html`<p class="muted" style="font-size:13px">${t('Connect Telegram first (Settings → Connect Telegram): the site\'s bot reads the picture with Cloudflare\'s free AI. The picture isn\'t kept.')}
      ${' '}<a href="#/settings">${t('Settings →')}</a></p>`;
  }
  const held = sym => data.positions.find(p => p.symbol === sym);
  const known = sym => stocks.some(s => s.symbol === sym);
  const pickFile = async e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true); setRows(null);
    try {
      const m = await import('../local/api.js');
      const got = await m.readScreenshot(await shrink(file));
      setRows(got.holdings.map((h, i) => {
        const symbol = matchStock(stocks, h);
        return { id: i, symbol, name: h.name || '', shares: String(h.shares || ''), price: String(h.avg_price || h.last || ''),
          guessed: !h.avg_price, on: known(symbol) && !held(symbol) && !!h.avg_price };
      }));
    } catch (err) {
      toast(t(err.message), 'error', 9000);
    } finally {
      setBusy(false);
    }
  };
  const edit = (id, k) => e => setRows(rs => rs.map(r => (r.id === id
    ? { ...r, [k]: k === 'on' ? e.target.checked : k === 'symbol' ? e.target.value.toUpperCase().trim() : e.target.value } : r)));
  const ok = r => known(r.symbol) && parseInt(r.shares, 10) >= 1 && parseFloat(r.price) > 0;
  const chosen = (rows || []).filter(r => r.on && ok(r));
  const add = async () => {
    setBusy(true);
    let done = 0;
    for (const r of chosen) {
      try {
        await api('/portfolio/buy', { method: 'POST', body: { symbol: r.symbol, date, price: parseFloat(r.price),
          shares: parseInt(r.shares, 10), stop: null, notes: t('Added from a screenshot') } });
        done += 1;
        setRows(rs => rs.filter(x => x.id !== r.id));
      } catch (err) {
        toast(`${r.symbol}: ${err.message}`, 'error', 9000);
      }
    }
    setBusy(false);
    setRows(rs => (rs && rs.length ? rs : null));          // all added: back to the button
    if (done) { toast(t('Added {n} to My Portfolio.', { n: done })); refreshAll(); }
  };
  return html`<div class="import-panel">
    <p class="muted" style="font-size:13px">${t('Take a screenshot of the holdings screen in your broker\'s app and pick it here. The bot reads it with Cloudflare\'s free AI (about 15 seconds); the picture isn\'t kept. Check every number before adding: the reader can misread.')}</p>
    <label class=${cls('btn', busy && 'disabled')} style="margin-top:10px"><${Icon} name="plus" />
      ${busy && !rows ? t('Reading the picture…') : t('Pick a screenshot')}
      <input type="file" accept="image/*" hidden disabled=${busy} onChange=${pickFile} /></label>
    ${rows && (rows.length ? html`
      <div class="table-wrap" style="margin-top:12px"><table class="table import-table">
        <thead><tr><th></th><th>${t('Stock')}</th><th class="r">${t('Shares')}</th><th class="r">${t('Avg price')}</th><th></th></tr></thead>
        <tbody>${rows.map(r => html`<tr key=${r.id}>
          <td><input type="checkbox" checked=${r.on} disabled=${!ok(r)} onChange=${edit(r.id, 'on')}
            aria-label=${t('Add {sym}', { sym: r.symbol || r.name })} /></td>
          <td><input class="input sm" value=${r.symbol} onInput=${edit(r.id, 'symbol')} style="width:90px" />
            ${r.name && html`<div class="faint" style="font-size:11.5px" dir="auto">${r.name}</div>`}</td>
          <td class="r"><input class="input sm" type="number" min="1" step="1" value=${r.shares} onInput=${edit(r.id, 'shares')} style="width:90px" /></td>
          <td class="r"><input class="input sm" type="number" min="0.001" step="0.001" value=${r.price} onInput=${edit(r.id, 'price')} style="width:96px" /></td>
          <td style="font-size:12px">${!known(r.symbol) ? html`<span class="warn">${t("Not an EGX symbol the agent knows: type it.")}</span>`
            : held(r.symbol) ? html`<span class="warn">${t('Already in My Portfolio ({n} shares): adding joins it.', { n: fmt.int(held(r.symbol).shares) })}</span>`
            : r.guessed ? html`<span class="warn">${t('No average price on the picture: this is the last price. Type what you paid.')}</span>`
            : html`<span class="faint">${t('New position')}</span>`}</td></tr>`)}</tbody></table></div>
      <div class="row" style="margin-top:12px;gap:12px;flex-wrap:wrap;align-items:end">
        <${Field} label="Bought on" help="Sets each stop and target from the chart on that day. Change it if you bought earlier.">
          <input class="input" type="date" value=${date} onInput=${e => setDate(e.target.value)} /><//>
        <button class="btn primary" disabled=${busy || !chosen.length} onClick=${add}>
          ${t('Add {n} to My Portfolio', { n: chosen.length })}</button>
      </div>` : html`<p class="muted" style="margin-top:12px;font-size:13px">${t('No holdings found on that picture. Try a screenshot of the portfolio screen itself.')}</p>`)}
  </div>`;
}
