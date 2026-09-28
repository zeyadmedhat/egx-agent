// Predict: a machine-learning model's chance that a trade reaches its target before its stop. Information only.
import { html, useApi, useState, startJob, fmt, tone, go, stockHref, STATIC } from '../lib.js';
import {
  Icon, Badges, Kpi, Callout, PageHead, SectionHead, Disclaimer, PageLoading, DataTable, StockCell, Seg, JobProgress,
  useJob, StatusChip, Chance, Empty, MarketSwitch,
} from '../ui.js';

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
  const head = html`<${PageHead} title="Predict"
    sub="A machine-learning model's chance that a trade reaches its target before its stop. Information only: the BUY rules don't use it." />`;
  if (!data.model) {
    return html`${head}<${Intro} data=${data} onTrain=${train} running=${running} /><${Disclaimer} />`;
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
    ${data.switch && html`<div style="margin-top:10px"><${MarketSwitch} sw=${data.switch} /></div>`}

    <div class="row" style="margin:16px 0 12px;justify-content:space-between">
      <${Seg} options=${HORIZONS} value=${hz} onChange=${setHz} />
      <span class="faint" style="font-size:12.5px">Target first = the target is reached before the stop, within ${hz} sessions.</span>
    </div>
    <div class="kpis">
      <${Kpi} label="Its top 10% each day: target first" icon="target" value=${fmt.pct(r.top.hit, 0, false)} valueClass="up"
        sub=${`vs ${fmt.pct(r.all.hit, 0, false)} for the average stock`} />
      <${Kpi} label="Its top 10%: average result" value=${fmt.pct(r.top.ret, 2)} valueClass=${tone(r.top.ret)}
        sub=${`vs ${fmt.pct(r.all.ret, 2)} average, after fees`} />
      <${Kpi} label="Rule BUYs it also likes: target first" value=${fmt.pct(r.rule_agree.hit, 0, false)}
        title=${`${fmt.int(r.rule_agree.n + r.rule_disagree.n)} past BUY signals from the rules, split by whether the model ranked them in that day's top 20%`}
        sub=${`vs ${fmt.pct(r.rule_disagree.hit, 0, false)} for the ones it doesn't`} />
      <${Kpi} label="Beat the average stock" value=${`${r.good_years} of ${(r.years || []).length} years`}
        title="AUC measures how well it sorts winners from losers: 0.50 is a coin flip, 1.00 is perfect."
        sub=${`AUC ${fmt.num(r.auc, 2)} (0.50 = coin flip)`} />
    </div>

    <section class="section">
      <${SectionHead} title="Today's chances" count=${data.rows.length}
        hint=${`From the ${fmt.date(data.date)} close, sorted by the model's rank. It gives a chance only for its top ${fmt.int(data.top_n)} stocks (its best 10%): that's the group its tested results are about. Stop and target are the agent's usual plan.`}>
        <${Seg} options=${SHOW} value=${show} onChange=${setShow} /><//>
      <div class="card flush"><${ChanceTable} rows=${rows} hz=${hz} base=${base} /></div>
    </section>

    <section class="section">
      <${SectionHead} title="How it did on years it never saw"
        hint="Every past day, the liquid stocks sorted by the model's score. Higher groups should do better, and they did." />
      <div class="grid grid-2">
        <div class="card flush"><${GroupsTable} groups=${r.groups || []} /></div>
        <div class="card flush"><${YearsTable} years=${r.years || []} /></div>
      </div>
    </section>

    <section class="section">
      <${SectionHead} title="Since it went live"
        hint=${`Predictions from this version of the model${m.live_since ? ` (since the ${fmt.date(m.live_since)} close)` : ''}, checked against what really happened, next to its test results. This is the real test.`} />
      <${Live} live=${live} hz=${hz} r=${r} />
    </section>

    <section class="section">
      <${SectionHead} title="About this model" />
      <${About} m=${m} data=${data} r=${r} hz=${hz} onTrain=${train} running=${running} />
    </section>

    <div style="margin-top:18px"><${Callout} tone="warn"><b>Read these numbers with care.</b>${' '}
      (1) Even its best picks reach the target first only about ${fmt.pct(r.top.hit, 0, false)} of the time: most trades end at
      the stop or run out of time, so always use the stop.
      (2) It learnt from stocks listed today, so companies that collapsed or delisted are missing, which flatters results.
      (3) Patterns in the past can stop working. Watch the live track record.
      (4) Returns are in nominal EGP. It's a second opinion, not investment advice.<//></div>
    <${Disclaimer} />`;
}

function Intro({ data, onTrain, running }) {
  const lv = data.levels;
  return html`<div class="card predict-intro">
    <${JobProgress} kind="train" title="Training the prediction model…" />
    <h3>What it predicts</h3>
    <p>For every liquid stock, after each close: if you bought at the next open with the agent's usual plan (stop ${lv.atr_stop_mult}×
      the average daily range below, kept ${lv.stop_min_pct}–${lv.stop_max_pct}% under the price; target ${lv.target_r}× the
      risk above), what is the chance the <b>target is reached before the stop</b>, within 10 sessions (~2 weeks) and within
      20 sessions (~1 month)?</p>
    <h3>How it learns</h3>
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
      <button class="btn primary" onClick=${onTrain} disabled=${running}><${Icon} name="play" />Train the model</button>
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
    { key: 'stop', label: 'Stop', align: 'r', render: r => html`${fmt.price(r.stop)}
      <div class="faint down" style="font-size:11.5px">${fmt.pct(-r.stop_pct, 1)}</div>` },
    { key: 'target', label: 'Target', align: 'r', render: r => html`${fmt.price(r.target)}
      <div class="faint up" style="font-size:11.5px">${fmt.pct(r.target_pct, 1)}</div>` },
    { key: 'action', label: 'Agent', sortValue: r => (r.action === 'BUY' ? 0 : r.action ? 1 : r.held ? 2 : 3),
      render: r => html`<div class="row" style="gap:6px">${r.action && html`<${StatusChip} status=${r.action} />`}
        ${r.held && html`<span class="tag"><${Icon} name="briefcase" size=${12} />Held</span>`}</div>` },
  ];
  return html`<${DataTable} columns=${columns} rows=${rows} rowKey=${r => r.symbol} key=${hz} limit=${25}
    sort=${{ key: `rank${hz}`, dir: 'asc' }} onRowClick=${r => go(stockHref(r.symbol))}
    empty="None of today's BUY signals, watchlist stocks or your holdings are liquid enough to be scored." />`;
}

function GroupsTable({ groups }) {
  const top = Math.max(...groups.map(g => g.hit || 0), 0.01);
  const columns = [
    { key: 'label', label: 'Model score that day', sortable: false, render: g => html`<b>${g.label}</b>` },
    { key: 'hit', label: 'Target first', sortable: false, width: '40%', render: g => html`<div class="gauge">
      <b style="width:38px;text-align:right">${fmt.pct(g.hit, 0, false)}</b>
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
    return html`<div class="card"><${Empty} icon="history" title="Nothing to check yet"
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

function About({ m, data, r, hz, onTrain, running }) {
  return html`<div class="card"><div class="grid grid-2" style="align-items:start">
    <div class="stat-list">
      <span class="k">Trained</span><span class="v">${fmt.datetime(m.trained_at)} (${m.age_days === 0 ? 'today' : `${m.age_days} days ago`})</span>
      <span class="k">Price history used</span><span class="v">${fmt.date(m.data_from)} – ${fmt.date(m.data_to)}</span>
      <span class="k">Stocks learnt from</span><span class="v">${fmt.int(m.stocks)}</span>
      <span class="k">Past examples</span><span class="v">${fmt.int(r.train_n)}</span>
      <span class="k">Scored today</span><span class="v">${fmt.int(data.count)} liquid stocks</span>
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
        <${Icon} name="refresh" />Retrain now</button>
    </div>
  </div></div>`;
}
