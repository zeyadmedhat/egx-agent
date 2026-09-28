// Admin (the website only): invite friends, look after their accounts, and download a backup.
import { html, useApi, useState, api, toast, refreshAll, fmt, copyText } from '../lib.js';
import { Icon, Callout, PageHead, SectionHead, Disclaimer, PageLoading, DataTable, Confirm, Field, Empty } from '../ui.js';

function LinkBox({ link, text }) {
  const copy = () => (copyText(link) ? toast('Link copied. Send it privately.') : toast('Select the link and copy it.', 'error'));
  return html`<div class="link-box">
    <div class="muted" style="font-size:12.5px">${text}</div>
    <div class="row" style="gap:8px"><input class="input mono" readonly value=${link} onFocus=${e => e.target.select()} />
      <button class="btn sm primary" onClick=${copy}><${Icon} name="copy" />Copy</button></div>
  </div>`;
}

export function AdminPage() {
  const { data, error } = useApi('/admin');
  const [note, setNote] = useState('');
  const [link, setLink] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);
  if (!data) return html`<${PageLoading} error=${error} />`;

  const run = async (call, after) => {
    setBusy(true);
    try {
      const r = await call();
      if (r && r.message) toast(r.message, 'ok', 8000);
      if (after) after(r);
      refreshAll();
    } catch (err) {
      toast(err.message, 'error', 10000);
    } finally {
      setBusy(false);
    }
  };
  const invite = e => {
    e.preventDefault();
    run(() => api('/admin/invites', { method: 'POST', body: { note } }), r => {
      setLink({ link: r.link, text: `Invite${note ? ` for ${note}` : ''}. It works once, within ${r.days} days.` });
      setNote('');
    });
  };
  const people = data.people.filter(p => p.claimed);
  const columns = [
    { key: 'display_name', label: 'Name', render: p => html`<b>${p.display_name}</b>${p.is_admin
      ? html` <span class="tag">admin</span>` : ''}<div class="faint" style="font-size:12px">${p.username}</div>` },
    { key: 'last_seen', label: 'Last seen', fmt: v => (v ? fmt.datetime(v) : html`<span class="faint">never</span>`) },
    { key: 'created', label: 'Joined', fmt: v => fmt.date(v) },
    { key: 'disabled', label: 'Status', render: p => (p.disabled
      ? html`<span class="chip exit">switched off</span>` : html`<span class="chip hold">active</span>`) },
    { key: 'actions', label: '', sortable: false, align: 'r', render: p => (p.is_admin ? null : html`<div class="row"
      style="gap:6px;justify-content:flex-end">
      <button class="btn sm" disabled=${busy} onClick=${() => run(() => api(`/admin/users/${p.id}/reset`, { method: 'POST' }),
        r => setLink({ link: r.link, text: r.message }))}><${Icon} name="refresh" />Reset link</button>
      <button class="btn sm ghost" disabled=${busy} onClick=${() => setConfirm(p)}>${p.disabled ? 'Switch on' : 'Switch off'}</button>
    </div>`) },
  ];
  return html`
    <${PageHead} title="Admin" sub="Invite friends, look after their accounts and keep a backup. You never see their portfolios." />

    <div class="grid grid-2" style="align-items:start">
      <div class="card">
        <div class="card-title" style="font-size:14px;color:var(--text)"><${Icon} name="plus" size=${16} />Invite a friend</div>
        <p class="muted" style="font-size:13px;margin-bottom:12px">Create a link and send it to them privately (WhatsApp,
          Telegram…). They choose their own username and password. Each link works once, within 7 days.</p>
        <form class="row" style="gap:8px;align-items:flex-end" onSubmit=${invite}>
          <${Field} label="Who is it for? (optional, only you see this)" className="grow">
            <input class="input" value=${note} maxlength="60" placeholder="e.g. Sara" onInput=${e => setNote(e.target.value)} /><//>
          <button class="btn primary" type="submit" disabled=${busy}>Create invite link</button>
        </form>
        ${link && html`<div style="margin-top:14px"><${LinkBox} link=${link.link} text=${link.text} /></div>`}
      </div>
      <div class="card">
        <div class="card-title" style="font-size:14px;color:var(--text)"><${Icon} name="download" size=${16} />Backup</div>
        <p class="muted" style="font-size:13px;margin-bottom:12px">The server keeps a copy of everything every night for 14
          days. Download one to your Mac now and then as well: it has every portfolio and all the prices.</p>
        <a class="btn" href="/api/admin/backup" download><${Icon} name="download" />Download a backup</a>
        <p class="faint" style="font-size:12px;margin-top:12px">Scans, the Kashif data, the strategy and the Telegram bot
          are in <a href="#/settings">Settings</a>. The prediction model is on <a href="#/predict">Predict</a>.</p>
      </div>
    </div>

    ${data.invites.length > 0 && html`<section class="section">
      <${SectionHead} title="Links not used yet" count=${data.invites.length} />
      <div class="card flush"><${DataTable} rowKey=${i => i.id} rows=${data.invites} columns=${[
        { key: 'kind', label: 'Link', render: i => (i.kind === 'reset' ? 'Password reset' : 'Invite') },
        { key: 'note', label: 'For', render: i => i.note || html`<span class="faint">–</span>` },
        { key: 'expires', label: 'Expires', fmt: v => fmt.datetime(v) },
        { key: 'x', label: '', sortable: false, align: 'r', render: i => html`<button class="btn sm ghost" disabled=${busy}
          onClick=${() => run(() => api(`/admin/invites/${i.id}`, { method: 'DELETE' }))}>Cancel</button>` },
      ]} /></div>
    </section>`}

    <section class="section">
      <${SectionHead} title="People" count=${people.length}
        hint="A reset link lets someone choose a new password. Switching someone off signs them out and stops their alerts." />
      <div class="card flush">${people.length
        ? html`<${DataTable} columns=${columns} rows=${people} rowKey=${p => p.id} />`
        : html`<${Empty} icon="info" title="Nobody yet" text="Create an invite link above." />`}</div>
    </section>
    <div style="margin-top:18px"><${Callout} tone="warn"><b>Keep the group small and private.</b> Sharing buy and sell
      signals publicly can need a licence from Egypt's Financial Regulatory Authority, and the free price source isn't
      meant for public websites. Invite people you know.<//></div>
    ${confirm && html`<${Confirm} title=${confirm.disabled ? `Switch ${confirm.display_name} back on?` : `Switch ${confirm.display_name} off?`}
      confirmLabel=${confirm.disabled ? 'Switch on' : 'Switch off'} danger=${!confirm.disabled}
      text=${confirm.disabled ? 'They can log in again with their password.'
        : "They're signed out and can't log in. Their data is kept, and you can switch them back on any time."}
      onConfirm=${() => run(() => api(`/admin/users/${confirm.id}/disable`, { method: 'POST', body: { disabled: !confirm.disabled } }))}
      onClose=${() => setConfirm(null)} />`}
    <${Disclaimer} />`;
}
