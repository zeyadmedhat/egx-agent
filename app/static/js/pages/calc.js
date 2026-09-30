// Size calculator: how many shares to buy with your own risk rules, and what the buy would do to your portfolio.
// Nothing is saved or ordered. The sizing is the BUY signals' own (sizing.js → risk.py's rule).
import { html, useApi, useState, useEffect, fmt, go, cls } from '../lib.js';
import {
  Icon, PageLoading, StockPicker, Field, Seg, Callout, MarketSwitch, StatusChip, Chance, Empty,
} from '../ui.js';
import { t, tn } from '../i18n.js';
import { planTrade } from '../sizing.js';

const SIZES = [{ value: 'full', label: 'Full size' }, { value: 'half', label: 'Half size' }];
const LEVEL = { ok: ['checkCircle', 'ok'], warn: ['alert', 'warn'], bad: ['xCircle', 'bad'] };

export function CalcPage({ route }) {
  const sym = (route.arg || '').toUpperCase();
  const { data: acct, error } = useApi('/calc');
  const { data: st, error: stError } = useApi(sym ? `/stock/${encodeURIComponent(sym)}` : null);
  const [form, setForm] = useState(null);          // null: the defaults below; your edits otherwise
  useEffect(() => { setForm(null); }, [sym]);

  const head = html`<div class="page-head"><div><h1>${t('Size calculator')}</h1>
      <div class="sub">${t('How many shares to buy with your own risk rules. Nothing is saved or ordered.')}</div></div>
    <div style="width:min(380px,100%)"><${StockPicker} value=${sym} onChange=${s => go(`#/calc/${encodeURIComponent(s)}`)}
      placeholder="Pick a stock (symbol or name)…" /></div></div>`;
  if (!acct) return html`${head}<${PageLoading} error=${error} />`;
  if (!sym) {
    return html`${head}<div class="card"><${Empty} icon="coins" title="Pick a stock"
      text="Search above, or press Size it on a stock's page. It uses your settings and My Portfolio: your account value, cash, open positions and limits." /></div>`;
  }
  if (!st) return html`${head}<${PageLoading} error=${stError} />`;
  if (!st.has_data) {
    return html`${head}<${Callout} tone="warn"><b>No price data for ${sym}.</b> ${st.message || ''}<//>`;
  }

  const sig = st.signal && st.signal.action === 'BUY' ? st.signal : null;
  const defaults = {
    entry: String(st.stats.close), stop: (sig ? sig.stop : st.plan.stop).toFixed(st.stats.close < 10 ? 3 : 2),
    equity: String(Math.round(acct.equity)), cash: String(Math.round(acct.cash)),
    size: acct.switch && acct.switch.state === 'half' ? 'half' : 'full',
  };
  const f = form || defaults;
  const set = k => e => setForm({ ...f, [k]: e.target.value });
  const res = planTrade({
    symbol: st.symbol, sector: st.info.sector || 'Other', entry: Number(f.entry), stop: Number(f.stop),
    equity: Number(f.equity), cash: Number(f.cash), avgValue: st.stats.value_avg20, positions: acct.positions,
    cfg: acct.cfg, riskOff: acct.risk_off, half: f.size === 'half',
  });
  const cfg = acct.cfg;
  const pred = st.prediction;

  return html`${head}
    ${acct.risk_off && html`<div style="margin-bottom:10px"><${Callout} tone="warn"><b>EGX30 is below its 50-day average.</b>${' '}
      Your BUY rules make no new buys now, and allow half the usual number of positions.<//></div>`}
    ${acct.switch && html`<div style="margin-bottom:14px"><${MarketSwitch} sw=${acct.switch} /></div>`}
    <div class="grid grid-2 calc-grid">
      <div class="card">
        <div class="card-title"><a class="sym" href=${`#/stock/${encodeURIComponent(st.symbol)}`}>${st.symbol}</a>
          <span class="faint" dir="auto">${st.info.name_ar || ''}</span>
          ${st.signal && html`<span class="right"><${StatusChip} status=${st.signal.action} /></span>`}</div>
        <p class="muted" style="font-size:13px;margin-bottom:14px">Last close ${fmt.price(st.stats.close)} on${' '}
          ${fmt.date(st.stats.last_bar)}.${' '}${sig ? `Today's BUY signal: buy up to ${fmt.price(sig.entry_high)}.`
          : 'No BUY signal for it today: this is your own idea.'}${' '}
          ${pred && html`Model: <${Chance} p=${pred.p10} base=${pred.base[10]} top=${pred.top10} /> (2 weeks).`}</p>
        <div class="form-grid">
          <${Field} label="Entry price" help="A buy fills at the next open, not at this price.">
            <input class="input" type="number" min="0.001" step="0.01" value=${f.entry} onInput=${set('entry')} /><//>
          <${Field} label="Stop-loss" help=${`The agent's usual stop: ${fmt.price(st.plan.stop)} (${cfg.stop_min_pct}–${cfg.stop_max_pct}% below).`}>
            <input class="input" type="number" min="0.001" step="0.01" value=${f.stop} onInput=${set('stop')} /><//>
          <${Field} label="Account value (EGP)" help="From My Portfolio: cash plus your positions at the last close.">
            <input class="input" type="number" min="0" step="100" value=${f.equity} onInput=${set('equity')} /><//>
          <${Field} label="Cash available (EGP)">
            <input class="input" type="number" min="0" step="100" value=${f.cash} onInput=${set('cash')} /><//>
        </div>
        <div class="row" style="margin-top:14px;justify-content:space-between">
          <${Seg} options=${SIZES} value=${f.size} onChange=${v => setForm({ ...f, size: v })} />
          ${form && html`<button class="linkish" onClick=${() => setForm(null)}>Reset to the defaults</button>`}
        </div>
        <p class="faint" style="font-size:12px;margin-top:10px">Your rules: risk ${cfg.risk_per_trade_pct}% of the
          account a trade, at most ${cfg.max_position_pct}% in one stock and ${cfg.max_pct_of_adv}% of its daily traded
          value, fees ${cfg.fee_pct_per_side}% a side.${' '}<a href="#/settings">Change them in Settings →</a></p>
      </div>
      <${Result} res=${res} sym=${st.symbol} entry=${Number(f.entry)} />
    </div>
    ${res.ok && html`<div class="card" style="margin-top:14px"><div class="card-title">${t('Your portfolio limits')}</div>
      <ul class="checklist">${res.checks.map(c => html`<li>
        <span class=${LEVEL[c.level][1]}><${Icon} name=${LEVEL[c.level][0]} /></span><span>${c.text}</span></li>`)}</ul></div>`}`;
}

function Result({ res, sym, entry }) {
  if (!res.ok) return html`<div class="card"><${Callout} tone="bad">${res.error}<//></div>`;
  const log = `#/portfolio?buy=${encodeURIComponent(sym)}&price=${entry.toFixed(2)}&shares=${res.shares}`;
  return html`<div class="card calc-result">
    <div class="eyebrow">Buy</div>
    <div class=${cls('calc-shares', res.shares ? 'up' : 'down')}>${fmt.int(res.shares)} <span>shares</span></div>
    <div class="faint" style="font-size:12.5px;margin-bottom:14px">Sized by: ${tn(res.size_note)}</div>
    <div class="stat-list">
      <span class="k">${t('Amount')}</span><span class="v">${fmt.egp(res.amount)}
        <span class="faint" style="font-weight:500"> ${fmt.pct(res.position_pct, 1, false)} of the account</span></span>
      <span class="k">${t('Buy fee')}</span><span class="v">${fmt.egp(res.buy_fee, 2)}</span>
      <span class="k">${t('Stop-loss')}</span><span class="v down">${fmt.price(entry - res.per_share)}
        <span class="faint" style="font-weight:500"> ${fmt.pct(-res.stop_pct, 1)}</span></span>
      <span class="k">${t('Target')}</span><span class="v up">${fmt.price(res.target)}
        <span class="faint" style="font-weight:500"> ${fmt.pct(res.target_pct, 1)}</span></span>
      <span class="k">${t('If the stop is hit')}</span><span class="v down">${fmt.egp(res.loss_at_stop ? -res.loss_at_stop : 0)}
        <span class="faint" style="font-weight:500"> ${fmt.pct(res.loss_pct ? -res.loss_pct : 0, 2)} of the account</span></span>
      <span class="k">${t('If the target is hit')}</span><span class="v up">${res.gain_at_target ? '+' : ''}${fmt.egp(res.gain_at_target)}</span>
      <span class="k">${t('Cash left after')}</span><span class="v">${fmt.egp(res.cash_after)}</span>
    </div>
    <p class="faint" style="font-size:12px;margin-top:10px">Fees on both sides included. A gap through the stop can
      lose more.</p>
    ${res.shares > 0 && html`<a class="btn primary block" style="margin-top:14px" href=${log}>
      <${Icon} name="plus" />${t('Log this buy after it fills')}</a>`}
  </div>`;
}
