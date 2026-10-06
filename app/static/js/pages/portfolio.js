// My Portfolio: account tiles, then three tabs. Positions: open positions (sell, bonus shares, dividends,
// transactions), log a buy, closed trades. Health: sectors, money at risk, how your stocks move together, your
// account against EGX30. Journal: how your closed trades did, including after inflation.
import {
  html, useApi, useState, useEffect, useStore, api, toast, refreshAll, fmt, tone, cls, go, todayISO, STATIC,
} from '../lib.js';
import {
  Icon, Kpi, PageHead, SectionHead, PageLoading, DataTable, StockCell, Field,
  StockPicker, Confirm, Callout, Seg, Empty, useQuotes, livePosition, PositionCard, More, DateInput, lastSession,
} from '../ui.js';
import { t, tn, tp } from '../i18n.js';
import { LineChart } from '../charts.js';
import { orderFee, newAverage } from '../local/engine.js';
import { equityCurve, correlations, sectorMix, stopRisk, journal, inMoney, checkup } from '../insights.js';

const TABS = [{ value: 'positions', label: 'My stocks' }, { value: 'health', label: 'Checkup' },
  { value: 'journal', label: 'Past trades' }];
// Two ways to add a buy: type it in, or (on the website) read it from a screenshot of your broker's app.
const ADD = [{ value: 'type', label: 'Type it in' }, { value: 'shot', label: 'From a screenshot' }];
const scrollTo = (id, block = 'start') => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block });

export function PortfolioPage({ route }) {
  const { data, error } = useApi('/portfolio');
  const [openId, setOpenId] = useState(route.query.open ? Number(route.query.open) : null);
  const [add, setAdd] = useState(route.query.buy ? 'type' : null);   // the buy box, open only when asked for
  const [closedId, setClosedId] = useState(null);
  useEffect(() => { if (route.query.open) setOpenId(Number(route.query.open)); }, [route.query.open]);
  useEffect(() => { if (route.query.buy) setAdd('type'); }, [route.query.buy]);
  useEffect(() => { if (data && route.query.open) setTimeout(() => scrollTo(`pos-${route.query.open}`), 50); }, [!!data, route.query.open]);
  const q = useQuotes(data ? data.positions.map(p => p.symbol) : []);
  if (!data) return html`<${PageLoading} error=${error} />`;
  const s = data.summary;
  const openClosed = data.closed.find(r => r.id === closedId) || null;
  const list = data.positions.map(p => livePosition(p, q));
  const live = list.some(p => p.live);
  const openPnl = list.reduce((a, p) => a + p.pnl, 0);
  const equity = s.equity + list.reduce((a, p) => a + (p.price - p.last) * p.shares, 0);
  const startAdd = mode => { setAdd(mode); setTimeout(() => scrollTo('buy-form'), 0); };
  const closeCard = id => { setOpenId(null); setTimeout(() => scrollTo(`pos-${id}`, 'nearest'), 0); };
  const closedColumns = [
    { key: 'symbol', label: 'Stock', render: r => html`<${StockCell} symbol=${r.symbol} sub=${false} />` },
    { key: 'entry_date', label: 'Bought', fmt: v => fmt.date(v) },
    { key: 'exit_date', label: 'Sold', fmt: v => fmt.date(v) },
    { key: 'return_pct', label: 'Return', align: 'r', fmt: v => html`<span class=${tone(v)}>${fmt.pct(v)}</span>` },
    { key: 'pnl', label: 'Profit / loss (EGP)', align: 'r', fmt: v => html`<b class=${tone(v)}>${fmt.signed(v)}</b>` },
    { key: 'exit_reason', label: 'Why sold', render: r => html`<span class="muted">${tn(r.exit_reason) || '–'}</span>` },
  ];
  const cs = data.closed_stats;
  // Past trades: every closed trade (tap one to edit or delete it on the website), then the journal
  const closedSection = data.closed.length > 0 && html`    <section class="section">
      <${SectionHead} title="Closed trades" count=${cs.count}
        hint=${cs.count ? t('Won {pct} · total {v} EGP', { pct: fmt.pct(cs.win_rate, 0, false), v: fmt.signed(cs.total) }) : ''} />
      <div class="card flush"><${DataTable} columns=${closedColumns} rows=${data.closed} rowKey=${r => r.id}
        empty="Nothing closed yet." onRowClick=${STATIC ? r => setClosedId(id => (id === r.id ? null : r.id)) : undefined}
        expandedKey=${closedId} /></div>
      ${STATIC && data.closed.length > 0 && !openClosed && html`<p class="faint" style="font-size:12.5px;margin-top:8px">${t('Tap a closed trade to edit or delete it.')}</p>`}
      ${openClosed && html`<${ClosedDetail} r=${openClosed} data=${data} onClose=${() => setClosedId(null)} />`}
    </section>`;
  const tab = TABS.some(x => x.value === route.query.tab) ? route.query.tab : 'positions';
  const pickTab = v => go(v === 'positions' ? '#/portfolio' : `#/portfolio?tab=${v}`);
  return html`
    <${PageHead} title="My Portfolio" sub="The trades you placed with your broker, checked against the exit rules after each close.">
      <button class="btn primary" onClick=${() => startAdd('type')}><${Icon} name="plus" />${t('Log a buy')}</button>
      ${STATIC && html`<button class="btn" onClick=${() => startAdd('shot')}><${Icon} name="camera" />${t('From a screenshot')}</button>`}<//>
    ${data.nothing_saved && html`<div style="margin-bottom:14px"><${Callout} tone="warn"><b>${t('Nothing is saved in this browser yet.')}</b>${' '}
      ${tp('Your portfolio is kept only in the browser where you entered it, and links opened from Telegram or another app can open a different browser. Open the site there, or bring your portfolio here with {link}.',
        { link: html`<a href="#/settings">${t('Settings → Restore from a backup')}</a>` })}<//></div>`}
    ${add && html`<section class="section" id="buy-form" style="margin-top:0;margin-bottom:24px;scroll-margin-top:80px">
      <${SectionHead} title="Log a buy" hint=${add === 'shot'
        ? "A picture of your broker's portfolio screen (Thndr or another): the holdings fill in by themselves."
        : 'Record a buy you placed at your broker.'}>
        ${STATIC && html`<${Seg} options=${ADD} value=${add} onChange=${setAdd} />`}
        <button class="btn sm ghost" onClick=${() => setAdd(null)}><${Icon} name="x" size=${14} />${t('Close')}</button><//>
      ${STATIC && add === 'shot' ? html`<div class="card"><${ImportPanel} data=${data} /></div>`
        : html`<${BuyForm} data=${data} query=${route.query} onDone=${() => setAdd(null)} />`}
    </section>`}
    <div class="kpis">
      <${Kpi} label="Account value" value=${fmt.short(equity)}
        sub=${`${fmt.pct(equity / s.start - 1)} ${t('since start')} · ${t('cash {value}', { value: fmt.short(s.cash) })}`}
        subClass=${s.cash < 0 ? 'warn' : tone(equity / s.start - 1)} />
      <${Kpi} label="Open profit / loss" value=${fmt.signed(openPnl)} valueClass=${tone(openPnl)}
        sub=${live ? 'EGP after buy fees, live (~15 min late)' : 'EGP after buy fees, at the last close'} />
      <${Kpi} label="Closed profit / loss" value=${fmt.signed(s.realized)} valueClass=${tone(s.realized)}
        sub=${s.dividends ? t('EGP after fees · incl. {n} dividends', { n: fmt.int(s.dividends) }) : 'EGP after fees'} />
      <${Kpi} label="Loss if all stops hit" value=${fmt.short(s.open_risk)}
        sub=${s.equity ? t('{pct} of your account', { pct: fmt.pct(s.open_risk / s.equity, 1, false) }) : ''} />
    </div>
    <div style="margin-top:16px"><${Seg} options=${TABS} value=${tab} onChange=${pickTab} /></div>
    ${tab === 'health' ? html`<${HealthTab} data=${data} />` : tab === 'journal' ? html`${closedSection}<${JournalTab} data=${data} />` : html`
    <section class="section">
      <${SectionHead} title="Open positions" count=${data.positions.length}
        hint=${data.positions.length ? 'Sell or edit opens the sale form and the position\'s history.' : ''} />
      ${list.length ? html`<div class="pos-grid">${list.map(p => html`<${PositionCard} p=${p} key=${p.id}
          hold=${{ max: data.max_hold_days, review: data.review_day }} open=${openId === p.id}
          onOpen=${() => (openId === p.id ? closeCard(p.id) : setOpenId(p.id))}>
          ${openId === p.id && html`<${PositionDetail} p=${p} data=${data} onDone=${() => setOpenId(null)}
            onClose=${() => closeCard(p.id)} />`}<//>`)}</div>`
        : html`<div class="card"><${Empty} icon="briefcase" title="No open positions"
          text="After you buy at your broker, press Log a buy above." /></div>`}
    </section>

    <section class="section">
      <p class="faint" style="font-size:12.5px;margin-top:10px">${t('Starting capital {v}', { v: fmt.egp(s.start) })}${' '}
        (<a href="#/settings">${t('change it in Settings')}</a>). ${data.fee_cfg.broker === 'other' ? t('Profit and loss include {fee}% fees each way.', { fee: data.fee_pct })
          : t("Profit and loss include Thndr's fees each way.")} ${t('Open positions count the buy fees only, like your broker: the selling fees count once you sell.')}</p>
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
            sub=${t('since {date}', { date: fmt.date(curve.time[0]) })} />
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
            ${t('More than 40% in one sector: news about that sector moves much of your account at once.')}</p>`}
        </div>
      </section>

      <section class="section">
        <${SectionHead} title="If every stop were hit" hint="What you'd lose from today's prices if every position fell to its stop." />
        <div class="card">
          ${data.positions.length ? html`
            <div class="calc-shares down" style="font-size:26px">${fmt.egp(risk.total ? -risk.total : 0)}${' '}
              <span>${t('{pct} of your account', { pct: fmt.pct(risk.pct, 1, false) })}</span></div>
            <div class="stat-list" style="margin-top:10px">${risk.rows.map(r => html`
              <span class="k">${r.symbol}${r.locked ? html` <span class="tag">${t('stop above your price')}</span>` : ''}</span>
              <span class="v">${fmt.egp(r.loss ? -r.loss : 0)}<span class="faint" style="font-weight:500"> ${fmt.pct(-r.pct, 1)}</span></span>`)}</div>
            <p class="faint" style="font-size:12px;margin-top:10px">${t('Your limit of {limit}% counts the risk from your buy prices: {now} now.',
              { limit: data.max_open_risk_pct, now: fmt.pct(s.equity ? s.open_risk / s.equity : 0, 1, false) })}${' '}
              ${s.equity && s.open_risk / s.equity * 100 > data.max_open_risk_pct
              ? t('That is over the limit, so the agent sizes new buys at 0 until it comes down.') : ''} ${t('A gap through a stop can lose more.')}</p>`
          : html`<p class="muted" style="font-size:13px">${t('No open positions.')}</p>`}
        </div>
      </section>
    </div>

    <section class="section">
      <${SectionHead} title="How your stocks move together"
        hint="Correlation of daily moves over the last 60 sessions: 1 means they rise and fall together, 0 means unrelated." />
      <div class="card">${held.length < 2 ? html`<p class="muted" style="font-size:13px">${t('This needs at least two open positions.')}</p>`
        : !corr ? html`<${PageLoading} error=${error} />` : html`
        <p style="font-size:13.5px;margin-bottom:12px">${corr.average == null ? t('Not enough shared history yet.')
          : html`${tp('On average your stocks {how} ({r}).', { how: html`<b>${t(togetherWords(corr.average))}</b>`, r: fmt.num(corr.average, 2) })}${' '}
            ${t(corr.average >= 0.5 ? 'A bad day for one is likely a bad day for most: your risk adds up more than the stops suggest.'
              : 'That spreads your risk: they rarely all fall together.')}`}</p>
        <div class="stat-list">${corr.pairs.map(p => html`
          <span class="k">${p.a} & ${p.b}</span>
          <span class="v"><b class=${p.r >= 0.7 ? 'warn' : ''}>${fmt.num(p.r, 2)}</b>
            <span class="faint" style="font-weight:500"> ${t(togetherWords(p.r))}</span></span>`)}</div>`}
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
  const groupCols = first => [
    { key: 'label', label: first, render: g => html`<b>${first === 'Month' ? fmt.month(g.label) : tn(g.label)}</b>` },
    { key: 'n', label: 'Trades', align: 'r' },
    { key: 'win_rate', label: 'Won', align: 'r', fmt: v => fmt.pct(v, 0, false) },
    { key: 'avg_return', label: 'Average return', align: 'r', fmt: v => html`<span class=${tone(v)}>${fmt.pct(v, 1)}</span>` },
    { key: 'pnl', label: 'Profit / loss (EGP)', align: 'r', fmt: v => html`<b class=${tone(v)}>${fmt.signed(v)}</b>` },
  ];
  const tradeCols = [
    { key: 'symbol', label: 'Stock', render: r => html`<${StockCell} symbol=${r.symbol} sub=${false} />` },
    { key: 'entry_date', label: 'Bought', fmt: v => fmt.date(v) },
    { key: 'exit_date', label: 'Sold', fmt: v => fmt.date(v) },
    { key: 'days', label: 'Days', align: 'r' },
    { key: 'return_pct', label: 'Return', align: 'r', fmt: v => html`<span class=${tone(v)}>${fmt.pct(v, 1)}</span>` },
    { key: 'pnl', label: 'Profit / loss', align: 'r', fmt: v => html`<b class=${tone(v)}>${fmt.signed(v)}</b>` },
    { key: 'real_return', label: 'After inflation', align: 'r', title: "The return minus Egypt's inflation over the days you held it",
      render: r => (r.inflation == null ? html`<span class="faint">–</span>` : html`<span class=${tone(r.real_return)}>${fmt.pct(r.real_return, 1)}</span>`) },
    { key: 'source', label: 'From', render: r => html`<span class="muted">${tn(r.source)}</span>` },
    { key: 'exit_reason', label: 'Why sold', render: r => html`<span class="muted">${tn(r.exit_reason) || '–'}</span>` },
  ];
  return html`
    <section class="section">
      <div class="kpis">
        <${Kpi} label="Closed trades" value=${fmt.int(j.n)} sub=${t('held {n} days on average', { n: fmt.num(j.avg_days, 0) })} />
        <${Kpi} label="Won" value=${fmt.pct(j.win_rate, 0, false)} valueClass=${j.win_rate >= 0.5 ? 'up' : ''}
          sub=${t('average win {w} · average loss {l}', { w: fmt.pct(j.avg_win, 1), l: fmt.pct(j.avg_loss, 1) })} />
        <${Kpi} label="Profit factor" value=${j.profit_factor == null ? 'no losses' : fmt.num(j.profit_factor, 2)}
          valueClass=${j.profit_factor == null || j.profit_factor >= 1 ? 'up' : 'down'} sub="money won ÷ money lost (above 1 = profitable)" />
        <${Kpi} label="Total profit / loss" value=${fmt.signed(j.pnl)} valueClass=${tone(j.pnl)}
          sub=${t('EGP after fees and dividends · {v} a trade', { v: fmt.signed(j.per_trade) })} />
        ${j.has_inflation && html`<${Kpi} label="After inflation" value=${fmt.signed(j.real_pnl)} valueClass=${tone(j.real_pnl)}
          sub=${t('inflation took {v} EGP while your money was in', { v: fmt.int(j.pnl - j.real_pnl) })} />`}
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

// A position 30%+ under its average price: what the tests say, the sell rule (sell on the first bounce, engine.js
// onBounce) and averaging down worked out. Tests 2016–2026 (2026-10): stocks that fell this far under their 60-day
// high, the share that got back to it within 3 and 6 months, fell another 20% within 3, and the median 6 months later
// (every stock: +7.4%); and how often selling on the first bounce beat selling at once.
const BIG_LOSS = 0.30;
// Averaging down: an option only when the stock earns a buy on its own. After a 50%+ fall from its 3-month high the
// model's top 10% did worse than the rest (median 6 months −14% against −9%, 52% fell another 20%), so not then.
const LOSS_BANDS = [
  { from: 0.30, back3: 0.09, back6: 0.25, worse: 0.28, med6: 0.096, bounce: 0.68 },
  { from: 0.50, back3: 0.03, back6: 0.08, worse: 0.43, med6: -0.109, bounce: 0.64 },
];

function BigLossPlan({ p, data }) {
  const [add, setAdd] = useState({ shares: String(p.shares), price: String(p.last) });
  const loss = p.last / p.avg_price - 1;
  const fall = Math.min(loss, p.from_high ?? 0);              // the deeper of: under your price, under its 3-month high
  const crash = (p.from_high ?? 0) <= -0.5;                  // at half its 3-month high or less
  const band = [...LOSS_BANDS].reverse().find(b => -fall >= b.from);
  const n = parseInt(add.shares, 10) || 0, price = parseFloat(add.price) || 0;
  const cost = p.avg_price * p.shares + p.fees, more = n * price + orderFee(n * price, data.fee_cfg);
  const avg = n > 0 && price > 0 ? (cost + more) / (p.shares + n) : null;
  const earns = (p.buy_signal || p.top_pick) && !crash;
  return html`<div class="big-loss">
    <h4><${Icon} name="alert" size=${15} /> ${t('Big loss plan')}</h4>
    <p>${tp('Down {loss} ({egp}). To get back to your {avg} it must rise {need}.', {
      loss: html`<b class="down">${fmt.pct(-loss, 1, false)}</b>`, egp: fmt.egp(p.pnl), avg: fmt.price(p.avg_price),
      need: html`<b>${fmt.pct(p.avg_price / p.last - 1, 0)}</b>` })}</p>
    <p class="muted">${t('Stocks that fell {pct} or more from a high, 2016–2026: {b3} got back to it within 3 months and {b6} within 6; {w} fell another 20% or more within 3 months. Their typical next 6 months: {m} (every stock: +7%).', {
      pct: fmt.pct(band.from, 0, false), b3: fmt.pct(band.back3, 0, false), b6: fmt.pct(band.back6, 0, false),
      w: fmt.pct(band.worse, 0, false), m: fmt.pct(band.med6, 0) })}</p>
    <div class="big-loss-step"><b>${t('1. Selling')}</b>
      <span>${p.status === 'BOUNCE'
        ? t('Sell at its first close above its 20-day average ({level} now), or by {date} at the latest.', { level: fmt.price(p.bounce_level), date: fmt.date(p.bounce_by) })
        : p.status === 'EXIT' ? t('The rules say sell at the next open: {why}', { why: tn(p.reason) })
          : t('Your own stop ({stop}) is still above the price, so the rules keep holding it.', { stop: fmt.price(p.stop) })}
        ${' '}<span class="faint">${t('Waiting for that first bounce beat selling at once {pct} of the time in the tests.', { pct: fmt.pct(band.bounce, 0, false) })}</span></span></div>
    <div class="big-loss-step"><b>${t('2. Averaging down')}</b>
      <span>${earns
        ? t('{sym} earns a buy on its own today ({why}), so buying more is an option: size it as a new trade with its own stop.', {
          sym: p.symbol, why: t(p.buy_signal ? 'a BUY signal' : "the model's top 10%") })
        : crash ? t("Not now: {sym} is at half its 3-month high or less. After crashes like that, even the model's top-rated stocks usually kept falling in the tests (typical next 6 months −14%).", { sym: p.symbol })
          : t("Not now: {sym} has no BUY signal and isn't in the model's top 10%. Buying more only lowers the average; it doesn't make the stock a better buy.", { sym: p.symbol })}</span>
      <div class="form-grid" style="margin-top:8px">
        <${Field} label="Buy more: shares"><input class="input" type="number" min="1" step="1" value=${add.shares}
          onInput=${e => setAdd(a => ({ ...a, shares: e.target.value }))} /><//>
        <${Field} label="At price"><input class="input" type="number" min="0.001" step="any" value=${add.price}
          onInput=${e => setAdd(a => ({ ...a, price: e.target.value }))} /><//>
      </div>
      ${avg && html`<p style="margin-top:8px">${tp('New average {avg}: it must rise {need} to break even (now {now}). Money in {sym}: {total}; another 20% fall would cost {drop} more.', {
        avg: html`<b>${fmt.price(avg)}</b>`, need: html`<b>${fmt.pct(avg / p.last - 1, 0)}</b>`, now: fmt.pct(p.avg_price / p.last - 1, 0),
        sym: p.symbol, total: fmt.egp(cost + more), drop: html`<b class="down">${fmt.egp(0.2 * p.last * (p.shares + n))}</b>` })}</p>`}
    </div>
    <p class="faint" style="font-size:12px">${t('Tested rules and numbers, not advice: the decision is yours.')}</p>
  </div>`;
}

function PositionDetail({ p, data, onDone, onClose }) {
  const [form, setForm] = useState({ date: lastSession(), shares: String(p.shares), price: String(p.price ?? p.last), reason: data.sell_reasons[0] });
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showDividend, setShowDividend] = useState(false);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const qty = parseInt(form.shares, 10) || 0;
  const price = parseFloat(form.price) || 0;
  const valid = qty >= 1 && qty <= p.shares && price > 0 && !!form.date;
  const pnl = valid ? (price - p.avg_price) * qty - (p.fees * qty) / p.shares - orderFee(price * qty, data.fee_cfg) : null;

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
      <h4>${t('Sell {sym}: all or part of your {n} shares', { sym: p.symbol, n: fmt.int(p.shares) })}</h4>
      <div class="form-grid">
        <${Field} label="Sell date"><${DateInput} value=${form.date} onInput=${set('date')} /><//>
        <${Field} label="Shares to sell" error=${qty > p.shares ? t('You hold {n}', { n: fmt.int(p.shares) }) : null}>
          <input class=${cls('input', qty > p.shares && 'invalid')} type="number" min="1" max=${p.shares} step="1"
            value=${form.shares} onInput=${set('shares')} required /><//>
        <${Field} label="Sell price"><input class="input" type="number" min="0.01" step="0.01" value=${form.price}
          onInput=${set('price')} required /><//>
        <${Field} label="Reason"><select class="input" value=${form.reason} onChange=${set('reason')}>
          ${data.sell_reasons.map(r => html`<option value=${r}>${tn(r)}</option>`)}</select><//>
      </div>
      <div class="row" style="margin-top:10px;gap:6px">
        <span class="faint" style="font-size:12px">${t('Quick:')}</span>
        <button type="button" class="btn sm ghost" onClick=${() => part(0.25)}>25%</button>
        <button type="button" class="btn sm ghost" onClick=${() => part(0.5)}>50%</button>
        <button type="button" class="btn sm ghost" onClick=${() => part(1)}>${t('All')}</button>
      </div>
      <div class="form-foot">
        <span class="preview">${valid
          ? html`${qty === p.shares ? t('Closes the position') : t('{n} shares stay open at {price}', { n: fmt.int(p.shares - qty), price: fmt.price(p.avg_price) })}${' · '}
              ${t('profit/loss after fees')} <b class=${tone(pnl)}>${fmt.egp(pnl)}</b>`
          : t('Enter the shares and price you sold at.')}</span>
        <button class="btn primary" type="submit" disabled=${!valid || busy}><${Icon} name="sell" />${t('Record sale')}</button>
      </div>
    </form>`;

  return html`<div class="pos-detail">
    ${!p.adjust && p.last / p.avg_price - 1 <= -BIG_LOSS && html`<${BigLossPlan} p=${p} data=${data} />`}
    ${p.adjust ? html`<${p.adjust.rights ? RightsPanel : AdjustPanel} p=${p} onDone=${onDone} />` : html`<div>${sellForm}${STATIC && p.stop != null && html`<${StopForm} p=${p} />`}</div>`}
    <div>
      <h4>${t('Transactions in this position')}${p.n_buys > 1 ? ` · ${t('{n} buys combined at the average price', { n: p.n_buys })}` : ''}</h4>
      <${Fills} fills=${p.fills} tradeId=${p.id} data=${data} onRemoveDividend=${removeDividend} />
      ${showDividend
        ? html`<${DividendForm} p=${p} onClose=${() => setShowDividend(false)} />`
        : html`<button class="linkish" style="margin-top:10px" onClick=${() => setShowDividend(true)}>
            <${Icon} name="coins" size=${14} /> ${t('Record a cash dividend')}</button>`}
      <div class="faint" style="font-size:12px;margin-top:14px">${t('First buy {a} · sell by {b}', { a: fmt.date(p.first_buy), b: fmt.date(p.sell_by) })}</div>
      <div class="row" style="margin-top:10px;justify-content:space-between">
        <button class="btn sm danger-ghost" type="button" onClick=${() => setConfirmDelete(true)}>
          <${Icon} name="trash" size=${14} />${t('Logged by mistake')}</button>
        <button class="btn sm" type="button" onClick=${onClose}><${Icon} name="x" size=${14} />${t('Close')}</button>
      </div>
    </div>
    ${confirmDelete && html`<${Confirm} title=${t('Delete the {sym} position?', { sym: p.symbol })} danger confirmLabel="Delete position"
      text="This removes the position and all its transactions, as if you never logged it. Use it only for mistakes. To record a sale, use Record sale instead."
      onConfirm=${remove} onClose=${() => setConfirmDelete(false)} />`}
  </div>`;
}

// Your own stop, e.g. right on a support you trust: from the next session, not under the automatic one (local/api.js setStop).
function StopForm({ p }) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const n = parseFloat(v);
  const save = async stop => {
    setBusy(true);
    try {
      toast((await api(`/portfolio/${p.id}/stop`, { method: 'POST', body: { stop } })).message);
      setV('');
      refreshAll();
    } catch (err) {
      toast(err.message, 'error', 9000);
    } finally {
      setBusy(false);
    }
  };
  return html`<form class="stop-form" onSubmit=${e => { e.preventDefault(); if (n > 0) save(n); }}>
    <h4>${t('Change the stop')}</h4>
    <div class="row">
      <input class="input" type="number" min="0.01" step="0.001" value=${v} onInput=${e => setV(e.target.value)}
        placeholder=${t('Now {stop}', { stop: fmt.price(p.stop) })} aria-label=${t('New stop')} />
      <button class="btn" type="submit" disabled=${!(n > 0) || busy}><${Icon} name="shield" size=${14} />${t('Set stop')}</button>
      ${p.my_stop && html`<button type="button" class="linkish" disabled=${busy} onClick=${() => save(null)}>${t('Back to the automatic stop')}</button>`}
    </div>
    <p class="faint">${p.stops_mine ? t('From the next session (today\'s if it hasn\'t opened yet), and it stays there until you change it again.')
      : t('From the next session (today\'s if it hasn\'t opened yet), and it can still rise to a newer support.')}
      ${p.my_stop ? t('To lower it, type a lower price, as low as the automatic stop.') : ''} ${t("The automatic stop sits a little under a support so a dip that only touches it doesn't sell you; a stop right on the support sells on a touch.")}</p>
  </form>`;
}

// A trade's transactions. On the website each buy and sale can be edited or deleted, and one added: the position is
// then rebuilt from them (local/engine.js rebuildTrade). Bonus shares and dividends have their own buttons.
function Fills({ fills, tradeId, data, onRemoveDividend }) {
  const [editing, setEditing] = useState(null);      // a fill, 'new', or null
  const [deleting, setDeleting] = useState(null);
  const remove = async f => {
    try {
      toast((await api(`/portfolio/fills/${f.id}`, { method: 'DELETE' })).message);
      setDeleting(null);
      refreshAll();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  };
  const editable = f => STATIC && (f.side === 'buy' || f.side === 'sell');
  return html`<table class="mini-table"><thead><tr><th>${t('Date')}</th><th>${t('Side')}</th><th class="r">${t('Shares')}</th><th class="r">${t('Price')}</th>
      <th class="r">${t('Fees')}</th><th>${t('Note')}</th>${STATIC && html`<th></th>`}</tr></thead>
      <tbody>${fills.map(f => html`<tr class=${editing && editing.id === f.id ? 'editing' : ''}><td>${fmt.date(f.date)}</td><td><span class=${`side-tag ${f.side}`}>${t(f.side.toUpperCase())}</span></td>
        <td class="r">${f.side === 'bonus' ? fmt.signed(f.shares) : fmt.int(f.shares)}</td>
        <td class="r">${f.side === 'bonus' ? '–' : fmt.price(f.price)}</td>
        <td class="r">${f.side === 'buy' || f.side === 'sell' ? fmt.num(f.fees, 2) : '–'}</td>
        <td class="muted">${f.side === 'dividend' ? html`<b class="up">+${fmt.egp(f.amount, 2)}</b> ${tn(f.note)}
          ${onRemoveDividend && html`<button class="x-btn" title=${t('Remove this dividend')} onClick=${() => onRemoveDividend(f.dividend_id)}><${Icon} name="x" size=${13} /></button>`}`
          : tn(f.note) || ''}</td>
        ${STATIC && html`<td class="fill-actions">${editable(f) && html`
          <button class="x-btn edit" title=${t('Edit')} aria-label=${t('Edit')} onClick=${() => setEditing(f)}><${Icon} name="pencil" size=${14} /></button>
          <button class="x-btn" title=${t('Delete')} aria-label=${t('Delete')} onClick=${() => setDeleting(f)}><${Icon} name="trash" size=${14} /></button>`}</td>`}</tr>`)}</tbody></table>
    ${STATIC && (editing
      ? html`<${FillForm} key=${editing === 'new' ? 'new' : editing.id} fill=${editing === 'new' ? null : editing} tradeId=${tradeId} data=${data}
          onClose=${() => setEditing(null)} />`
      : html`<button class="linkish" style="margin-top:10px;margin-inline-end:16px" onClick=${() => setEditing('new')}>
          <${Icon} name="plus" size=${14} /> ${t('Add a transaction')}</button>`)}
    ${deleting && html`<${Confirm} danger confirmLabel="Delete"
      title=${t('Delete this {side}?', { side: t(deleting.side === 'buy' ? 'buy' : 'sale') })}
      text=${t('{n} shares at {price} on {date}. Everything after it is worked out again. Deleting the last buy deletes the whole trade.',
        { n: fmt.int(deleting.shares), price: fmt.price(deleting.price), date: fmt.date(deleting.date) })}
      onConfirm=${() => remove(deleting)} onClose=${() => setDeleting(null)} />`}`;
}

const SIDES = [{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }];

// Add a buy or sale to a trade, or edit one (fill).
// What you type for a buy: the order's price (the site adds the fees), or your broker's average cost or purchase
// value, which already have the fees in them (Thndr's do), so none are added. A purchase value is divided by the
// shares. Thndr rounds the purchase value it shows (KORA: 79,082.57 against the 79,119.20 its profit/loss uses), so
// "Exact from Thndr" works it out from the same screen's market value and profit/loss.
const BASES = [{ value: 'price', label: 'Price paid' }, { value: 'avg', label: 'Average cost' }, { value: 'value', label: 'Purchase value' }];
const BASIS_HELP = {
  price: "The order's price: the site adds your broker's fees.",
  avg: "Your broker's average cost: it already has the fees in it (Thndr's does), so none are added.",
  value: "What the shares cost in all, fees in (Thndr: Purchase value). Thndr rounds it a little: Exact from Thndr gives its exact figure.",
};
const typedPrice = (f, shares) => (f.basis === 'value' ? parseFloat(f.value) / shares : parseFloat(f.price));

function AmountField({ form, setForm }) {
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  return form.basis === 'value'
    ? html`<${Field} label="Purchase value (EGP)"><input class="input" type="number" min="0.01" step="any" value=${form.value}
        onInput=${set('value')} placeholder="0.00" required /><//>`
    : html`<${Field} label=${form.basis === 'avg' ? 'Average cost' : 'Price paid'}><input class="input" type="number" min="0.001"
        step="any" value=${form.price} onInput=${set('price')} placeholder="0.00" required /><//>`;
}

function BasisPick({ form, setForm }) {
  const exact = k => e => setForm(f => {
    const n = { ...f, [k]: e.target.value };
    const mv = parseFloat(n.mv), pl = parseFloat(n.pl);
    return Number.isFinite(mv) && Number.isFinite(pl) ? { ...n, value: (mv - pl).toFixed(2) } : n;
  });
  return html`<div class="buy-basis">
    <${Seg} options=${BASES} value=${form.basis} onChange=${v => setForm(f => ({ ...f, basis: v }))} />
    <div class="f-help">${t(BASIS_HELP[form.basis])}</div>
    ${form.basis === 'value' && html`<${More} label="Exact from Thndr">
      <p class="muted" style="font-size:12.5px;margin-bottom:8px">${t("From the stock's My position screen in Thndr. Type the profit/loss with its minus sign when it's a loss: the purchase value is Market value − Profit/Loss.")}</p>
      <div class="form-grid">
        <${Field} label="Market value"><input class="input" type="number" step="any" value=${form.mv} onInput=${exact('mv')} placeholder="0.00" /><//>
        <${Field} label="Profit / loss"><input class="input" type="number" step="any" value=${form.pl} onInput=${exact('pl')} placeholder="-0.00" /><//>
      </div><//>`}
  </div>`;
}

function FillForm({ fill, tradeId, data, onClose }) {
  const [form, setForm] = useState(fill
    ? { side: fill.side, date: fill.date, shares: String(fill.shares), price: String(fill.price), note: fill.note || '',
      basis: fill.fees_in ? 'avg' : 'price', value: '', mv: '', pl: '' }
    : { side: 'buy', date: lastSession(), shares: '', price: '', note: '', basis: 'price', value: '', mv: '', pl: '' });
  const [busy, setBusy] = useState(false);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const sell = form.side === 'sell';
  const shares = parseInt(form.shares, 10) || 0, price = (sell ? parseFloat(form.price) : typedPrice(form, shares)) || 0;
  const valid = shares >= 1 && price > 0 && !!form.date;
  const feesIn = !sell && form.basis !== 'price';
  const reasons = data.sell_reasons.includes(form.note) || !form.note ? data.sell_reasons : [form.note, ...data.sell_reasons];
  const submit = async e => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    const body = { side: form.side, date: form.date, shares, price, note: sell ? (form.note || data.sell_reasons[0]) : form.note,
      fees_in: feesIn };
    try {
      const r = fill ? await api(`/portfolio/fills/${fill.id}`, { method: 'PUT', body })
        : await api(`/portfolio/${tradeId}/fills`, { method: 'POST', body });
      toast(r.message);
      onClose();
      refreshAll();
    } catch (err) {
      toast(err.message, 'error', 9000);
    } finally {
      setBusy(false);
    }
  };
  return html`<form class="fill-form" onSubmit=${submit}>
    <h4>${fill ? t(fill.side === 'buy' ? 'Edit this buy' : 'Edit this sale') : t('Add a transaction')}</h4>
    ${!fill && html`<${Seg} options=${SIDES} value=${form.side} onChange=${v => setForm(f => ({ ...f, side: v }))} />`}
    <div class="form-grid" style="margin-top:10px">
      <${Field} label="Date"><${DateInput} value=${form.date} onInput=${set('date')} /><//>
      <${Field} label="Shares"><input class="input" type="number" min="1" step="1" value=${form.shares} onInput=${set('shares')} required /><//>
      ${sell ? html`<${Field} label="Sell price"><input class="input" type="number" min="0.001" step="any" value=${form.price}
        onInput=${set('price')} required /><//>` : html`<${AmountField} form=${form} setForm=${setForm} />`}
      ${sell && html`<${Field} label="Reason"><select class="input" value=${form.note || data.sell_reasons[0]} onChange=${set('note')}>
        ${reasons.map(r => html`<option value=${r}>${tn(r)}</option>`)}</select><//>`}
    </div>
    ${!sell && html`<${BasisPick} form=${form} setForm=${setForm} />`}
    <div class="form-foot">
      <span class="preview">${!valid ? t('Enter the shares and price.') : feesIn ? html`${fmt.price(price)} · ${t('(fees already in the price)')}`
        : html`${t('Fees')} <b>${fmt.egp(orderFee(price * shares, data.fee_cfg), 2)}</b>`}</span>
      <span class="row" style="gap:8px">
        <button class="btn ghost" type="button" onClick=${onClose}>${t('Cancel')}</button>
        <button class="btn primary" type="submit" disabled=${!valid || busy}><${Icon} name="check" />${t('Save')}</button></span>
    </div>
  </form>`;
}

// A closed trade, opened from the table: its transactions (edit, delete, add) and deleting the whole trade.
function ClosedDetail({ r, data, onClose }) {
  const [confirm, setConfirm] = useState(false);
  const remove = async () => {
    try {
      toast((await api(`/portfolio/closed/${r.id}`, { method: 'DELETE' })).message);
      onClose();
      refreshAll();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  };
  return html`<div class="card" style="margin-top:12px">
    <div class="card-title"><a class="sym" href=${`#/stock/${encodeURIComponent(r.symbol)}`}>${r.symbol}</a>
      <span class="faint">${t('Bought {a} · sold {b}', { a: fmt.date(r.entry_date), b: fmt.date(r.exit_date) })}</span></div>
    ${r.source_open && html`<p class="muted" style="font-size:13px;margin-bottom:10px">${t('This was part of a position that is still open: these are all its transactions. Deleting this sale puts its shares back in the open position.')}</p>`}
    <${Fills} fills=${r.fills} tradeId=${r.source_id} data=${data} />
    <div class="row" style="margin-top:14px;justify-content:space-between">
      ${!r.source_open ? html`<button class="btn sm danger-ghost" type="button" onClick=${() => setConfirm(true)}>
        <${Icon} name="trash" size=${14} />${t('Delete this trade')}</button>` : html`<span></span>`}
      <button class="btn sm" type="button" onClick=${onClose}><${Icon} name="x" size=${14} />${t('Close')}</button>
    </div>
    ${confirm && html`<${Confirm} title=${t('Delete the {sym} trade?', { sym: r.symbol })} danger confirmLabel="Delete trade"
      text="This removes the trade and all its transactions from your history and your profit/loss, as if you never logged it."
      onConfirm=${remove} onClose=${() => setConfirm(false)} />`}
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
    <h4><${Icon} name="split" size=${15} /> ${t('{sym}: bonus shares or a split from {date}', { sym: p.symbol, date: fmt.date(a.ex_date) })}</h4>
    <div class="muted" style="font-size:13px">${tp("TradingView divided all past {sym} prices by {factor}: that's {what}. Your broker should now show about {n} shares instead of {old}. Until you confirm, this position's stop can't be checked.",
      { sym: p.symbol, factor: fmt.num(a.factor, 4), what: html`<b>${tn(a.describe)}</b>`, n: html`<b>${fmt.int(a.shares_expected)}</b>`, old: fmt.int(p.shares) })}</div>
    <div class="row" style="align-items:flex-end">
      <${Field} label="Shares you hold now (check your broker)">
        <input class="input" type="number" min="1" step="1" value=${shares} onInput=${e => setShares(e.target.value)} /><//>
      <span class="preview" style="font-size:12.5px;color:var(--text-2);flex:1;min-width:220px">${n >= 1
        ? tp("Average price {old} → {new}. Stop and target move by the same ratio. What you paid in total doesn't change.",
            { old: fmt.price(p.avg_price), new: html`<b>${fmt.price(p.avg_price / ratio)}</b>` }) : t('Enter your share count.')}</span>
    </div>
    <div class="row">
      <button class="btn primary" disabled=${busy || n < 1} onClick=${() => send({ shares: n })}><${Icon} name="check" />${t('Update position')}</button>
      <button class="btn ghost" disabled=${busy} onClick=${() => send({ ignore: true })}>${t("My shares didn't change")}</button>
    </div>
  </div>`;
}

// A rights issue: past prices were divided by the right's value, and you either subscribed to new shares (at the
// issue price) or sold your rights. Your share count and what each new share cost (local/engine.js newAverage).
function RightsPanel({ p, onDone }) {
  const a = p.adjust;
  const [shares, setShares] = useState(String(p.shares));
  const [paid, setPaid] = useState('');
  const [busy, setBusy] = useState(false);
  const n = parseInt(shares, 10) || 0, cost = parseFloat(paid) || 0;
  const more = n > p.shares;
  const ok = n >= p.shares && (!more || cost > 0);
  const send = async () => {
    setBusy(true);
    try {
      toast((await api(`/portfolio/${p.id}/adjust`, { method: 'POST', body: { event_id: a.event_id, shares: n, paid: cost } })).message);
      onDone();
      refreshAll();
    } catch (err) {
      toast(err.message, 'error', 10000);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="adjust-panel">
    <h4><${Icon} name="split" size=${15} /> ${t('{sym}: rights issue from {date}', { sym: p.symbol, date: fmt.date(a.ex_date) })}</h4>
    <div class="muted" style="font-size:13px">${tp("TradingView divided all past {sym} prices by {factor} for the rights issue. Subscribed? Enter the shares you hold now (your {old} plus the new ones) and what each new share cost. Sold your rights instead? Keep {old}. Until you confirm, this position's stop can't be checked.",
      { sym: p.symbol, factor: fmt.num(a.factor, 4), old: html`<b>${fmt.int(p.shares)}</b>` })}</div>
    <div class="row" style="align-items:flex-end">
      <${Field} label="Shares you hold now (check your broker)">
        <input class="input" type="number" min=${p.shares} step="1" value=${shares} onInput=${e => setShares(e.target.value)} /><//>
      ${more && html`<${Field} label="What each new share cost (EGP)">
        <input class="input" type="number" min="0" step="0.001" value=${paid} onInput=${e => setPaid(e.target.value)} /><//>`}
      <span class="preview" style="font-size:12.5px;color:var(--text-2);flex:1;min-width:220px">${ok
        ? tp('Average price {old} → {new}. Stop and target move with the prices.',
            { old: fmt.price(p.avg_price), new: html`<b>${fmt.price(newAverage(p.avg_price, p.shares, n, a.factor, true, cost))}</b>` })
        : t(n < p.shares ? 'Enter at least the shares you held before.' : 'Enter what each new share cost.')}</span>
    </div>
    <div class="row">
      <button class="btn primary" disabled=${busy || !ok} onClick=${send}><${Icon} name="check" />${t('Update position')}</button>
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
    <b>${t('Cash dividend on {sym}', { sym: p.symbol })}</b>
    <div class="form-grid">
      <${Field} label="Paid on"><${DateInput} weekends value=${form.date} onInput=${set('date')} /><//>
      <${Field} label="Amount received (EGP)" help="As your broker paid it, after tax.">
        <input class="input" type="number" min="0.01" step="0.01" value=${form.amount} onInput=${set('amount')} required /><//>
      <${Field} label="Note (optional)"><input class="input" value=${form.note} onInput=${set('note')} maxlength="200" /><//>
    </div>
    <div class="row">
      <span style="flex:1">${amount > 0 ? t("{v} EGP per share on your {n} shares. It adds to this position's profit / loss.", { v: fmt.num(amount / p.shares, 3), n: fmt.int(p.shares) }) : ''}</span>
      <button class="btn ghost sm" type="button" onClick=${onClose}>${t('Cancel')}</button>
      <button class="btn primary sm" type="submit" disabled=${busy || amount <= 0}><${Icon} name="check" />${t('Save dividend')}</button>
    </div>
  </form>`;
}

function BuyForm({ data, query, onDone }) {
  const stocks = useStore(s => s.stocks);
  const lastDate = useStore(s => s.status && s.status.market && s.status.market.date);
  const blank = { symbol: '', date: lastSession(), price: '', shares: '', stop: '', notes: '', basis: 'price', value: '', mv: '', pl: '' };
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
  const shares = parseInt(form.shares, 10);
  const price = typedPrice(form, shares);
  const feesIn = form.basis !== 'price';
  const stop = parseFloat(form.stop) || 0;
  const badStop = stop > 0 && price > 0 && stop >= price;
  const valid = !!form.symbol && price > 0 && shares >= 1 && !!form.date && !badStop;
  const held = data.positions.find(p => p.symbol === form.symbol);
  const signals = data.signals.map(x => x.symbol);
  // further than a day's price limit from the last close, dated on or after it: most likely an older buy logged today
  const st = stocks && stocks.find(x => x.symbol === form.symbol);
  const far = st && st.close > 0 && price > 0 && lastDate && form.date >= lastDate && Math.abs(price / st.close - 1) > 0.2;

  let preview = null;
  if (valid) {
    const cost = price * shares, fees = feesIn ? 0 : orderFee(cost, data.fee_cfg);
    preview = html`<div class="preview-box">
      <span>Cost <b>${fmt.egp(cost, feesIn ? 2 : 0)}</b> ${feesIn ? html`(${fmt.price(price)} ${t('a share')}) ${t('(fees already in the price)')}` : html`+ fees <b>${fmt.egp(fees, 2)}</b>`} · cash after <b class=${data.summary.cash - cost - fees < 0 ? 'down' : ''}>${fmt.egp(data.summary.cash - cost - fees)}</b></span>
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
        symbol: form.symbol, date: form.date, price, shares, stop: stop || null, notes: form.notes, fees_in: feesIn } });
      toast(r.message);
      setForm(blank);
      if (query.buy) go('#/portfolio');
      refreshAll();
      if (onDone) onDone();          // the buy box closes once the buy is saved
    } catch (err) {
      toast(err.message, 'error', 9000);
    } finally {
      setBusy(false);
    }
  };

  return html`<form class="card" onSubmit=${submit}>
    <div class="buy-grid">
      <${Field} label="Stock"><${StockPicker} value=${form.symbol} onChange=${pick} starred=${signals}
        placeholder=${t('Search symbol or name…')} /><//>
      <${Field} label="Buy date"><${DateInput} value=${form.date} onInput=${set('date')} /><//>
      <${AmountField} form=${form} setForm=${setForm} />
      <${Field} label="Shares"><input class="input" type="number" min="1" step="1" value=${form.shares}
        onInput=${set('shares')} placeholder="0" required /><//>
    </div>
    <${BasisPick} form=${form} setForm=${setForm} />
    <div class="buy-grid-2">
      <${Field} label="Stop-loss (optional)" error=${badStop ? 'Must be below the price you paid' : null}
        help="Leave empty to use the agent's rule."><input class=${cls('input', badStop && 'invalid')} type="number" min="0"
        step="0.01" value=${form.stop} onInput=${set('stop')} placeholder=${t('automatic')} /><//>
      <${Field} label="Notes (optional)"><input class="input" value=${form.notes} onInput=${set('notes')} maxlength="500" /><//>
    </div>
    ${far && html`<div style="margin-top:12px"><${Callout} tone="warn">${t('{sym} closed at {close} on {date}, so {price} is far from what it traded at then. If you bought earlier, set the real buy date: the stop, the day count and the exit rules start from it.', {
      sym: form.symbol, close: fmt.price(st.close), date: fmt.date(lastDate), price: fmt.price(price) })}<//></div>`}
    <div class="form-foot">
      <div style="flex:1;min-width:260px">${preview || html`<span class="faint" style="font-size:12.5px">${t("⭐ = today's BUY signals. Buying more of a stock you already hold adds the shares to that position at the average price, and the 1-month limit keeps counting from your first buy.")}</span>`}</div>
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

// A stock you already hold, checked by what you paid, fees in: the picture's market value − profit/loss (exact,
// whatever the price did since) against this site's average × shares + buy fees (the bot's check, worker/bot.js).
function HeldCheck({ r, p }) {
  const here = p.avg_price * p.shares + (p.fees || 0);
  return Math.abs(r.cost - here) <= Math.max(3, here * 1e-4)
    ? html`<span class="up">${t('Already in My Portfolio, and it matches: you paid {v} EGP, fees in.', { v: fmt.int(here) })}</span>`
    : html`<span class="warn">${t('Already in My Portfolio: you paid {a} EGP on the picture, {b} EGP here. Fix it with Sell or edit.', { a: fmt.int(r.cost), b: fmt.int(here) })}</span>`;
}

function ImportPanel({ data }) {
  const stocks = useStore(s => s.stocks) || [];
  const [linked, setLinked] = useState(null);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState(null);
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
      const syms = got.holdings.map(h => matchStock(stocks, h));
      const ask = [...new Set(syms.filter(known))].join(',');
      const q = ask ? await api(`/quotes?s=${encodeURIComponent(ask)}`).catch(() => ({})) : {};
      const now = sym => (q[sym] && q[sym].price) || (stocks.find(s => s.symbol === sym) || {}).close;
      setRows(got.holdings.map((h, i) => {
        const symbol = syms[i];
        // Market value − profit/loss is exactly what you paid, fees in (Thndr's own sum); with no share count on the
        // picture (Thndr's list of stocks), the shares are the market value ÷ the price now.
        const cost = h.value && h.pnl != null && h.value - h.pnl > 0 ? h.value - h.pnl : null;
        const shares = h.shares || (cost && now(symbol) ? Math.round(h.value / now(symbol)) : null);
        const price = cost && shares ? cost / shares : h.avg_price || h.last;
        return { id: i, symbol, name: h.name || '', shares: String(shares || ''), price: price ? String(+price.toFixed(4)) : '',
          cost, value: h.value, pnl: h.pnl, est: !h.shares && !!shares, at: now(symbol), date: lastSession(),
          guessed: !cost && !h.avg_price, on: known(symbol) && !held(symbol) && !!(cost || h.avg_price) };
      }));
    } catch (err) {
      toast(t(err.message), 'error', 9000);
    } finally {
      setBusy(false);
    }
  };
  const edit = (id, k) => e => setRows(rs => rs.map(r => {
    if (r.id !== id) return r;
    const v = k === 'on' ? e.target.checked : k === 'symbol' ? e.target.value.toUpperCase().trim() : e.target.value;
    const n = parseInt(v, 10);         // fewer or more shares for the same total paid: the average follows
    return { ...r, [k]: v, ...(k === 'shares' ? { est: false } : {}),
      ...(k === 'shares' && r.cost && n >= 1 ? { price: String(+(r.cost / n).toFixed(4)) } : {}) };
  }));
  const ok = r => known(r.symbol) && parseInt(r.shares, 10) >= 1 && parseFloat(r.price) > 0;
  const chosen = (rows || []).filter(r => r.on && ok(r));
  const add = async () => {
    setBusy(true);
    let done = 0;
    for (const r of chosen) {
      try {
        await api('/portfolio/buy', { method: 'POST', body: { symbol: r.symbol, date: r.date, price: parseFloat(r.price),
          shares: parseInt(r.shares, 10), stop: null, notes: t('Added from a screenshot'), fees_in: !r.guessed } });
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
    <p class="muted" style="font-size:13px">${t('Take a screenshot of your holdings in your broker\'s app (Thndr\'s home screen with all your stocks works) and pick it here. The bot reads every stock on it with Cloudflare\'s free AI (about 15 seconds): each one\'s market value and profit/loss give what you paid, fees in. The picture isn\'t kept. Check every number before adding: the reader can misread.')}</p>
    <label class=${cls('btn', busy && 'disabled')} style="margin-top:10px"><${Icon} name="plus" />
      ${busy && !rows ? t('Reading the picture…') : t('Pick a screenshot')}
      <input type="file" accept="image/*" hidden disabled=${busy} onChange=${pickFile} /></label>
    ${rows && (rows.length ? html`
      <div class="table-wrap" style="margin-top:12px"><table class="table import-table">
        <thead><tr><th></th><th>${t('Stock')}</th><th class="r">${t('Shares')}</th><th class="r">${t('Average cost')}</th></tr></thead>
        <tbody>${rows.map(r => html`<tr key=${r.id} class="import-row">
          <td><input type="checkbox" checked=${r.on} disabled=${!ok(r)} onChange=${edit(r.id, 'on')}
            aria-label=${t('Add {sym}', { sym: r.symbol || r.name })} /></td>
          <td><input class="input sm" value=${r.symbol} onInput=${edit(r.id, 'symbol')} style="width:76px" />
            ${r.name && html`<div class="faint" style="font-size:11.5px" dir="auto">${r.name}</div>`}</td>
          <td class="r"><input class="input sm" type="number" min="1" step="1" value=${r.shares} onInput=${edit(r.id, 'shares')} style="width:80px" /></td>
          <td class="r"><input class="input sm" type="number" min="0.001" step="any" value=${r.price} onInput=${edit(r.id, 'price')} style="width:86px" />
            ${r.cost && html`<div class="faint" dir="auto" style="font-size:11.5px;white-space:nowrap">${t('{v} worth', { v: fmt.int(r.value) })}${' · '}<span class="num">${r.pnl >= 0 ? '+' : '−'}${fmt.int(Math.abs(r.pnl))}</span></div>`}</td>
          </tr><tr key=${`${r.id}n`} class="import-note"><td></td><td colspan="3" style="font-size:12px">
            ${r.on && html`<div class="import-date"><span class="muted">${t('Bought on')}</span>
              <${DateInput} small value=${r.date} onInput=${edit(r.id, 'date')} /></div>`}
            ${!known(r.symbol) ? html`<span class="warn">${t("Not an EGX symbol the agent knows: type it.")}</span>`
            : held(r.symbol) && r.cost ? html`<${HeldCheck} r=${r} p=${held(r.symbol)} />`
            : held(r.symbol) ? html`<span class="warn">${t('Already in My Portfolio ({n} shares): adding joins it.', { n: fmt.int(held(r.symbol).shares) })}</span>`
            : r.guessed ? html`<span class="warn">${t('No average price on the picture: this is the last price. Type what you paid.')}</span>`
            : r.est ? html`<span class="warn">${t('Shares worked out from the market value ÷ the price now ({p}): check the units in your broker\'s app.', { p: fmt.price(r.at) })}</span>`
            : html`<span class="faint">${t('New position')}</span>`}</td></tr>`)}</tbody></table></div>
      <div class="row" style="margin-top:12px;gap:12px;flex-wrap:wrap;align-items:center">
        <span class="faint" style="flex:1;min-width:220px;font-size:12.5px">${t("Each stock's date sets its stop and target from the chart on that day: change it if you bought earlier.")}</span>
        <button class="btn primary" disabled=${busy || !chosen.length} onClick=${add}>
          ${t('Add {n} to My Portfolio', { n: chosen.length })}</button>
      </div>` : html`<p class="muted" style="margin-top:12px;font-size:13px">${t('No holdings found on that picture. Try a screenshot of the portfolio screen itself.')}</p>`)}
  </div>`;
}
