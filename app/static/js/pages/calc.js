// Calculators. Position size: how many shares to buy with your own risk rules, and what the buy would do to your
// portfolio (the BUY signals' own sizing: sizing.js → risk.py's rule). Zakat: what's due on your shares and cash, with
// the nisab from today's gold price. Bank certificate: what the same money earns in a certificate. Nothing is saved.
import { html, useApi, useState, useEffect, fmt, go, cls, tone } from '../lib.js';
import {
  Icon, PageLoading, StockPicker, Field, Seg, Callout, MarketSwitch, StatusChip, Chance, Empty,
} from '../ui.js';
import { t, tn } from '../i18n.js';
import { planTrade } from '../sizing.js';

const SIZES = [{ value: 'full', label: 'Full size' }, { value: 'half', label: 'Half size' }];
const LEVEL = { ok: ['checkCircle', 'ok'], warn: ['alert', 'warn'], bad: ['xCircle', 'bad'] };

const TOOLS = [{ value: 'size', label: 'Position size' }, { value: 'zakat', label: 'Zakat' }, { value: 'cert', label: 'Bank certificate' }];

export function CalcPage({ route }) {
  const tool = TOOLS.some(x => x.value === route.query.tool) ? route.query.tool : 'size';
  const sym = tool === 'size' ? (route.arg || '').toUpperCase() : '';
  const { data: acct, error } = useApi('/calc');
  const { data: st, error: stError } = useApi(sym ? `/stock/${encodeURIComponent(sym)}` : null);
  const [form, setForm] = useState(null);          // null: the defaults below; your edits otherwise
  useEffect(() => { setForm(null); }, [sym]);

  const tabs = html`<div style="margin-bottom:14px"><${Seg} options=${TOOLS} value=${tool}
    onChange=${v => go(v === 'size' ? '#/calc' : `#/calc?tool=${v}`)} /></div>`;
  if (tool !== 'size') {
    const Tool = tool === 'zakat' ? ZakatTool : CertificateTool;
    return html`${tabs}${acct ? html`<${Tool} acct=${acct} />` : html`<${PageLoading} error=${error} />`}`;
  }
  const head = html`${tabs}<div class="page-head"><div><h1>${t('Size calculator')}</h1>
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

// ------------------------------------------------------------------ zakat
// Dar al-Ifta (Egypt): the nisab is the value of 85 grams of 21-carat gold, and zakat is 2.5% of money that has
// stayed at or above it for a lunar year. Shares bought to trade count at their market value.
const NISAB_G = 85;
const CARATS = [{ value: '21', label: '21 carat (Dar al-Ifta)' }, { value: '24', label: '24 carat' }];
const num = v => (v === '' || v == null ? 0 : Number(v));

function ZakatTool({ acct }) {
  const m = acct.money || {};
  const [carat, setCarat] = useState('21');
  const gram24 = m.gold_gram || null;
  const defaults = { shares: String(Math.max(0, Math.round(acct.shares_value || 0))), cash: String(Math.max(0, Math.round(acct.cash || 0))),
    other: '0', debts: '0', price: gram24 ? String(Math.round(gram24 * (Number(carat) / 24))) : '' };
  const [form, setForm] = useState(null);
  const f = { ...defaults, ...(form || {}), ...(form && form.price != null ? {} : { price: defaults.price }) };
  const set = k => e => setForm({ ...(form || {}), [k]: e.target.value });
  const pickCarat = v => { setCarat(v); setForm(x => { const y = { ...(x || {}) }; delete y.price; return y; }); };
  const total = num(f.shares) + num(f.cash) + num(f.other) - num(f.debts);
  const nisab = NISAB_G * num(f.price);
  const due = nisab > 0 && total >= nisab;
  return html`<div class="page-head"><div><h1>${t('Zakat calculator')}</h1>
      <div class="sub">${t('What zakat is due on your shares and savings, with the nisab from today\'s gold price. Nothing is saved.')}</div></div></div>
    <div class="grid grid-2 calc-grid">
      <div class="card">
        <div class="form-grid">
          <${Field} label="Your shares at market value (EGP)" help="From My Portfolio at the last close. Shares bought to trade count at their market value.">
            <input class="input" type="number" min="0" step="100" value=${f.shares} onInput=${set('shares')} /><//>
          <${Field} label="Cash in your trading account (EGP)">
            <input class="input" type="number" min="0" step="100" value=${f.cash} onInput=${set('cash')} /><//>
          <${Field} label="Other savings (EGP)" help="Bank balances, certificates, cash, gold kept as savings.">
            <input class="input" type="number" min="0" step="100" value=${f.other} onInput=${set('other')} /><//>
          <${Field} label="Debts due now (EGP)" help="Money you owe that is due, taken off before zakat.">
            <input class="input" type="number" min="0" step="100" value=${f.debts} onInput=${set('debts')} /><//>
        </div>
        <div style="margin-top:14px"><div class="faint" style="font-size:12.5px;margin-bottom:6px">${t('Nisab: 85 grams of gold')}</div>
          <${Seg} options=${CARATS} value=${carat} onChange=${pickCarat} /></div>
        <div class="form-grid" style="margin-top:12px">
          <${Field} label=${t('Gold, {c} carat, EGP a gram', { c: carat })} help=${gram24
            ? t("From the world gold price and the dollar rate of {date}. Egypt's shop price is usually a little higher: type it if you know it.", { date: fmt.date(m.gold_date || m.date) })
            : t('Type today\'s gold price: the site has none yet.')}>
            <input class="input" type="number" min="0" step="1" value=${f.price} onInput=${set('price')} /><//>
        </div>
        ${form && html`<button class="linkish" style="margin-top:10px" onClick=${() => setForm(null)}>${t('Reset to the defaults')}</button>`}
      </div>
      <div class="card calc-result">
        <div class="eyebrow">${t('Zakat due')}</div>
        <div class=${cls('calc-shares', due ? 'up' : '')}>${due ? fmt.egp(total * 0.025) : fmt.egp(0)}</div>
        <div class="stat-list" style="margin-top:12px">
          <span class="k">${t('Total counted')}</span><span class="v">${fmt.egp(total)}</span>
          <span class="k">${t('Nisab (85 g × {price})', { price: fmt.int(num(f.price)) })}</span><span class="v">${nisab ? fmt.egp(nisab) : '–'}</span>
          <span class="k">${t('Rate')}</span><span class="v">2.5%</span>
        </div>
        <p class="muted" style="font-size:13px;margin-top:12px">${!nisab ? t('Type the gold price to see the nisab.')
          : due ? t('Your money is above the nisab: zakat is due once a lunar (Hijri) year has passed with it at or above the nisab.')
            : t('Below the nisab: no zakat is due on this money.')}</p>
        <p class="faint" style="font-size:12px;margin-top:10px">${t('Following Dar al-Ifta: the nisab is 85 grams of 21-carat gold and zakat is a quarter of a tenth (2.5%). Scholars differ on shares held for the long term (some count only the company\'s own zakatable assets): ask a scholar you trust about your own case.')}</p>
      </div>
    </div>`;
}

// ------------------------------------------------------------------ bank certificate
const YEARS = [{ value: '1', label: '1 year' }, { value: '3', label: '3 years' }];
const PAYS = [{ value: 'monthly', label: 'Paid monthly' }, { value: 'end', label: 'Paid at the end' }];

function CertificateTool({ acct }) {
  const m = acct.money || {};
  const defaults = { amount: String(Math.max(10000, Math.round((acct.equity || 100000) / 1000) * 1000)),
    rate: m.rate != null ? String(Math.round(m.rate * 4) / 4) : '', years: '1', pays: 'monthly' };
  const [form, setForm] = useState(null);
  const f = { ...defaults, ...(form || {}) };
  const set = k => e => setForm({ ...f, [k]: e.target.value });
  const amount = num(f.amount), rate = num(f.rate) / 100, years = num(f.years);
  const interest = amount * rate * years;                 // Egyptian certificates pay simple interest
  const infl = m.inflation != null ? m.inflation / 100 : null;
  const real = infl != null ? (1 + rate) / (1 + infl) - 1 : null;
  const fee = (acct.cfg && acct.cfg.fee_pct_per_side) || 0;
  return html`<div class="page-head"><div><h1>${t('Bank certificate calculator')}</h1>
      <div class="sub">${t('What the same money would earn in a bank certificate: the return your stocks have to beat. Nothing is saved.')}</div></div></div>
    <div class="grid grid-2 calc-grid">
      <div class="card">
        <div class="form-grid">
          <${Field} label="Amount (EGP)">
            <input class="input" type="number" min="0" step="1000" value=${f.amount} onInput=${set('amount')} /><//>
          <${Field} label="Yearly interest (%)" help=${m.rate != null
            ? t("Filled in with Egypt's interbank rate on {date} ({rate}%). Banks set their own certificate rates: type your bank's.", { date: fmt.date(m.date), rate: fmt.num(m.rate, 2) })
            : t("Type your bank's rate.")}>
            <input class="input" type="number" min="0" max="100" step="0.25" value=${f.rate} onInput=${set('rate')} /><//>
        </div>
        <div class="row" style="margin-top:14px;gap:10px;flex-wrap:wrap">
          <${Seg} options=${YEARS} value=${f.years} onChange=${v => setForm({ ...f, years: v })} />
          <${Seg} options=${PAYS} value=${f.pays} onChange=${v => setForm({ ...f, pays: v })} />
        </div>
        ${form && html`<button class="linkish" style="margin-top:10px" onClick=${() => setForm(null)}>${t('Reset to the defaults')}</button>`}
      </div>
      <div class="card calc-result">
        <div class="eyebrow">${t(f.pays === 'monthly' ? 'Interest a month' : 'Interest at the end')}</div>
        <div class="calc-shares up">${fmt.egp(f.pays === 'monthly' ? (amount * rate) / 12 : interest)}</div>
        <div class="stat-list" style="margin-top:12px">
          <span class="k">${years === 1 ? t('Interest over 1 year') : t('Interest over {n} years', { n: years })}</span><span class="v up">+${fmt.egp(interest)}</span>
          <span class="k">${t('You get back')}</span><span class="v">${fmt.egp(amount + interest)}</span>
          ${real != null && html`<span class="k">${t('A year after inflation ({infl}%)', { infl: fmt.num(m.inflation, 1) })}</span>
            <span class=${cls('v', tone(real))}>${fmt.pct(real, 1)}</span>`}
        </div>
        <p class="muted" style="font-size:13px;margin-top:12px">${t('To beat it, your trades need more than {rate}% a year after fees ({fee}% a side) and after the losing trades.', {
          rate: fmt.num(rate * 100, 2), fee })}</p>
        <p class="faint" style="font-size:12px;margin-top:10px">${t("The interest is fixed when you buy, isn't added to the amount (it's paid out), and the money is locked until the end: breaking a certificate early usually costs some of the interest. Your account against a bank deposit is on My Portfolio → Health.")}</p>
      </div>
    </div>`;
}
