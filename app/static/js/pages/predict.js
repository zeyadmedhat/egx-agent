// Predict: a machine-learning model's chance that a trade reaches its target before its stop. Information only.
import { html, useApi, useState, startJob, fmt, tone, go, stockHref, STATIC } from '../lib.js';
import {
  Icon, Badges, Kpi, Callout, More, PageHead, SectionHead, PageLoading, DataTable, StockCell, Seg, JobProgress,
  useJob, StatusChip, Chance, Empty, MarketSwitch, Fold, ShariahNote,
} from '../ui.js';
import { t } from '../i18n.js';

const HORIZONS = [{ value: 10, label: '10 sessions (~2 weeks)' }, { value: 20, label: '20 sessions (~1 month)' }];
const SHOW = [{ value: 'all', label: 'All liquid stocks' }, { value: 'mine', label: 'Signals & my stocks' }];
const GRADE_TONE = { good: 'ok', weak: 'warn', none: 'bad' };

export function PredictPage() {
  const { data, error } = useApi('/predict');
  const [hz, setHz] = useState(10);
  const [show, setShow] = useState('all');
  const { running } = useJob();
  if (!data) return html`<${PageLoading} error=${error} />`;
  const train = () => startJob('/predict/train');
  const head = html`<${PageHead} title="Predictions"
    sub="A machine-learning model ranks every liquid stock after each close. Its rank decides which BUY signals get money first." />`;
  if (!data.model) {
    return html`${head}<${Intro} data=${data} onTrain=${train} running=${running} />`;
  }
  const m = data.model;
  const r = m.horizons[String(hz)] || {};
  const base = data.base || {};
  const rows = show === 'all' ? data.rows : data.rows.filter(x => x.action || x.held);
  const live = (data.live || {})[String(hz)] || { n: 0 };
  const changed = m.changed || [];

  return html`${head}
    <${JobProgress} kind="train" title="Training the prediction model…" />
    ${changed.length > 0 && html`<div style="margin-bottom:14px"><${Callout} tone="warn">
      <b>Your stop or target settings changed since the model was trained.</b>${' '}
      Its numbers still assume the old plan. It retrains by itself after the next scan${STATIC ? '.' : html`, or${' '}
      <button class="linkish" onClick=${train} disabled=${running}>retrain it now</button>.`}<//></div>`}
    <${Callout} tone=${GRADE_TONE[r.grade] || ''}><b>${hz}-session model: ${r.verdict}</b>${' '}
      Tested on ${fmt.date(r.from)} – ${fmt.date(r.to)}, with each year predicted by a version that had never seen it.<//>
    <div style="margin-top:10px"><${Health} h=${data.health} /></div>
    ${data.switch && html`<div style="margin-top:10px"><${MarketSwitch} sw=${data.switch} /></div>`}

    <div class="row" style="margin:18px 0 12px;justify-content:space-between">
      <${Seg} options=${HORIZONS} value=${hz} onChange=${setHz} />
      <span class="faint" style="font-size:13px">${t('Target first = the target is reached before the stop, within {n} sessions.', { n: hz })}</span>
    </div>
    <div class="kpis">
      <${Kpi} label="Its top 10% each day: target first" value=${fmt.pct(r.top.hit, 0, false)} valueClass="up"
        sub=${`vs ${fmt.pct(r.all.hit, 0, false)} for the average stock`} />
      <${Kpi} label="Its top 10%: average result" value=${fmt.pct(r.top.ret, 2)} valueClass=${tone(r.top.ret)}
        sub=${`vs ${fmt.pct(r.all.ret, 2)} average, after fees`} />
      <${Kpi} label="Beat the average stock" value=${`${r.good_years} of ${(r.years || []).length} years`}
        title="AUC measures how well it sorts winners from losers: 0.50 is a coin flip, 1.00 is perfect."
        sub=${`AUC ${fmt.num(r.auc, 2)} (0.50 = coin flip)`} />
    </div>

    <section class="section">
      <${SectionHead} title="Today's chances" count=${data.rows.length}
        hint=${`From the ${fmt.date(data.date)} close, sorted by the model's rank. A chance is shown only for its top ${fmt.int(data.top_n)} stocks.`}>
        <${ShariahNote} mode=${data.shariah_filter} /><${Seg} options=${SHOW} value=${show} onChange=${setShow} /><//>
      <div class="card flush"><${ChanceTable} rows=${rows} hz=${hz} base=${base} /></div>
    </section>

    <${Fold} title="How it did on years it never saw"
      hint="Every past day, the liquid stocks sorted by the model's score. Higher groups should do better, and they did.">
      <div class="kpis">
        <${Kpi} label="Rule BUYs it also likes: target first" value=${fmt.pct(r.rule_agree.hit, 0, false)}
          title=${`${fmt.int(r.rule_agree.n + r.rule_disagree.n)} past BUY signals from the rules, split by whether the model ranked them in that day's top 20%`}
          sub=${`vs ${fmt.pct(r.rule_disagree.hit, 0, false)} for the ones it doesn't`} />
        ${r.portfolio && r.portfolio.cagr != null && html`<${Kpi} label=${`Its top 5, every ${hz} sessions`}
          value=${`${fmt.pct(r.portfolio.cagr, 0)} a year`} valueClass=${tone(r.portfolio.cagr)}
          title=${`A test portfolio: its 5 best-ranked stocks bought equally every ${hz} sessions, sized by the market switch. Worst drop ${fmt.pct(r.portfolio.max_drawdown, 0)}.`}
          sub=${`${fmt.pct(r.portfolio_cost.cagr, 0)} a year with ${fmt.pct(r.extra_cost, 1, false)} more cost per trade · worst drop ${fmt.pct(r.portfolio.max_drawdown, 0)}`} />`}
      </div>
      <div class="grid grid-2" style="margin-top:14px">
        <div class="card flush"><${GroupsTable} groups=${r.groups || []} /></div>
        <div class="card flush"><${YearsTable} years=${r.years || []} /></div>
      </div>
      <p class="muted" style="font-size:13px;margin-top:12px">Trading costs matter: with ${fmt.pct(r.extra_cost, 1, false)} more
        slippage on every trade than the fees already counted, its top 10% average ${fmt.pct(r.top_ret_cost, 2)} a trade
        instead of ${fmt.pct(r.top.ret, 2)}.${r.chances && r.chances.useful === false ? html`${' '}<b>Its chance numbers
        for ${hz} sessions are no more accurate than giving every stock the average chance</b> (checked year by year):
        trust its <i>rank</i>, not the % itself.` : ''}</p>
    <//>

    ${data.combo && data.combo.rules && html`<${Fold} title="The BUY rules with and without the model"
      hint=${`The agent's own backtest on the years the model was tested on (${fmt.date(data.combo.from)} – ${fmt.date(data.combo.to)}).`} flush>
      <${ComboTable} c=${data.combo} /><//>`}

    <${Fold} title="Since it went live"
      hint=${`Predictions from this version${m.live_since ? ` (since the ${fmt.date(m.live_since)} close)` : ''}, checked against what really happened.`}>
      <${Live} live=${live} hz=${hz} r=${r} /><//>

    ${data.experiment && html`<${Fold} title="Experiment: 5-day picks (paper only)"
      hint="A third model, tested but not trusted yet. These are not BUY signals.">
      <${Experiment} ex=${data.experiment} /><//>`}

    <${Fold} title="About this model"><${About} m=${m} data=${data} r=${r} hz=${hz} onTrain=${train} running=${running} /><//>

    <div style="margin-top:18px"><${Callout} tone="warn"><b>${t('Read these numbers with care.')}</b>${' '}
      ${t('Even its best picks reach the target first only about {pct} of the time, so always use the stop.', { pct: fmt.pct(r.top.hit, 0, false) })}
      <${More} label="Three more caveats"><ul class="reasons">
        <li>It learnt from stocks listed today, so companies that collapsed or delisted are missing, which flatters results.</li>
        <li>Patterns in the past can stop working. Watch the live track record.</li>
        <li>Returns are in nominal EGP. It's a second opinion, not investment advice.</li></ul><//><//></div>`;
}

function Intro({ data, onTrain, running }) {
  const lv = data.levels;
  return html`<div class="card predict-intro">
    <${JobProgress} kind="train" title="Training the prediction model…" />
    <h3>${t('What it predicts')}</h3>
    <p>For every liquid stock, after each close: if you bought at the next open with the agent's usual plan (stop ${lv.atr_stop_mult}×
      the average daily range below, kept ${lv.stop_min_pct}–${lv.stop_max_pct}% under the price; target ${lv.target_r}× the
      risk above), what is the chance the <b>target is reached before the stop</b>, within 10 sessions (~2 weeks) and within
      20 sessions (~1 month)?</p>
    <h3>${t('How it learns')}</h3>
    <ul class="reasons">
      <li>${data.deep ? '' : `First a one-time download of ${data.deep_years} years of prices (about 4 minutes). `}It learns from
        about 10 years of every liquid EGX stock: roughly 250,000 past examples.</li>
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

function ChanceTable({ rows, hz, base }) {
  const columns = [
    { key: `rank${hz}`, label: '#', align: 'r', width: '44px', fmt: v => html`<span class="faint">${fmt.int(v)}</span>` },
    { key: 'symbol', label: 'Stock', render: r => html`<${StockCell} symbol=${r.symbol} info=${r.info} />` },
    { key: 'shariah', label: 'Shariah', sortable: false, render: r => html`<${Badges} info=${r.info} compact />` },
    { key: 'p10', label: '2 weeks', align: 'r', title: 'Chance of target before stop within 10 sessions',
      render: r => html`<${Chance} p=${r.p10} base=${base[10]} top=${r.top10} />` },
    { key: 'p20', label: '1 month', align: 'r', title: 'Chance of target before stop within 20 sessions',
      render: r => html`<${Chance} p=${r.p20} base=${base[20]} top=${r.top20} />` },
    { key: 'close', label: 'Close', align: 'r', fmt: v => fmt.price(v) },
    { key: 'action', label: 'Agent', sortValue: r => (r.action === 'BUY' ? 0 : r.action ? 1 : r.held ? 2 : 3),
      render: r => html`<div class="row" style="gap:6px">${r.action && html`<${StatusChip} status=${r.action} />`}
        ${r.held && html`<span class="tag"><${Icon} name="briefcase" size=${12} />Held</span>`}</div>` },
  ];
  return html`<${DataTable} columns=${columns} rows=${rows} rowKey=${r => r.symbol} key=${hz} limit=${10}
    sort=${{ key: `rank${hz}`, dir: 'asc' }} onRowClick=${r => go(stockHref(r.symbol))}
    empty="None of today's BUY signals, watchlist stocks or your holdings are liquid enough to be scored." />`;
}

function GroupsTable({ groups }) {
  const top = Math.max(...groups.map(g => g.hit || 0), 0.01);
  const columns = [
    { key: 'label', label: 'Model score that day', sortable: false, render: g => html`<b>${g.label}</b>` },
    { key: 'hit', label: 'Target first', sortable: false, width: '40%', render: g => html`<div class="gauge">
      <b class="gauge-v">${fmt.pct(g.hit, 0, false)}</b>
      <div class="bar up"><span style=${`width:${(g.hit / top) * 100}%`}></span></div></div>` },
    { key: 'ret', label: 'Avg result', align: 'r', sortable: false, render: g => html`<span class=${tone(g.ret)}>${fmt.pct(g.ret, 2)}</span>` },
    { key: 'n', label: 'Examples', align: 'r', sortable: false, fmt: v => html`<span class="faint">${fmt.short(v)}</span>` },
  ];
  return html`<${DataTable} columns=${columns} rows=${groups} rowKey=${g => g.label} />`;
}

function YearsTable({ years }) {
  const columns = [
    { key: 'year', label: 'Year' },
    { key: 'avg', label: 'Average stock', align: 'r', sortable: false, render: y => fmt.pct(y.all.hit, 0, false) },
    { key: 'top', label: 'Its top 10%', align: 'r', sortable: false,
      render: y => html`<b class=${y.top.hit > y.all.hit ? 'up' : 'down'}>${fmt.pct(y.top.hit, 0, false)}</b>` },
    { key: 'ret', label: 'Top 10% result', align: 'r', sortable: false, render: y => html`<span class=${tone(y.top.ret)}>${fmt.pct(y.top.ret, 2)}</span>` },
    { key: 'auc', label: 'AUC', align: 'r', fmt: v => html`<span class="faint">${fmt.num(v, 2)}</span>` },
  ];
  return html`<${DataTable} columns=${columns} rows=${[...years].reverse()} rowKey=${y => y.year} />`;
}

function Live({ live, hz, r }) {
  if (!live.n) {
    return html`<div><${Empty} icon="history" title="Nothing to check yet"
      text=${`A prediction is checked once its ${hz} sessions are over${live.pending_days ? ` (${live.pending_days} day${live.pending_days === 1 ? '' : 's'} of predictions waiting)` : ''}. The first results appear about ${hz === 10 ? 'two weeks' : 'a month'} after this version went live. In its tests, its top 10% reached the target first ${fmt.pct(r.top.hit, 0, false)} of the time, averaging ${fmt.pct(r.top.ret, 2)} a trade.`} /></div>`;
  }
  return html`<div class="kpis">
    <${Kpi} label="Its top 10%: target first" value=${fmt.pct(live.top.hit, 0, false)}
      valueClass=${live.top.hit > live.all.hit ? 'up' : 'down'}
      sub=${`tested ${fmt.pct(r.top.hit, 0, false)} · all scored stocks ${fmt.pct(live.all.hit, 0, false)}`} />
    <${Kpi} label="Its top 10%: average result" value=${fmt.pct(live.top.ret, 2)} valueClass=${tone(live.top.ret)}
      sub=${`tested ${fmt.pct(r.top.ret, 2)} · all scored stocks ${fmt.pct(live.all.ret, 2)}`} />
    <${Kpi} label="Checked so far" value=${`${fmt.int(live.days)} day${live.days === 1 ? '' : 's'}`}
      sub=${`${fmt.date(live.from)} – ${fmt.date(live.to)} · ${fmt.int(live.n)} predictions`} />
  </div>`;
}

// Is it still doing live what it did in its tests? (predict.health: the 10-session model, last 60 decided sessions)
const HEALTH = {
  early: 'Too early to tell: it needs at least {min} sessions of results.',
  ok: 'On track: its top picks keep beating the average stock by at least half as much as in its tests.',
  weak: 'Weaker than in its tests: its top picks still beat the average stock, but by less than half as much.',
  bad: "Not working lately: its top picks did no better than the average stock. Until that changes, it adds no BUYs of its own.",
};
function Health({ h }) {
  if (!h || !HEALTH[h.status]) return null;
  const tone = h.status === 'bad' ? 'warn' : '';
  return html`<${Callout} tone=${tone}><span class=${`health-dot ${h.status}`}></span><b>Live check</b>${' '}
    ${HEALTH[h.status].replace('{min}', h.min_days)}${h.edge != null ? html`${' '}Last ${fmt.int(h.days)} sessions: its top 10%
    ${fmt.pct(h.top, 2)} a trade against ${fmt.pct(h.all, 2)} for all scored stocks (tested gap ${fmt.pct(h.tested_edge, 2)}).` : ''}<//>`;
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
    { key: 'sharpe', label: 'Sharpe', align: 'r', sortable: false, title: 'Return for the ups and downs taken: higher is steadier',
      render: x => fmt.num(x.r.all.sharpe, 2) },
    { key: 'first', label: `To ${fmt.date(c.split)}`, align: 'r', sortable: false, render: x => html`<span class=${tone(x.r.first.cagr)}>${fmt.pct(x.r.first.cagr, 1)}</span>` },
    { key: 'second', label: 'After', align: 'r', sortable: false, render: x => html`<span class=${tone(x.r.second.cagr)}>${fmt.pct(x.r.second.cagr, 1)}</span>` },
    { key: 'trades', label: 'Trades', align: 'r', sortable: false, render: x => html`<span class="faint">${fmt.int(x.r.all.trades)}</span>` },
  ];
  return html`<${DataTable} columns=${columns} rows=${rows} rowKey=${x => x.key} />`;
}

function Experiment({ ex }) {
  const test = ex.test || {}, live = ex.live || { n: 0 };
  const hold = test.hold || {};
  return html`<div class="grid grid-2" style="align-items:start">
    <div class="card"><div class="stat-list">
      <span class="k">${t('Tested: its top 10% (5 days)')}</span><span class="v"><b class=${tone(hold.top)}>${fmt.pct(hold.top, 2)}</b> a
        trade${' '}<span class="faint">vs ${fmt.pct(hold.all, 2)} for all</span></span>
      ${test.portfolio && test.portfolio.cagr != null && html`<span class="k">${t('Tested: its top 5 every 5 days')}</span><span class="v">
        ${fmt.pct(test.portfolio.cagr, 0)} a year <span class="faint">· worst drop ${fmt.pct(test.portfolio.max_drawdown, 0)}</span></span>
      <span class="k">With ${fmt.pct(test.extra_cost, 1, false)} more cost a trade</span><span class="v">${fmt.pct(test.portfolio_cost.cagr, 0)} a year</span>`}
      <span class="k">${t('Live so far')}</span><span class="v">${live.n
        ? html`its daily top 5 <b class=${tone(live.picks.ret)}>${fmt.pct(live.picks.ret, 2)}</b> a trade, all ${fmt.pct(live.all.ret, 2)}
          <span class="faint">(${fmt.int(live.days)} days)</span>`
        : html`<span class="faint">nothing decided yet</span>`}</span>
    </div>
    <p class="faint" style="font-size:12px;margin-top:10px">It trades every week, so costs weigh twice as much, and it has no
      stop. It becomes more than an experiment only if its live results match its tests for a few months.</p></div>
    <div class="card"><div class="card-title"><${Icon} name="target" size=${15} />${t('Its 5 picks from the last close')}</div>
      <div class="stat-list">${(ex.picks || []).map(p => html`<span class="k">#${p.rank}</span>
        <span class="v"><a href=${stockHref(p.symbol)}>${p.symbol}</a> <span class="faint">${fmt.price(p.close)}</span></span>`)}</div>
      <p class="faint" style="font-size:12px;margin-top:10px">Paper only: not signals, not advice.</p></div>
  </div>`;
}

function About({ m, data, r, hz, onTrain, running }) {
  return html`<div class="grid grid-2" style="align-items:start">
    <div class="stat-list">
      <span class="k">${t('Trained')}</span><span class="v">${fmt.datetime(m.trained_at)} (${m.age_days === 0 ? 'today' : `${m.age_days} days ago`})</span>
      <span class="k">${t('Price history used')}</span><span class="v">${fmt.date(m.data_from)} – ${fmt.date(m.data_to)}</span>
      <span class="k">${t('Stocks learnt from')}</span><span class="v">${fmt.int(m.stocks)}</span>
      <span class="k">${t('Past examples')}</span><span class="v">${fmt.int(r.train_n)}</span>
      <span class="k">${t('Scored today')}</span><span class="v">${fmt.int(data.count)} liquid stocks</span>
    </div>
    <div>
      <p class="muted" style="font-size:13px">A gradient-boosting model (many small decision trees) for each horizon, using${' '}
        ${fmt.int(data.features[String(hz)])} measures.${' '}
        They include Egypt-wide numbers (the dollar rate, the interbank interest rate, inflation, and small caps vs EGX30)
        and the company's dividends, bonus shares and rights issues from Mubasher's list of the exchange's filings, each
        only from the day it was published.${' '}
        It updates its numbers after every scan and retrains itself once every ${data.retrain_days} days, or after you change
        the stop or target settings. Stocks that aren't liquid enough for the agent's rules are left out, and so are
        days a stock couldn't really be bought (no trading, or stuck at one price).</p>
      <button class="btn sm" style="margin-top:12px" onClick=${onTrain} disabled=${running}>
        <${Icon} name="refresh" />${t('Retrain now')}</button>
    </div>
  </div>`;
}
