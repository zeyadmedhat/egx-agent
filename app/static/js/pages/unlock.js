// The GitHub Pages site's front door: the group password, and a short notice the first time.
import { html, useState, remember } from '../lib.js';
import { Icon, Callout, Field } from '../ui.js';
import { t } from '../i18n.js';

const isIphone = /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;

export function UnlockScreen({ onDone, error: bootError }) {
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
    <div class="brand" style="padding:0;margin-bottom:18px"><div class="logo">EGX</div>
      <div><div class="brand-name">Trading Agent</div><div class="brand-sub">Private group · swing trades</div></div></div>
    <form class="stack" onSubmit=${submit}>
    <h2>${t('Enter the group password')}</h2>
    <p class="muted">The person who sent you this link also gave you a password.</p>
    <input type="text" autocomplete="username" value="egx-group" hidden readonly />
    <${Field} label="Password"><input class="input" type="password" autocomplete="current-password" autofocus
      value=${password} onInput=${e => setPassword(e.target.value)} required /><//>
    <label class="check"><input type="checkbox" checked=${keep} onChange=${e => setKeep(e.target.checked)} />
      Remember it on this device</label>
    ${first && html`<div class="terms">
      <p><b>Before you start.</b> This site shows rules-based buy and sell signals for EGX stocks, shared in a private
        group. It is not investment advice: you decide and place every order yourself, and you can lose money.</p>
      <p>Your portfolio and settings are saved <b>only in this browser, on this device</b>. Nobody else
        sees them, not even the person who runs the site. Download a backup from Settings now and then.</p>
      <label class="check"><input type="checkbox" checked=${agreed} onChange=${e => setAgreed(e.target.checked)} />
        I understand</label></div>`}
    ${isIphone && !standalone && html`<${Callout} tone="warn"><b>On iPhone:</b> first tap Share, then
      <b>Add to Home Screen</b>, and always open the site from that icon. Safari may delete a website's saved data if
      you don't open it for 7 days; the Home Screen app keeps it.<//>`}
    ${error && html`<${Callout} tone="bad">${error}<//>`}
    <button class="btn primary block" type="submit" disabled=${busy || !password || !agreed}>
      ${busy ? 'Checking…' : html`<${Icon} name="check" />Open`}</button>
  </form></div></div>`;
}
