// Today: market mood, the orders for the next session, your positions, BUY signals and the watchlist.
import { html, useApi, useState, useEffect, api, toast, fmt, tone, stockHref, cls, go, todayISO, copyText, STATIC } from '../lib.js';
import {
  Icon, Badges, IndexPills, StatusChip, Kpi, ScoreRing, ScoreBar, DayBar, Empty, Callout, PageHead, SectionHead,
  Disclaimer, PageLoading, DataTable, StockCell, JobControl, Chance, MarketSwitch, Cautions,
} from '../ui.js';
import { Sparkline } from '../charts.js';

export function TodayPage() {
  const { data, error } = useApi('/today');
  if (!data) return html`<${PageLoading} error=${error} />`;
  const m = data.market;
  if (!m) {
    return html`<${PageHead} title="Today" />
      <div class="card"><${Empty} icon="activity" title="No scan yet"
        text=${STATIC ? 'The site scans by itself after every close. Check back after the next one.'
          : 'Press Run scan to download 5 years of prices for every EGX stock and look for signals. The first time takes about 5–10 minutes; after that about 2 minutes.'}
        action=${STATIC ? null : html`<${JobControl} />`} /></div>`;
  }
  const cfg = data.cfg;
  const blocked = m.risk_off && cfg.riskoff_block_buys;
  const alerts = data.positions.filter(p => p.status !== 'HOLD').length;
  return html`
    <${PageHead} title="Today" sub=${`Signals for the next session, from the ${fmt.date(m.date)} close`} />
    <${MarketCard} m=${m} spark=${data.spark} blocked=${blocked} b=${data.breadth} />
    ${m.warnings && m.warnings.length > 0 && html`<div class="stack" style="margin-top:12px">
      ${m.warnings.map(w => html`<${Callout} tone="warn">${w}<//>`)}</div>`}
    <div class="kpis" style="margin-top:14px">
      <${Kpi} label="BUY signals" icon="trendUp" value=${data.buys.length} valueClass=${data.buys.length ? 'up' : ''}
        sub=${blocked ? 'paused: risk-off market' : data.buys.length ? 'for the next session' : 'none at the last close'} />
      <${Kpi} label="Watchlist" icon="eye" value=${data.watch.length} sub="could trigger next" />
      <${Kpi} label="Your open positions" icon="briefcase" value=${data.positions.length}
        sub=${data.positions.length ? (alerts ? `${alerts} need${alerts === 1 ? 's' : ''} action` : 'all on hold') : 'none'}
        subClass=${alerts ? 'warn' : ''} />
      ${data.paper && html`<${Kpi} label="Paper account" icon="flask" value=${fmt.short(data.paper.equity)}
        sub=${`${fmt.pct(data.paper.return_pct)} · ${data.paper.open} open`} subClass=${tone(data.paper.return_pct)} />`}
    </div>

    ${data.orders && html`<${OrdersCard} o=${data.orders} />`}

    ${data.positions.length > 0 && html`<${Positions} positions=${data.positions} cfg=${cfg} alerts=${alerts} />`}

    <section class="section">
      <${SectionHead} title="BUY signals" count=${data.buys.length}
        hint=${data.buys.length ? "Don't pay more than Buy up to. If it opens higher, skip it." : ''} />
      ${data.buys.length
        ? html`<div class="signal-grid">${data.buys.map(s => html`<${SignalCard} s=${s} model=${data.model} key=${s.symbol} />`)}</div>`
        : html`<div class="card"><${Empty} icon="shield" title="No BUY signals for the next session" text=${blocked
          ? "The market is in risk-off mode (EGX30 is below its 50-day average), so the agent isn't making new BUY calls. Sitting in cash is a valid decision. The watchlist shows what could trigger once the market recovers."
          : 'No stock met all the entry rules at the last close. Sitting in cash is a valid decision. The watchlist below shows what could trigger next.'} /></div>`}
    </section>

    <section class="section">
      <${SectionHead} title="Watchlist" count=${data.watch.length}
        hint="Liquid stocks in strong uptrends without an entry trigger yet. A close above the breakout level on strong volume can turn them into BUYs." />
      <div class="card flush"><${Watchlist} rows=${data.watch} model=${data.model} /></div>
    </section>

    ${cfg.auto_paper && data.paper && data.paper.last_scan && html`<p class="faint" style="margin-top:14px;font-size:12.5px">
      Paper trading at this scan: ${data.paper.last_scan.filled || 0} filled, ${data.paper.last_scan.closed || 0} closed,${' '}
      ${data.paper.last_scan.cancelled || 0} skipped, ${data.paper.last_scan.new_orders || 0} new orders for the next session.</p>`}
    <${Disclaimer} />`;
}

function MarketCard({ m, spark, blocked, b }) {
  const gap = m.egx30_close / m.egx30_ema50 - 1;
  const text = blocked
    ? 'EGX30 is below its 50-day average, so the agent makes no new BUY calls until it recovers. Focus on managing your open positions.'
    : m.risk_off
      ? `Risk-off: only very strong signals (score ≥ ${fmt.int(m.buy_threshold)}) and at most half the usual number of positions.`
      : 'EGX30 is above its 50-day average, so new BUY signals are allowed.';
  return html`<div class="card market">
    <div class="market-main">
      <div class="row" style="justify-content:space-between"><span class="eyebrow">EGX30 index</span>
        ${m.risk_off
          ? html`<span class="chip riskoff"><span class="dot"></span>Risk-off</span>`
          : html`<span class="chip riskon"><span class="dot"></span>Market OK</span>`}</div>
      <div class="market-price">${fmt.int(m.egx30_close)}
        <span class=${cls('chg', tone(m.egx30_change))}>${fmt.pct(m.egx30_change, 2)}</span></div>
      <div class="market-meta">50-day average ${fmt.int(m.egx30_ema50)} · the index is
        <b class=${tone(gap)}> ${fmt.pct(Math.abs(gap), 1, false)} ${gap >= 0 ? 'above' : 'below'}</b> it</div>
      <p class="market-text">${text}</p>
      ${b && html`<p class="market-text" style="margin-top:2px">${b.text} <a href="#/market">Market breadth →</a></p>`}
      ${b && b.switch && html`<div style="margin-top:8px"><${MarketSwitch} sw=${b.switch} compact /></div>`}
    </div>
    <div class="market-spark">
      <div class="spark-legend">
        <span><span class="legend-dot" style=${`background:var(--${m.risk_off ? 'down' : 'up'})`}></span>EGX30, 6 months</span>
        <span><span class="legend-dot" style="background:var(--warn)"></span>50-day average</span></div>
      <${Sparkline} spark=${spark} />
    </div>
    <div class="market-stats">
      <span>Scanned <b>${m.scanned}</b> stocks</span><span><b>${m.eligible}</b> liquid enough</span>
      ${b && html`<a class="breadth-link" href="#/market" title="Share of EGX stocks trading above their 50-day average">
        Breadth <b class=${b.tone === 'ok' ? 'up' : b.tone === 'bad' ? 'down' : 'warn'}>${fmt.pct(b.above50, 0, false)}</b> above 50-day avg${
          b.change_week != null ? html` <span class="faint">(${fmt.signed(b.change_week * 100)} pts in a week)</span>` : ''}</a>`}
      <span>Data: <b>${fmt.date(m.date)}</b> close</span><span>Last run <b>${fmt.datetime(m.finished)}</b></span>
    </div>
  </div>`;
}

function Positions({ positions, cfg, alerts }) {
  return html`<section class="section">
    <${SectionHead} title="Your open positions" count=${positions.length}
      hint=${alerts ? `${alerts} need${alerts === 1 ? 's' : ''} your attention` : 'Nothing to do: all on hold'}>
      <a class="btn sm" href="#/portfolio">Manage <${Icon} name="chevron" size=${14} /></a><//>
    <div class="card flush alerts">${positions.map(p => html`<div class="alert-row" key=${p.id}>
      <div><a class="sym-big" style="font-size:15px" href=${stockHref(p.symbol)}>${p.symbol}</a>
        <div class="faint" style="font-size:12px">${fmt.int(p.shares)} sh · <span class=${tone(p.pnl_pct)}>${fmt.pct(p.pnl_pct)}</span></div></div>
      <div><${StatusChip} status=${p.status} /></div>
      <div class="reason">${p.reason}${p.cautions && p.cautions.length > 0 && html`<div style="margin-top:4px">
        <${Cautions} items=${p.cautions} compact /></div>`}</div>
      <${DayBar} day=${p.day} max=${cfg.max_hold_days} review=${cfg.review_day} />
    </div>`)}</div></section>`;
}

// ------------------------------------------------------------------ orders for the next session
const KIND = { adjust: 'UPDATE', sell: 'SELL', stop: 'STOP', review: 'REVIEW', buy: 'BUY' };

function sessionName(day) {
  const d = new Date(day + 'T00:00:00');
  const tomorrow = new Date(todayISO() + 'T00:00:00');
  tomorrow.setDate(tomorrow.getDate() + 1);
  const label = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
  if (day === todayISO()) return `today, ${label}`;
  if (d.getTime() === tomorrow.getTime()) return `tomorrow, ${label}`;
  return label;
}


const buyHref = (sym, price, shares) =>
  `#/portfolio?buy=${encodeURIComponent(sym)}&price=${Number(price).toFixed(2)}&shares=${shares || ''}`;

function OrderAction({ it }) {
  if (it.kind === 'buy') return html`<a class="btn sm" href=${buyHref(it.symbol, it.limit, it.shares)}><${Icon} name="plus" />Log buy</a>`;
  if (it.kind === 'sell' || it.kind === 'review') {
    return html`<a class="btn sm" href=${`#/portfolio?open=${it.trade_id}`}><${Icon} name="sell" />Log sale</a>`;
  }
  if (it.kind === 'adjust') return html`<a class="btn sm" href=${`#/portfolio?open=${it.trade_id}`}><${Icon} name="split" />Update</a>`;
  return html`<a class="btn sm ghost" href=${stockHref(it.symbol)}><${Icon} name="chart" />Chart</a>`;
}

function OrdersCard({ o }) {
  const initial = () => new Set(o.items.filter(i => i.done).map(i => i.key));
  const [done, setDone] = useState(initial);
  useEffect(() => setDone(initial()), [o]);
  const toggle = async it => {
    const before = done;
    const next = new Set(done);
    const on = !next.has(it.key);
    if (on) next.add(it.key); else next.delete(it.key);
    setDone(next);
    try {
      await api('/orders/check', { method: 'PUT', body: { session: o.session, item: it.key, done: on } });
    } catch (e) {
      setDone(before);
      toast(e.message, 'error', 8000);
    }
  };
  const copy = () => {
    const lines = [`EGX orders for ${sessionName(o.session)}`, ''];
    for (const it of o.items) lines.push(`${done.has(it.key) ? '[x]' : '[ ]'} ${it.title}`, `    ${it.detail}`);
    if (!o.items.length) lines.push('Nothing to do.');
    if (o.holds.length) lines.push('', `No change: ${o.holds.map(h => `${h.symbol} (stop ${fmt.price(h.stop)})`).join(', ')}`);
    if (copyText(lines.join('\n'))) toast('Copied. Paste it into your notes or a message to your broker.');
    else toast("Couldn't copy from this browser. Select the list and copy it instead.", 'error');
  };
  const n = o.items.length;
  const k = o.items.filter(i => done.has(i.key)).length;
  return html`<section class="section"><div class="card flush">
    <div class="orders-head">
      <div><h2>Orders for ${sessionName(o.session)}</h2>
        <div class="sub">${n ? 'Most urgent first. Tick each one off as you place it at your broker.'
          : 'From the ' + fmt.date(o.scan_date) + ' close.'}</div></div>
      <div class="right">
        ${n > 0 && html`<span class="orders-progress">${k} of ${n} done<span class=${cls('bar', k === n && 'up')}>
          <span style=${`width:${(k / n) * 100}%`}></span></span></span>`}
        <button class="btn sm ghost" onClick=${copy} title="Copy the list as text"><${Icon} name="copy" />Copy</button>
      </div>
    </div>
    ${o.stale && html`<div style="padding:0 18px 12px"><${Callout} tone="warn">These orders were for ${fmt.date(o.session)}.
      ${STATIC ? "The next session's list appears here after the site's next scan." : "Press Run scan for the next session's list."}<//></div>`}
    ${o.items.map(it => html`<div class=${cls('order', done.has(it.key) && 'done')} key=${it.key}>
      <button class=${cls('tick', done.has(it.key) && 'on')} onClick=${() => toggle(it)}
        aria-label=${done.has(it.key) ? 'Mark as not done' : 'Mark as done'} title="Done"><${Icon} name="check" /></button>
      <span class=${`kind ${it.kind}`}>${KIND[it.kind]}</span>
      <div class="o-body"><div class="o-title">${it.title}</div><div class="o-detail">${it.detail}</div>
        ${it.kind === 'buy' && html`<div class="o-shariah"><${Badges} info=${it.info} compact /></div>`}</div>
      <div class="o-act"><${OrderAction} it=${it} /></div>
    </div>`)}
    ${!n && html`<div class="orders-empty"><${Icon} name="checkCircle" />Nothing to do at your broker.
      ${o.blocked ? ' No new buys while EGX30 is below its 50-day average.' : ' No BUY signals at this close.'}</div>`}
    ${(o.holds.length > 0 || o.skipped.length > 0) && html`<div class="orders-foot">
      ${o.holds.length > 0 && html`<span>No change: ${o.holds.map((h, i) => html`${i ? ', ' : ''}<b>${h.symbol}</b> (stop ${fmt.price(h.stop)})`)}</span>`}
      ${o.skipped.length > 0 && html`<span>Not bought: ${o.skipped.map((x, i) => html`${i ? ', ' : ''}<b>${x.symbol}</b> (${x.note})`)}</span>`}
    </div>`}
  </div></section>`;
}

function Level({ label, value, sub, subCls }) {
  return html`<div class="level"><div class="l-label">${label}</div><div class="l-value">${value}</div>
    ${sub && html`<div class=${cls('l-sub', subCls)}>${sub}</div>`}</div>`;
}

function SignalCard({ s, model }) {
  const i = s.info;
  const risk = s.close - s.stop, reward = s.target - s.close;
  const lossW = (risk / (risk + reward)) * 100;
  const logHref = buyHref(s.symbol, s.entry_high, s.shares);
  return html`<article class="card signal">
    <div class="sig-head">
      <div class="who">
        <div class="sym-line"><a class="sym-big" href=${stockHref(s.symbol)}>${s.symbol}</a><${IndexPills} info=${i} />
          ${s.setup && html`<span class="tag">${s.setup}</span>`}</div>
        <div class="stock-name" dir="rtl" style="text-align:left">${i.name_ar}</div>
        <div class="stock-sector">${i.sector}</div>
      </div>
      <${ScoreRing} score=${s.score} />
    </div>
    <${Badges} info=${i} />
    <${Cautions} items=${s.cautions} compact />
    ${(s.cautions || []).some(c => c.kind === 'ex_dividend') && html`<p class="caution-note">
      <${Icon} name="alert" size=${13} />It goes ex-dividend before this trade would end. The price drops by the
      dividend that morning, which can hit the stop. In 10 years of tests, BUY signals this close to an ex-date reached
      the target within a month 22% of the time, against 36% for the others. You still get the dividend if you hold.</p>`}
    <div class="levels">
      <${Level} label="Last close" value=${fmt.price(s.close)} />
      <${Level} label="Buy up to" value=${fmt.price(s.entry_high)} sub=${fmt.pct(s.entry_high / s.close - 1)} subCls="faint" />
      <${Level} label="Stop-loss" value=${fmt.price(s.stop)} sub=${fmt.pct(s.stop / s.close - 1)} subCls="down" />
      <${Level} label="Target" value=${fmt.price(s.target)} sub=${fmt.pct(s.target / s.close - 1)} subCls="up" />
    </div>
    <div class="rr">
      <div class="rr-bar"><span class="loss" style=${`width:${lossW}%`}></span><span class="gain" style=${`width:${100 - lossW}%`}></span></div>
      <div class="rr-labels"><span>Risk ${fmt.price(risk)} / share</span><span>Reward ${fmt.num(reward / risk, 1)}× the risk</span></div>
    </div>
    <div class="sizing">
      <span>Shares <b>${s.shares ? fmt.int(s.shares) : '–'}</b></span>
      <span>Amount <b>${fmt.egp(s.amount)}</b></span>
      <span>Max loss <b class="down">${fmt.egp(s.risk_egp)}</b></span>
    </div>
    <details class="why"><summary><${Icon} name="chevron" />Why this signal</summary>
      <ul class="reasons">${(s.reasons || []).map(r => html`<li class=${/^Caution/.test(r) ? 'caution' : ''}>${r}</li>`)}</ul></details>
    ${model && s.pred && html`<div class="model-line"><${Icon} name="target" size=${14} />
      ${s.pred.top10 === false
        ? html`<a href="#/predict">Model: not one of its top picks today</a>`
        : html`<a href="#/predict">Model: <${Chance} p=${s.pred.p10} base=${model.base[10]} /> chance of target before stop in 2 weeks</a>
      <span class="faint">(average stock ${fmt.pct(model.base[10], 0, false)})</span>`}</div>`}
    <div class="faint" style="font-size:12px">Sizing: ${s.size_note} · hold at most until <b class="muted">${fmt.date(s.sell_by)}</b></div>
    <div class="sig-foot">
      <a class="btn sm" href=${stockHref(s.symbol)}><${Icon} name="chart" />Chart</a>
      <a class="btn sm" href=${`#/calc/${encodeURIComponent(s.symbol)}`}><${Icon} name="coins" />Size it</a>
      <a class="btn sm primary" href=${logHref}><${Icon} name="plus" />Log buy</a>
    </div>
  </article>`;
}

function Watchlist({ rows, model }) {
  const columns = [
    { key: 'symbol', label: 'Stock', render: r => html`<${StockCell} symbol=${r.symbol} info=${r.info} />` },
    { key: 'sector', label: 'Sector', sortValue: r => r.info.sector, render: r => html`<span class="muted">${r.info.sector}</span>` },
    { key: 'shariah', label: 'Shariah', sortable: false, render: r => html`<${Badges} info=${r.info} compact />` },
    { key: 'score', label: 'Score', width: '150px', render: r => html`<${ScoreBar} score=${r.score} />` },
    { key: 'close', label: 'Close', align: 'r', fmt: v => fmt.price(v) },
    { key: 'trigger', label: 'Breakout above', align: 'r', fmt: v => html`<b>${fmt.price(v)}</b>` },
    { key: 'to_trigger', label: 'Distance', align: 'r', fmt: v => html`<span class="muted">${fmt.pct(v)}</span>`,
      title: 'How far the price must rise to break out' },
    { key: 'cautions', label: 'Good to know', sortable: false, render: r => html`<${Cautions} items=${r.cautions} compact />` },
  ];
  if (model) {
    columns.push({ key: 'model', label: 'Model (2 wk)', align: 'r', sortValue: r => (r.pred ? r.pred.p10 : -1),
      title: 'Prediction model: chance of target before stop within 10 sessions',
      render: r => html`<${Chance} p=${r.pred && r.pred.p10} base=${model.base[10]} top=${r.pred && r.pred.top10} />` });
  }
  return html`<${DataTable} columns=${columns} rows=${rows} rowKey=${r => r.symbol} sort=${{ key: 'score', dir: 'desc' }}
    onRowClick=${r => go(stockHref(r.symbol))} empty="No stocks on the watchlist at the last close." />`;
}
