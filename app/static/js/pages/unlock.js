// The GitHub Pages site's front door: the group password, and a short notice the first time. In English or Arabic.
import { html, useState, remember, useStore, setLang } from '../lib.js';
import { Icon, Callout, Field } from '../ui.js';
import { t } from '../i18n.js';

const isIphone = /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;

export function UnlockScreen({ onDone, error: bootError }) {
  const lang = useStore(s => s.lang);
  const [password, setPassword] = useState('');
  const [keep, setKeep] = useState(true);
  const [agreed, setAgreed] = useState(!!remember('accepted'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(bootError || '');
  const first = !remember('accepted');

  const submit = async e => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const site = await import('../local/site.js');
      await site.unlock(password, keep);
      remember('accepted', new Date().toISOString());
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return html`<div class="auth-wrap"><div class="auth-card card">
    <div class="row" style="justify-content:space-between;align-items:flex-start;margin-bottom:18px">
      <div class="brand" style="padding:0"><div class="logo">EGX</div>
        <div><div class="brand-name">Trading Agent</div><div class="brand-sub">${t('Private group · swing trades')}</div></div></div>
      <button class="btn ghost" type="button" lang=${lang === 'ar' ? 'en' : 'ar'}
        onClick=${() => setLang(lang === 'ar' ? 'en' : 'ar')}>${lang === 'ar' ? 'English' : 'العربية'}</button>
    </div>
    <form class="stack" onSubmit=${submit}>
    <h2>${t('Enter the group password')}</h2>
    <p class="muted">${t('The person who sent you this link also gave you a password.')}</p>
    <input type="text" autocomplete="username" value="egx-group" hidden readonly />
    <${Field} label=${t('Password')}><input class="input" type="password" autocomplete="current-password" autofocus
      value=${password} onInput=${e => setPassword(e.target.value)} required /><//>
    <label class="check"><input type="checkbox" checked=${keep} onChange=${e => setKeep(e.target.checked)} />
      ${t('Remember it on this device')}</label>
    ${first && html`<div class="terms">
      <p><b>${t('Before you start.')}</b> ${t('This site shows rules-based buy and sell signals for EGX stocks, shared in a '
        + 'private group. It is not investment advice: you decide and place every order yourself, and you can lose money.')}</p>
      <p>${t('Your portfolio and settings are saved only in this browser, on this device. Nobody else sees them, not even '
        + 'the person who runs the site. Download a backup from Settings now and then.')}</p>
      <label class="check"><input type="checkbox" checked=${agreed} onChange=${e => setAgreed(e.target.checked)} />
        ${t('I understand')}</label></div>`}
    ${isIphone && !standalone && html`<${Callout} tone="warn">${t('On iPhone: first tap Share, then Add to Home Screen, and '
      + "always open the site from that icon. Safari may delete a website's saved data if you don't open it for 7 days; "
      + 'the Home Screen app keeps it.')}<//>`}
    ${error && html`<${Callout} tone="bad">${t(error)}<//>`}
    <button class="btn primary block" type="submit" disabled=${busy || !password || !agreed}>
      ${busy ? t('Checking…') : html`<${Icon} name="check" />${t('Open')}`}</button>
  </form></div></div>`;
}
