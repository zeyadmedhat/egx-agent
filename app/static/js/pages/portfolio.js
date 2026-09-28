// My Portfolio: account tiles, open positions (sell, bonus shares, dividends, transactions), log a buy, closed trades.
import {
  html, useApi, useState, useEffect, useStore, api, toast, refreshAll, fmt, tone, cls, go, todayISO,
} from '../lib.js';
import {
  Icon, StatusChip, Kpi, PageHead, SectionHead, Disclaimer, PageLoading, DataTable, StockCell, DayBar, Field,
  StockPicker, Confirm, Callout,
} from '../ui.js';

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
    { key: 'reason', label: 'What to do', sortable: false, render: r => html`<span class="muted" style="font-size:12.5px">${r.reason}</span>` },
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
  return html`
    <${PageHead} title="My Portfolio"
      sub="Log the trades you place with your broker. After each close the agent checks every position against the exit rules.">
      <button class="btn primary" onClick=${scrollToBuy}><${Icon} name="plus" />Log a buy</button><//>
    ${data.nothing_saved && html`<div style="margin-bottom:14px"><${Callout} tone="warn"><b>Nothing is saved in this
      browser yet.</b> Your portfolio is kept only in the browser where you entered it, and links opened from Telegram
      or another app can open a different browser. Open the site there, or bring your portfolio here with${' '}
      <a href="#/settings">Settings → Restore from a backup</a>.<//></div>`}
    <div class="kpis">
      <${Kpi} label="Account value" icon="wallet" value=${fmt.short(s.equity)} sub=${`${fmt.pct(s.return_pct)} since start`} subClass=${tone(s.return_pct)} />
      <${Kpi} label="Cash" value=${fmt.short(s.cash)} valueClass=${s.cash < 0 ? 'down' : ''}
        sub=${s.cash < 0 ? 'you bought more than your capital' : 'not invested'} subClass=${s.cash < 0 ? 'warn' : ''} />
      <${Kpi} label="Open P&L" value=${fmt.signed(s.unrealized)} valueClass=${tone(s.unrealized)} sub="EGP, before selling fees" />
      <${Kpi} label="Realized P&L" value=${fmt.signed(s.realized)} valueClass=${tone(s.realized)}
        sub=${s.dividends ? `EGP, after fees · incl. ${fmt.int(s.dividends)} dividends` : 'EGP, after fees'} />
      <${Kpi} label="Loss if all stops hit" value=${fmt.short(s.open_risk)}
        sub=${s.equity ? `${fmt.pct(s.open_risk / s.equity, 1, false)} of your account` : ''} />
    </div>
    <p class="faint" style="font-size:12.5px;margin-top:10px">Starting capital ${fmt.egp(s.start)}${' '}
      (<a href="#/settings">change it in Settings</a>). P&L includes ${data.fee_pct}% fees per side.</p>

    <section class="section">
      <${SectionHead} title="Open positions" count=${data.positions.length}
        hint="Click a position to sell some or all of it, see its transactions or delete it." />
      <div class="card flush"><${DataTable} columns=${posColumns} rows=${data.positions} rowKey=${r => r.id}
        expandedKey=${openId} onRowClick=${r => setOpenId(id => (id === r.id ? null : r.id))}
        renderExpanded=${r => html`<${PositionDetail} p=${r} data=${data} onDone=${() => setOpenId(null)} />`}
        empty="No open positions. After you buy at your broker, log it below." /></div>
      <p class="faint" style="font-size:12px;margin-top:8px">EXIT: sell at the next open · REVIEW: 2 weeks without progress,
        consider exiting · TIGHTEN STOP: move your stop order up · HOLD: nothing to do · UPDATE SHARES: the company
        gave bonus shares or split its shares, so enter your new share count</p>
    </section>

    <section class="section" id="buy-form" style="scroll-margin-top:80px">
      <${SectionHead} title="Log a buy" hint="Record a buy you placed at your broker." />
      <${BuyForm} data=${data} query=${route.query} />
    </section>

    <section class="section">
      <${SectionHead} title="Closed trades" count=${cs.count}
        hint=${cs.count ? `Win rate ${fmt.pct(cs.win_rate, 0, false)} · total ${fmt.signed(cs.total)} EGP` : ''} />
      <div class="card flush"><${DataTable} columns=${closedColumns} rows=${data.closed} rowKey=${r => r.id}
        empty="Nothing closed yet." /></div>
    </section>
    <${Disclaimer} />`;
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
        <button class="btn primary" type="submit" disabled=${!valid || busy}><${Icon} name="sell" />Record sale</button>
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
      <button class="btn ghost sm" type="button" onClick=${onClose}>Cancel</button>
      <button class="btn primary sm" type="submit" disabled=${busy || amount <= 0}><${Icon} name="check" />Save dividend</button>
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
          : 'New position. The stop is set automatically: 2× the daily range below your price, kept between 4% and 12%.'}</span></div>`;
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
      <button class="btn primary" type="submit" disabled=${!valid || busy}><${Icon} name="plus" />Save buy</button>
    </div>
  </form>`;
}
