// Picks → Rankings: a machine-learning model's chance that a trade reaches its target before its stop. Information only.
// Next week (predict.WEEK): a short target and stop, 1.5× each stock's daily range, within 5 sessions; next 2 weeks:
// the chart's own stop and target within 10 sessions (the model that orders the BUYs).
import { html, useApi, useState, startJob, fmt, tone, cls, go, stockHref, STATIC } from '../lib.js';
import {
  Icon, Badges, Kpi, Callout, PageHead, SectionHead, PageLoading, DataTable, StockCell, Seg, JobProgress,
  useJob, StatusChip, Chance, Fold, ShariahNote, Reason,
} from '../ui.js';
import { t } from '../i18n.js';

const SHOW = [{ value: 'all', label: 'All actively traded stocks' }, { value: 'mine', label: 'Signals & my stocks' }];
const GRADE_TONE = { good: 'ok', weak: 'warn', none: 'bad' };
const HZ = 10;          // the model whose rank orders the BUYs (predict.RANK_HORIZON): about 2 weeks
const WK = 5;           // the week (predict.WEEK)
const VIEWS = [{ value: 'week', label: 'Next week' }, { value: 'two', label: 'Next 2 weeks' }];

export function PredictPage() {
  const { data, error } = useApi('/predict');
  const [show, setShow] = useState('all');
  const [view, setView] = useState('week');
  const { running } = useJob();
  if (!data) return html`<${PageLoading} error=${error} />`;
  const train = () => startJob('/predict/train');
  const head = html`<${PageHead} title="Rankings"
    sub="A model rates every actively traded stock after each close, from its chart and its company's results. The best rated BUYs get money first." />`;
  const week = view === 'week' && data.week;
  if (!data.model) {
    return html`${head}<${Intro} data=${data} onTrain=${train} running=${running} />`;
  }
  const m = data.model;
  const r = m.horizons[String(HZ)] || {};
  const rows = show === 'all' ? data.rows : data.rows.filter(x => x.action || x.held);
  const changed = m.changed || [];

  const showSeg = html`<${ShariahNote} mode=${data.shariah_filter} /><${Seg} options=${SHOW} value=${show} onChange=${setShow} />`;
  return html`${head}
    <${JobProgress} kind="train" title="Training the prediction model…" />
    ${data.week && html`<div style="margin-bottom:14px"><${Seg} options=${VIEWS} value=${view} onChange=${setView} /></div>`}
    ${week ? html`<${Week} data=${data} rows=${rows} filters=${showSeg} />` : html`
    ${changed.length > 0 && html`<div style="margin-bottom:14px"><${Callout} tone="warn">
      <b>Your stop or target settings changed since the model was trained.</b>${' '}
      Its numbers still assume the old plan. It retrains by itself after the next scan${STATIC ? '.' : html`, or${' '}
      <button class="linkish" onClick=${train} disabled=${running}>retrain it now</button>.`}<//></div>`}
    <div class="kpis">
      <${Kpi} label="Its top 10% each day: reached the target first" value=${fmt.pct(r.top.hit, 0, false)} valueClass="up"
        sub=${t('the average stock {v}', { v: fmt.pct(r.all.hit, 0, false) })} />
      <${Kpi} label="Its top 10%: average trade" value=${fmt.pct(r.top.ret, 1)} valueClass=${tone(r.top.ret)}
        sub=${t('the average stock {v}, after fees', { v: fmt.pct(r.all.ret, 1) })} />
      <${Kpi} label="Years it beat the average stock" value=${`${r.good_years} / ${(r.years || []).length}`}
        sub=${t('tested {a} – {b}', { a: fmt.date(r.from), b: fmt.date(r.to) })} />
    </div>
    ${data.health && ['weak', 'bad'].includes(data.health.status) && html`<div style="margin-top:12px"><${Health} h=${data.health} /></div>`}

    <section class="section">
      <${SectionHead} title="Today's ranking" count=${data.rows.length}
        hint=${t('From the {date} close, best first. A chance shows only for its top {n}.', { date: fmt.date(data.date), n: fmt.int(data.top_n) })}>
        ${showSeg}<//>
      <div class="card flush"><${ChanceTable} rows=${rows} base=${data.base || {}} /></div>
    </section>

    <${Fold} title="How it was tested" hint=${r.verdict}>
      <p class="muted" style="font-size:13px;margin-bottom:12px">${t('Each year was predicted by a version that had never seen it. The table replays the BUY rules on those years, with and without the model.')}</p>
      ${data.combo && data.combo.rules && html`<div class="card flush"><${ComboTable} c=${data.combo} /></div>`}
      <${About} m=${m} data=${data} r=${r} onTrain=${train} running=${running} />
    <//>
    <p class="faint note" style="margin-top:14px">${t('Even its best picks reach the target first only about {pct} of the time, so always use the stop. A second opinion, not advice.', { pct: fmt.pct(r.top.hit, 0, false) })}</p>`}`;
}

// Next week: each stock's honest chance (predict.week_chances) of rising 1.5× its daily range before falling as far
// within 5 sessions, highest first. Strong: one of its top 10% in an uptrend while the market is healthy.
function Week({ data, rows, filters }) {
  const w = data.week, tst = w.test, s = tst.strong, a = tst.all, years = tst.years || [];
  return html`
    ${w.weak && html`<div style="margin-bottom:14px"><${Callout} tone="warn"><b>${t('Weak market: better to skip short trades this week.')}</b>${' '}
      ${t('Fewer than 40% of stocks are above their 50-day average. In past weak markets even its top picks reached the target first only {pct} of the time.', { pct: fmt.pct(tst.weak_top.hit, 0, false) })}<//></div>`}
    <div class="kpis">
      <${Kpi} label="Strong picks: reached the target first" value=${fmt.pct(s.hit, 0, false)} valueClass="up"
        sub=${t('the average stock {v}', { v: fmt.pct(a.hit, 0, false) })} />
      <${Kpi} label="Strong picks: average trade" value=${fmt.pct(s.ret, 1)} valueClass=${tone(s.ret)}
        sub=${t('the average stock {v}, after fees', { v: fmt.pct(a.ret, 1) })} />
      <${Kpi} label="Years they beat the average stock" value=${`${tst.good_years} / ${years.length}`}
        sub=${years.length ? t('tested {a} – {b}', { a: years[0].year, b: years[years.length - 1].year }) : ''} />
    </div>

    <section class="section">
      <${SectionHead} title="Next week's ranking" count=${data.rows.length}
        hint=${t('From the {date} close, highest chance first. Chance: it rises to the target before it falls to the stop, within 5 sessions.', { date: fmt.date(data.date) })}>
        ${filters}<//>
      <div class="card flush"><${WeekTable} rows=${rows} base=${a.hit} top=${data.top_n} /></div>
    </section>

    <p class="faint note" style="margin-top:14px">${t('Even its strong picks reach the target first only about {pct} of the time, so always use the stop. A second opinion, not advice.', { pct: fmt.pct(s.hit, 0, false) })}</p>`;
}

function WeekTable({ rows, base, top }) {
  const columns = [
    { key: `rank${WK}`, label: '#', align: 'r', width: '64px',
      render: r => html`<span class="faint">${fmt.int(r[`rank${WK}`])}</span> <${RankMove} now=${r[`rank${WK}`]} before=${r[`prev_rank${WK}`]} />` },
    { key: 'symbol', label: 'Stock', render: r => html`<${StockCell} symbol=${r.symbol} info=${r.info} />` },
    { key: `p${WK}`, label: 'Chance in 1 week', align: 'r', title: 'Chance it rises to the target before it falls to the stop, within 5 sessions',
      render: r => html`<${Chance} p=${r[`p${WK}`]} base=${base} />${r.level === 'good' && r[`rank${WK}`] <= top
        && html`<div><span class="model-pick" title=${t('One of its top 10% today, in an uptrend, while the market is healthy')}>${t('Strong')}</span></div>`}` },
    { key: `move${WK}`, label: 'Target / stop', align: 'r', title: "The week's target and stop: 1.5× its daily range either way",
      render: r => html`<div class="up" style="white-space:nowrap"><b>${fmt.price(r[`target${WK}`])}</b> <span class="faint">${fmt.pct(r[`move${WK}`], 1)}</span></div>
        <div class="down" style="white-space:nowrap"><b>${fmt.price(r[`stop${WK}`])}</b> <span class="faint">${fmt.pct(-r[`move${WK}`], 1)}</span></div>` },
    { key: 'action', label: 'Agent', sortValue: r => (r.action === 'BUY' ? 0 : r.action ? 1 : r.held ? 2 : 3),
      render: r => html`<div class="row" style="gap:6px">${r.action && html`<${StatusChip} status=${r.action} />`}
        ${r.held && html`<span class="tag"><${Icon} name="briefcase" size=${12} />${t('Held')}</span>`}</div>` },
    { key: 'why', label: 'Why', sortable: false, render: r => html`<${Reason} items=${r[`why${WK}`]} />` },
    { key: 'shariah', label: 'Shariah', sortable: false, render: r => html`<${Badges} info=${r.info} compact />` },
  ];
  return html`<${DataTable} columns=${columns} rows=${rows} rowKey=${r => r.symbol} limit=${10}
    sort=${{ key: `rank${WK}`, dir: 'asc' }} onRowClick=${r => go(stockHref(r.symbol))}
    empty="None of today's BUY signals, watchlist stocks or your holdings are traded enough to be scored." />`;
}

function Intro({ data, onTrain, running }) {
  const lv = data.levels;
  return html`<div class="card predict-intro">
    <${JobProgress} kind="train" title="Training the prediction model…" />
    <h3>${t('What it predicts')}</h3>
    <p>For every actively traded stock, after each close: if you bought at the next open with the agent's usual plan (${lv.levels_mode === 'chart'
      ? `the stop just under the nearest solid support and the target just under resistance, kept ${lv.stop_min_pct}–${lv.stop_max_pct}% under the price`
      : `stop ${lv.atr_stop_mult}× the average daily range below, kept ${lv.stop_min_pct}–${lv.stop_max_pct}% under the price; target ${lv.target_r}× the risk above`}),
      what is the chance the <b>target is reached before the stop</b>, within 10 sessions (~2 weeks) and within
      20 sessions (~1 month)?</p>
    <h3>${t('How it learns')}</h3>
    <ul class="reasons">
      <li>${data.deep ? '' : `First a one-time download of ${data.deep_years} years of prices (about 4 minutes). `}It learns from
        about 10 years of every actively traded EGX stock: roughly 250,000 past examples.</li>
      <li>It looks at ${data.features['10']} measures: trend, momentum, volume, volatility, how the stock compares with its sector, and how the
        whole market is doing, Egypt-wide numbers (the dollar rate, interest rates and inflation), and each company's
        dividends, bonus shares and rights issues: when the next ex-date is, and when the last one was announced.</li>
      <li>It's tested honestly: each year is predicted by a version trained only on the years before it. Those are the results
        you'll see, and it tells you plainly if it has no edge.</li>
      <li>After that it updates every scan, and retrains itself once a month.</li>
    </ul>
    ${STATIC ? html`<p class="faint" style="font-size:12.5px;margin-top:16px">The site trains the model by itself after a
      scan. Check back tomorrow.</p>` : html`<div class="row" style="margin-top:16px">
      <button class="btn primary" onClick=${onTrain} disabled=${running}><${Icon} name="play" />${t('Train the model')}</button>
      <span class="faint" style="font-size:12.5px">About 2 minutes${data.deep ? '' : ', plus the 4-minute download the first time'}.
        You can keep using the dashboard meanwhile.</span>
    </div>`}
  </div>`;
}

// What trades it scored like this averaged in its tests, after fees (predict.ret_calibrator): wins, stops and the
// ones that ran out of time together. Only for the stocks it gives a chance for.
export const expected = (r, hz) => (r[`top${hz}`] && r[`exp${hz}`] != null ? r[`exp${hz}`] : null);

export function RankMove({ now, before }) {
  if (!now || !before || now === before) return null;
  const up = now < before;
  return html`<span class=${cls('rank-move', up ? 'up' : 'down')} title=${t('#{n} at the close before', { n: fmt.int(before) })}>
    ${up ? '▲' : '▼'}${fmt.int(Math.abs(before - now))}</span>`;
}

function ChanceTable({ rows, base }) {
  const columns = [
    { key: `rank${HZ}`, label: '#', align: 'r', width: '64px',
      render: r => html`<span class="faint">${fmt.int(r[`rank${HZ}`])}</span> <${RankMove} now=${r[`rank${HZ}`]} before=${r[`prev_rank${HZ}`]} />` },
    { key: 'symbol', label: 'Stock', render: r => html`<${StockCell} symbol=${r.symbol} info=${r.info} />` },
    { key: 'p10', label: 'Chance in 2 weeks', align: 'r', title: 'Chance it reaches the target before the stop within 10 sessions',
      render: r => html`<${Chance} p=${r.p10} base=${base[10]} top=${r.top10} />` },
    { key: 'ev', label: 'Average trade', align: 'r', sortValue: r => expected(r, HZ) ?? -1,
      title: 'What trades it rated like this made on average in its tests, after fees',
      render: r => { const v = expected(r, HZ); return v == null ? html`<span class="faint">–</span>` : html`<b class=${tone(v)}>${fmt.pct(v, 1)}</b>`; } },
    { key: 'stop_pct', label: 'Stop / target', align: 'r', title: "The chart's stop-loss and target for a buy at this close",
      render: r => html`<span class="down">${fmt.pct(-r.stop_pct, 1)}</span> <span class="faint">/</span> <span class="up">${fmt.pct(r.target_pct, 1)}</span>` },
    { key: 'action', label: 'Agent', sortValue: r => (r.action === 'BUY' ? 0 : r.action ? 1 : r.held ? 2 : 3),
      render: r => html`<div class="row" style="gap:6px">${r.action && html`<${StatusChip} status=${r.action} />`}
        ${r.held && html`<span class="tag"><${Icon} name="briefcase" size=${12} />${t('Held')}</span>`}</div>` },
    { key: 'shariah', label: 'Shariah', sortable: false, render: r => html`<${Badges} info=${r.info} compact />` },
  ];
  return html`<${DataTable} columns=${columns} rows=${rows} rowKey=${r => r.symbol} limit=${10}
    sort=${{ key: `rank${HZ}`, dir: 'asc' }} onRowClick=${r => go(stockHref(r.symbol))}
    empty="None of today's BUY signals, watchlist stocks or your holdings are traded enough to be scored." />`;
}

// Lately, in one line: its daily top 10 over the last 30 decided sessions.
export function Recent({ rec }) {
  if (!rec || !rec.n) return null;
  return html`<p class="recent-line"><${Icon} name="history" size=${14} />
    ${t('Last {days} sessions: of its daily top {top}, {hits} reached the target first and {misses} did not, averaging {ret} a trade (all scored stocks {all}).', {
      days: fmt.int(rec.days), top: fmt.int(rec.top), hits: fmt.int(rec.hits), misses: fmt.int(rec.misses),
      ret: fmt.pct(rec.ret, 2), all: fmt.pct(rec.all_ret, 2) })}
    <span class="faint"> ${fmt.date(rec.from)} – ${fmt.date(rec.to)}</span></p>`;
}

// Is it still doing live what it did in its tests? (predict.health: the 10-session model, last 60 decided sessions)
const HEALTH = {
  early: 'Too early to tell: it needs at least {min} sessions of results.',
  ok: 'On track: its top picks keep beating the average stock by at least half as much as in its tests.',
  weak: 'Weaker than in its tests: its top picks still beat the average stock, but by less than half as much.',
  bad: "Not working lately: its top picks did no better than the average stock. Until that changes, it adds no BUYs of its own.",
};
export function Health({ h }) {
  if (!h || !HEALTH[h.status]) return null;
  const tone = h.status === 'bad' ? 'warn' : '';
  return html`<${Callout} tone=${tone}><span class=${`health-dot ${h.status}`}></span><b>${t('Live check')}</b>${' '}
    ${t(HEALTH[h.status], { min: h.min_days })}${h.edge != null ? ` ${t('Last {days} sessions: its top 10% {top} a trade against {all} for all scored stocks (tested gap {gap}).', {
      days: fmt.int(h.days), top: fmt.pct(h.top, 2), all: fmt.pct(h.all, 2), gap: fmt.pct(h.tested_edge, 2) })}` : ''}<//>`;
}

function ComboTable({ c }) {
  const rows = [
    { key: 'rules', label: 'The rules alone', r: c.rules },
    { key: 'ordered', label: "The rules, in the model's order", r: c.ordered },
    { key: 'with_picks', label: `The rules plus its top ${c.picks} picks (today's setting)`, r: c.with_picks },
  ].filter(x => x.r);
  const best = Math.max(...rows.map(x => x.r.all.cagr));
  const columns = [
    { key: 'label', label: 'BUY signals from', sortable: false, render: x => html`<b>${x.label}</b>` },
    { key: 'cagr', label: 'A year', align: 'r', sortable: false,
      render: x => html`<b class=${x.r.all.cagr === best ? 'up' : ''}>${fmt.pct(x.r.all.cagr, 1)}</b>` },
    { key: 'dd', label: 'Worst drop', align: 'r', sortable: false, render: x => html`<span class="down">${fmt.pct(x.r.all.max_drawdown, 0)}</span>` },
    { key: 'first', label: 'First half', title: `To ${fmt.date(c.split)}`, align: 'r', sortable: false, render: x => html`<span class=${tone(x.r.first.cagr)}>${fmt.pct(x.r.first.cagr, 1)}</span>` },
    { key: 'second', label: 'Second half', align: 'r', sortable: false, render: x => html`<span class=${tone(x.r.second.cagr)}>${fmt.pct(x.r.second.cagr, 1)}</span>` },
    { key: 'trades', label: 'Trades', align: 'r', sortable: false, render: x => html`<span class="faint">${fmt.int(x.r.all.trades)}</span>` },
  ];
  return html`<${DataTable} columns=${columns} rows=${rows} rowKey=${x => x.key} />`;
}

function About({ m, data, r, onTrain, running }) {
  return html`<div class="grid grid-2" style="align-items:start">
    <div class="stat-list">
      <span class="k">${t('Trained')}</span><span class="v">${fmt.datetime(m.trained_at)} (${m.age_days === 0 ? 'today' : `${m.age_days} days ago`})</span>
      <span class="k">${t('Price history used')}</span><span class="v">${fmt.date(m.data_from)} – ${fmt.date(m.data_to)}</span>
      <span class="k">${t('Stocks learnt from')}</span><span class="v">${fmt.int(m.stocks)}</span>
      <span class="k">${t('Past examples')}</span><span class="v">${fmt.int(r.train_n)}</span>
      <span class="k">${t('Scored today')}</span><span class="v">${fmt.int(data.count)} actively traded stocks</span>
    </div>
    <div>
      <p class="muted" style="font-size:13px">${t('It looks at {n} measures: the chart (trend, momentum, volume, support and resistance), the company\'s results as they were known each day (profit, sales, growth, debt, dividend), dividends and bonus shares coming, and Egypt-wide numbers (the dollar, interest rates, inflation). It rates stocks after every scan and retrains itself once a month.', { n: fmt.int(data.features[String(HZ)]) })}</p>
      ${!STATIC && html`<button class="btn sm" style="margin-top:12px" onClick=${onTrain} disabled=${running}>
        <${Icon} name="refresh" />${t('Retrain now')}</button>`}
    </div>
  </div>`;
}
