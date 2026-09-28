// Backtest: replay the agent's exact rules over past EGX data and compare with EGX30.
import { html, useApi, useState, useEffect, useMemo, startJob, fmt, tone, STATIC } from '../lib.js';
import {
  Icon, Kpi, Empty, Callout, PageHead, SectionHead, Disclaimer, PageLoading, DataTable, StockCell, Seg, Field,
  JobProgress, useJob,
} from '../ui.js';
import { LineChart } from '../charts.js';

const YEARS = [1, 2, 3, 4].map(y => ({ value: y, label: `${y} year${y > 1 ? 's' : ''}` }));
const UNIVERSES = [
  { value: 'all', label: 'All liquid EGX stocks' },
  { value: 'egx30', label: 'EGX30 members only' },
  { value: 'egx33', label: 'EGX33 Shariah members only' },
];

export function BacktestPage() {
  const { data: res, error, loading } = useApi('/backtest');
  const [years, setYears] = useState(3);
  const [universe, setUniverse] = useState('all');
  const { running, mine } = useJob('backtest');
  useEffect(() => {
    if (res && res.params) { setYears(res.params.years); setUniverse(res.params.universe); }
  }, [res]);
  const equity = useMemo(() => res && [
    { data: res.equity, color: '--accent', title: 'Agent' },
    { data: res.index, color: '--text-3', title: 'EGX30 buy & hold', dashed: true, width: 1.5 },
  ], [res]);
  const drawdown = useMemo(() => res && [{ data: res.drawdown, color: '--down', title: 'Drawdown', area: true, width: 1.5 }], [res]);

  const run = () => startJob('/backtest', { years, universe });
  const controls = STATIC ? html`<div class="card"><p class="muted" style="font-size:13px">The site runs this backtest
    by itself every week with the group's strategy and a 100,000 EGP account, so everyone sees the same result.</p></div>`
    : html`<div class="card">
    <div class="row" style="gap:18px;align-items:flex-end">
      <${Field} label="Period"><${Seg} options=${YEARS} value=${years} onChange=${setYears} /><//>
      <${Field} label="Stocks"><select class="input" style="min-width:240px" value=${universe}
        onChange=${e => setUniverse(e.target.value)}>${UNIVERSES.map(u => html`<option value=${u.value}>${u.label}</option>`)}</select><//>
      <button class="btn primary" onClick=${run} disabled=${running} style="margin-left:auto">
        <${Icon} name="play" />${mine ? 'Running…' : 'Run backtest'}</button>
    </div>
    <p class="faint" style="font-size:12.5px;margin-top:12px">Uses your current Settings: signals at each close, buys at the
      next open, the same position sizing, fees, stops, targets and 1-month limit. The first run takes about 20–40 seconds.</p>
  </div>`;

  if (loading && !res) return html`<${PageHead} title="Backtest" />${controls}<div style="margin-top:14px"><${PageLoading} error=${error} /></div>`;
  return html`
    <${PageHead} title="Backtest" sub="How the rules would have done in the past, compared with simply holding EGX30." />
    ${controls}
    <div style="margin-top:14px"><${JobProgress} kind="backtest" title="Replaying the market…" /></div>
    ${!res && !mine && html`<div class="card" style="margin-top:14px"><${Empty} icon="history" title="No backtest yet"
      text=${STATIC ? "The first one appears after the site's weekly backtest." : 'Pick a period and press Run backtest.'} /></div>`}
    ${res && html`<${Results} res=${res} equity=${equity} drawdown=${drawdown} />`}
    <div style="margin-top:18px"><${Callout} tone="warn"><b>Read these results with care.</b>${' '}
      (1) Only stocks listed today are tested, so companies that collapsed or delisted are missing, which flatters results.
      (2) Returns are in nominal EGP; much of EGX30's rise since 2022 reflects the pound's devaluation.
      (3) Real fills can be worse than the open price, especially in thin stocks.
      (4) Shariah status is today's, not what it was at the time. A backtest is a sanity check, not a promise.<//></div>
    <${Disclaimer} />`;
}

function Results({ res, equity, drawdown }) {
  const m = res.metrics;
  const [showAll, setShowAll] = useState(false);
  const pf = m.profit_factor_inf ? '∞' : fmt.num(m.profit_factor, 2);
  const tradeCols = [
    { key: 'symbol', label: 'Stock', render: r => html`<${StockCell} symbol=${r.symbol} sub=${false} />` },
    { key: 'entry_date', label: 'Bought', fmt: v => fmt.date(v) },
    { key: 'entry_price', label: 'Entry', align: 'r', fmt: v => fmt.price(v) },
    { key: 'exit_date', label: 'Sold', fmt: v => fmt.date(v) },
    { key: 'exit_price', label: 'Exit', align: 'r', fmt: v => fmt.price(v) },
    { key: 'shares', label: 'Shares', align: 'r', fmt: v => fmt.int(v) },
    { key: 'days_held', label: 'Days', align: 'r' },
    { key: 'return_pct', label: 'Return', align: 'r', fmt: v => html`<span class=${tone(v)}>${fmt.pct(v)}</span>` },
    { key: 'pnl', label: 'P&L (EGP)', align: 'r', fmt: v => html`<b class=${tone(v)}>${fmt.signed(v)}</b>` },
    { key: 'reason', label: 'Exit', render: r => html`<span class="muted">${r.reason}</span>` },
  ];
  const stockCols = [
    { key: 'symbol', label: 'Stock', render: r => html`<${StockCell} symbol=${r.symbol} sub=${false} />` },
    { key: 'trades', label: 'Trades', align: 'r' },
    { key: 'pnl', label: 'P&L (EGP)', align: 'r', fmt: v => html`<b class=${tone(v)}>${fmt.signed(v)}</b>` },
  ];
  return html`
    <section class="section">
      <${SectionHead} title=${res.label} hint=${`Run ${fmt.datetime(res.ran_at)}`} />
      <div class="kpis">
        <${Kpi} label="Total return" value=${fmt.pct(m.total_return)} valueClass=${tone(m.total_return)} sub=${`EGX30 ${fmt.pct(m.egx30_return)}`} />
        <${Kpi} label="Per year (CAGR)" value=${fmt.pct(m.cagr)} valueClass=${tone(m.cagr)} />
        <${Kpi} label="Worst drop" value=${fmt.pct(m.max_drawdown)} valueClass="down" sub="max drawdown" />
        <${Kpi} label="Final value" value=${fmt.short(m.final_equity)} sub="EGP" />
      </div>
      <div class="kpis" style="margin-top:12px">
        <${Kpi} label="Trades" value=${m.trades} sub=${`${m.orders_cancelled} orders skipped`} />
        <${Kpi} label="Win rate" value=${m.win_rate == null ? '–' : fmt.pct(m.win_rate, 0, false)}
          sub=${m.avg_win != null ? `avg win ${fmt.pct(m.avg_win)} / loss ${fmt.pct(m.avg_loss)}` : ''} />
        <${Kpi} label="Profit factor" value=${pf} sub="above 1 = profitable" valueClass=${m.profit_factor_inf || m.profit_factor > 1 ? 'up' : 'down'} />
        <${Kpi} label="Avg days held" value=${fmt.num(m.avg_days_held, 1)} sub=${`invested ${fmt.pct(m.exposure, 0, false)} of days`} />
      </div>
    </section>
    <div class="card flush" style="margin-top:14px"><${LineChart} lines=${equity} height=${340} /></div>
    <div class="card flush" style="margin-top:14px"><${LineChart} lines=${drawdown} height=${170} format="pct" /></div>
    ${res.trades.length > 0 && html`
      <div class="grid grid-3" style="margin-top:14px">
        <div class="card flush"><div class="card-title" style="padding:14px 18px 0">How trades ended</div>
          <${DataTable} columns=${[{ key: 'reason', label: 'Exit' }, { key: 'trades', label: 'Trades', align: 'r' }]}
            rows=${res.exits} /></div>
        <div class="card flush"><div class="card-title" style="padding:14px 18px 0">Best stocks</div>
          <${DataTable} columns=${stockCols} rows=${res.best} /></div>
        <div class="card flush"><div class="card-title" style="padding:14px 18px 0">Worst stocks</div>
          <${DataTable} columns=${stockCols} rows=${res.worst} /></div>
      </div>
      <section class="section">
        <${SectionHead} title="All trades" count=${res.trades.length}>
          <button class="btn sm" onClick=${() => setShowAll(x => !x)}>${showAll ? 'Hide' : 'Show'} trades</button><//>
        ${showAll && html`<div class="card flush"><${DataTable} columns=${tradeCols} rows=${res.trades}
          sort=${{ key: 'exit_date', dir: 'desc' }} /></div>`}
      </section>`}`;
}
