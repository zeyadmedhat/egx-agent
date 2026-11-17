// Data health (⚙ menu, and the link under Home's warnings): every source the daily run reads, a green or red dot,
// when it last worked and what it feeds (views.data_health). One source down never stops the others.
import { html, useApi, fmt, cls } from '../lib.js';
import { PageHead, PageLoading, Callout } from '../ui.js';
import { t } from '../i18n.js';

const when = iso => (iso ? `${fmt.date(iso.slice(0, 10), false)} ${iso.slice(11, 16)}` : null);

export function HealthPage() {
  const { data, error } = useApi('/sources');
  if (!data) return html`<${PageHead} title="Data health" /><${PageLoading} error=${error} />`;
  const rows = data.sources || [];
  const bad = rows.filter(r => !r.ok).length;
  const late = data.behind >= 2;
  return html`
    <${PageHead} title="Data health" sub=${data.checked && t('Last run: {when}', { when: when(data.checked) })} />
    <${Callout} tone=${bad || late ? 'warn' : ''}>${bad
      ? t(bad === 1 ? '1 source is not working. The rest of the site carries on with what it had.'
        : '{n} sources are not working. The rest of the site carries on with what it had.', { n: bad })
      : t('Every source worked on the last run.')}<//>
    <div class="card" style="margin-top:12px">
      <div class="health-row">
        <span class=${cls('health-dot', late ? 'bad' : 'ok')}></span>
        <div><b>${t('Closing prices')}</b>
          <div class="faint">${data.last_close ? t('Last close: {date}', { date: fmt.date(data.last_close, false) }) : '–'}
            ${late ? ' · ' + t('{n} sessions behind', { n: data.behind }) : ''}</div></div>
      </div>
      ${data.model_days != null && html`<div class="health-row">
        <span class=${cls('health-dot', data.model_days > data.model_every + 10 ? 'bad' : 'ok')}></span>
        <div><b>${t('Prediction model')}</b>
          <div class="faint">${t('Trained {n} days ago. It retrains every {m} days.', { n: data.model_days, m: data.model_every })}</div></div>
      </div>`}
      ${rows.map(r => html`<div class="health-row" key=${r.name}>
        <span class=${cls('health-dot', r.ok ? 'ok' : r.alarm ? 'bad' : 'warn')}></span>
        <div><b dir="auto">${r.name}</b>
          <div class="faint">${t('Feeds: {what}', { what: t(r.feeds) })}</div>
          <div class=${r.ok ? 'faint' : r.alarm ? 'down' : 'warn-text'}>${r.ok
            ? t('Worked {when}', { when: when(r.last_ok) })
            : t(r.alarm ? 'Not working since {when}' : 'Failed since {when}. One bad day is normal.', { when: when(r.failing_since) })}</div></div>
      </div>`)}
    </div>
    <p class="faint" style="font-size:13px;margin-top:10px">${t('Green: worked on the last try. Orange: failing for less than a day. Red: failing for a day or more; you get a Telegram alarm.')}</p>`;
}
