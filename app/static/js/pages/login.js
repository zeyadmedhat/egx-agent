// Signing in to the website: log in, join through an invite link, set a new password, and the first-login notice.
import { html, useState, useEffect, api, useRoute, useStore } from '../lib.js';
import { Icon, Callout, Field } from '../ui.js';
import { t } from '../i18n.js';

export function AuthScreen({ onDone }) {
  const route = useRoute();
  const auth = useStore(s => s.auth);
  let body;
  if (route.page === 'join') body = html`<${Join} code=${route.query.code} onDone=${onDone} />`;
  else if (route.page === 'reset') body = html`<${Reset} code=${route.query.code} onDone=${onDone} />`;
  else if (auth === 'terms') body = html`<${Terms} onDone=${onDone} />`;
  else body = html`<${Login} onDone=${onDone} />`;
  return html`<div class="auth-wrap"><div class="auth-card card">
    <div class="brand" style="padding:0;margin-bottom:18px"><div class="logo">EGX</div>
      <div><div class="brand-name">Trading Agent</div><div class="brand-sub">Private group · swing trades</div></div></div>
    ${body}
  </div></div>`;
}

function useSubmit(fn) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async e => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try { await fn(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return { busy, error, submit };
}

function Login({ onDone }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, submit } = useSubmit(async () => {
    await api('/auth/login', { method: 'POST', body: { username, password } });
    await onDone();
  });
  return html`<form class="stack" onSubmit=${submit}>
    <h2>${t('Log in')}</h2>
    <${Field} label="Username"><input class="input" autocomplete="username" autocapitalize="none" spellcheck=${false}
      value=${username} onInput=${e => setUsername(e.target.value)} required /><//>
    <${Field} label="Password"><input class="input" type="password" autocomplete="current-password"
      value=${password} onInput=${e => setPassword(e.target.value)} required /><//>
    ${error && html`<${Callout} tone="bad">${error}<//>`}
    <button class="btn primary block" type="submit" disabled=${busy}>${busy ? 'Checking…' : 'Log in'}</button>
    <p class="faint" style="font-size:12.5px">No account? This site is invite-only: ask the person who runs it for an
      invite link. Forgot your password? Ask them for a reset link.</p>
  </form>`;
}

function PasswordFields({ password, setPassword, confirm, setConfirm }) {
  return html`
    <${Field} label="Password" help="At least 10 characters. A short sentence is easy to remember and hard to guess.">
      <input class="input" type="password" autocomplete="new-password" value=${password}
        onInput=${e => setPassword(e.target.value)} required minlength="10" /><//>
    <${Field} label="Type it again"><input class="input" type="password" autocomplete="new-password" value=${confirm}
      onInput=${e => setConfirm(e.target.value)} required /><//>`;
}

function useInvite(code) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    if (!code) { setState({ error: 'This link is incomplete. Open the whole link you were sent.' }); return; }
    api(`/auth/invite?code=${encodeURIComponent(code)}`)
      .then(info => setState({ info }))
      .catch(err => setState({ error: err.message }));
  }, [code]);
  return state;
}

function Join({ code, onDone }) {
  const { info, error: linkError, loading } = useInvite(code);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const { busy, error, submit } = useSubmit(async () => {
    if (password !== confirm) throw new Error("The two passwords don't match.");
    await api('/auth/join', { method: 'POST', body: { code, username, display_name: name, password } });
    await onDone();
  });
  if (loading) return html`<div class="skeleton" style="height:180px"></div>`;
  if (linkError || !info || info.kind !== 'invite') {
    return html`<${Callout} tone="bad">${linkError || 'This is not an invite link.'}<//>
      <a class="btn block" style="margin-top:14px" href="#/">${t('Go to log in')}</a>`;
  }
  return html`<form class="stack" onSubmit=${submit}>
    <h2>${info.claim ? 'Set up your admin account' : "You're invited"}</h2>
    <p class="muted" style="font-size:13px">${info.claim
      ? 'Choose the username and password you will log in with. Your portfolio is already here.'
      : 'Choose a username and password. Your portfolio, paper account and settings are private to you.'}</p>
    <${Field} label="Your name" help="How the site greets you. Optional."><input class="input" autocomplete="name"
      value=${name} onInput=${e => setName(e.target.value)} maxlength="40" /><//>
    <${Field} label="Username" help="3–30 letters or numbers (dots, dashes and underscores are fine).">
      <input class="input" autocomplete="username" autocapitalize="none" spellcheck=${false} value=${username}
        onInput=${e => setUsername(e.target.value.toLowerCase())} required /><//>
    <${PasswordFields} password=${password} setPassword=${setPassword} confirm=${confirm} setConfirm=${setConfirm} />
    ${error && html`<${Callout} tone="bad">${error}<//>`}
    <button class="btn primary block" type="submit" disabled=${busy}>${busy ? 'Creating…' : 'Create my account'}</button>
  </form>`;
}

function Reset({ code, onDone }) {
  const { info, error: linkError, loading } = useInvite(code);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const { busy, error, submit } = useSubmit(async () => {
    if (password !== confirm) throw new Error("The two passwords don't match.");
    await api('/auth/reset', { method: 'POST', body: { code, password } });
    await onDone();
  });
  if (loading) return html`<div class="skeleton" style="height:160px"></div>`;
  if (linkError || !info || info.kind !== 'reset') {
    return html`<${Callout} tone="bad">${linkError || 'This is not a password reset link.'}<//>
      <a class="btn block" style="margin-top:14px" href="#/">${t('Go to log in')}</a>`;
  }
  return html`<form class="stack" onSubmit=${submit}>
    <h2>${t('Choose a new password')}</h2>
    <p class="muted" style="font-size:13px">For <b>${info.username}</b>. You'll be signed out on your other devices.</p>
    <input type="text" autocomplete="username" value=${info.username || ''} hidden readonly />
    <${PasswordFields} password=${password} setPassword=${setPassword} confirm=${confirm} setConfirm=${setConfirm} />
    ${error && html`<${Callout} tone="bad">${error}<//>`}
    <button class="btn primary block" type="submit" disabled=${busy}>${busy ? 'Saving…' : 'Save and log in'}</button>
  </form>`;
}

function Terms({ onDone }) {
  const [ok, setOk] = useState(false);
  const { busy, error, submit } = useSubmit(async () => {
    await api('/auth/accept-terms', { method: 'POST' });
    await onDone();
  });
  return html`<form class="stack" onSubmit=${submit}>
    <h2>${t('Before you start')}</h2>
    <ul class="reasons">
      <li><b>A private group.</b> This site is for invited friends only. Please don't share your login or the signals.</li>
      <li><b>Not investment advice.</b> The signals come from fixed rules and a statistical model. You decide and place
        every order yourself, with your own broker, at your own risk. Past results don't promise future returns.</li>
      <li><b>Your data.</b> Your portfolio and settings are only shown to you. The person who runs the site looks after
        the server, so they could see the data files; use it only if you're comfortable with that.</li>
      <li><b>Free and best-effort.</b> Prices come from free sources and can be late or wrong. Always check the price at
        your broker.</li>
    </ul>
    <label class="check"><input type="checkbox" checked=${ok} onChange=${e => setOk(e.target.checked)} />I understand and agree</label>
    ${error && html`<${Callout} tone="bad">${error}<//>`}
    <button class="btn primary block" type="submit" disabled=${!ok || busy}><${Icon} name="check" />${t('Continue')}</button>
  </form>`;
}
