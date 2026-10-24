// Paper Trading: the virtual account the agent trades by itself, compared with EGX30.
import { html, useApi, useState, useMemo, api, toast, refreshAll, fmt, tone } from '../lib.js';
import {
  Icon, Kpi, Empty, Callout, PageHead, PageLoading, DataTable, StockCell, Confirm,
} from '../ui.js';
import { LineChart } from '../charts.js';

export function PaperPage() {
  const { data, error } = useApi('/paper');
  const [tab, setTab] = useState('open');
  const [confirmReset, setConfirmReset] = useState(false);
  const lines = useMemo(() => (data && data.curve.length >= 2 ? [
    { data: data.curve, color: '--accent', title: 'Paper account' },
    { data: data.benchmark, color: '--text-3', title: 'EGX30 (same start)', dashed: true, width: 1.5 },
  ] : null), [data]);
  if (!data) return html`<${PageLoading} error=${error} />`;
  const s = data.summary;

  const tabs = [
    ['open', 'Open', data.open.length], ['pending', 'Orders for the next session', data.pending.length],
    ['closed', 'Closed', data.closed.length], ['cancelled', 'Skipped', data.cancelled.length],
  ];
  const cols = {
    open: [
      { key: 'symbol', label: 'Stock', render: r => html`<${StockCell} symbol=${r.symbol} sub=${false} />` },
      { key: 'entry_date', label: 'Bought', fmt: v => fmt.date(v) },
      { key: 'entry_price', label: 'Entry', align: 'r', fmt: v => fmt.price(v) },
      { key: 'shares', label: 'Shares', align: 'r', fmt: v => fmt.int(v) },
      { key: 'last', label: 'Last', align: 'r', fmt: v => fmt.price(v) },
      { key: 'pnl_pct', label: 'Profit / loss', align: 'r', fmt: v => html`<span class=${tone(v)}>${fmt.pct(v)}</span>` },
      { key: 'stop', label: 'Stop', align: 'r', fmt: v => html`<span class="down">${fmt.price(v)}</span>` },
      { key: 'target', label: 'Target', align: 'r', fmt: v => html`<span class="up">${fmt.price(v)}</span>` },
      { key: 'days_held', label: 'Day', align: 'r' },
    ],
    pending: [
      { key: 'symbol', label: 'Stock', render: r => html`<${StockCell} symbol=${r.symbol} sub=${false} />` },
      { key: 'signal_date', label: 'Signal', fmt: v => fmt.date(v) },
      { key: 'shares', label: 'Shares', align: 'r', fmt: v => fmt.int(v) },
      { key: 'entry_limit', label: 'Buy up to', align: 'r', fmt: v => fmt.price(v) },
      { key: 'stop', label: 'Stop', align: 'r', fmt: v => fmt.price(v) },
      { key: 'target', label: 'Target', align: 'r', fmt: v => fmt.price(v) },
    ],
    closed: [
      { key: 'symbol', label: 'Stock', render: r => html`<${StockCell} symbol=${r.symbol} sub=${false} />` },
      { key: 'entry_date', label: 'Bought', fmt: v => fmt.date(v) },
      { key: 'entry_price', label: 'Entry', align: 'r', fmt: v => fmt.price(v) },
      { key: 'exit_date', label: 'Sold', fmt: v => fmt.date(v) },
      { key: 'exit_price', label: 'Exit', align: 'r', fmt: v => fmt.price(v) },
      { key: 'days_held', label: 'Days', align: 'r' },
      { key: 'return_pct', label: 'Return', align: 'r', fmt: v => html`<span class=${tone(v)}>${fmt.pct(v)}</span>` },
      { key: 'pnl', label: 'Profit / loss (EGP)', align: 'r', fmt: v => html`<b class=${tone(v)}>${fmt.signed(v)}</b>` },
      { key: 'exit_reason', label: 'Reason', render: r => html`<span class="muted">${r.exit_reason}</span>` },
    ],
    cancelled: [
      { key: 'symbol', label: 'Stock', render: r => html`<${StockCell} symbol=${r.symbol} sub=${false} />` },
      { key: 'signal_date', label: 'Signal', fmt: v => fmt.date(v) },
      { key: 'exit_reason', label: 'Why skipped', render: r => html`<span class="muted">${r.exit_reason}</span>` },
    ],
  };
  const empties = {
    open: 'No open paper trades.', pending: 'No orders waiting for the next session.',
    closed: 'No closed paper trades yet.', cancelled: 'No skipped orders.',
  };

  const reset = async () => {
    try {
      const r = await api('/paper/reset', { method: 'POST' });
      toast(r.message);
      refreshAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return html`
    <${PageHead} title="Practice account"
      sub=${`A virtual ${fmt.egp(data.paper_capital)} account. After every scan the agent buys each BUY signal at the next open (skipping gaps above Buy up to) and sells by the same exit rules you get.`} />
    ${!data.auto_paper && html`<div style="margin-bottom:14px"><${Callout} tone="warn">Automatic paper trading is off.
      <a href="#/settings">Turn it on in Settings.</a><//></div>`}
    <div class="kpis">
      <${Kpi} label="Paper account" value=${fmt.short(s.equity)} sub=${`${fmt.pct(s.return_pct)} since start`} subClass=${tone(s.return_pct)} />
      <${Kpi} label="Cash" value=${fmt.short(s.cash)} />
      <${Kpi} label="Open positions" value=${s.open_count} />
      <${Kpi} label="Closed trades" value=${data.closed.length} />
      <${Kpi} label="Win rate" value=${data.win_rate == null ? '–' : fmt.pct(data.win_rate, 0, false)} />
    </div>

    <div class="card flush" style="margin-top:14px">
      ${lines ? html`<${LineChart} lines=${lines} height=${320} />`
        : html`<${Empty} icon="chart" title="No equity curve yet"
          text="It appears once the first paper trade has been filled. Let the agent run for 3–4 weeks and compare it with EGX30 before trusting real money." />`}
    </div>

    <div class="card flush" style="margin-top:14px">
      <div class="tabs">${tabs.map(([k, label, n]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>
        ${label} <span class="pill-count">${n}</span></button>`)}</div>
      <${DataTable} key=${tab} columns=${cols[tab]} rows=${data[tab]} empty=${empties[tab]} />
    </div>

    <div class="card" style="margin-top:14px">
      <div class="row"><div style="flex:1;min-width:240px"><b>Reset the paper account</b>
        <div class="muted" style="font-size:13px">Deletes every paper trade and starts again with the paper capital from Settings.</div></div>
        <button class="btn danger-ghost" onClick=${() => setConfirmReset(true)}><${Icon} name="trash" />Reset paper account</button></div>
    </div>
    ${confirmReset && html`<${Confirm} title="Reset the paper account?" danger confirmLabel="Delete all paper trades"
      text="Every paper trade (open, closed, pending and skipped) is deleted. Your real portfolio is not touched."
      onConfirm=${reset} onClose=${() => setConfirmReset(false)} />`}`;
}
