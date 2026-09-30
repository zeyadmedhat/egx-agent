// The website's Telegram bot, answering at once (a Cloudflare Worker). Telegram hands every message here the moment
// it's sent and the reply goes straight back. The website's run (app/site_daily.py) stays in charge: it picks up the
// messages from here (GET /updates), applies them to its data, and sends back who's connected and their alerts
// (POST /state). Secrets (set with wrangler): BOT_TOKEN (from @BotFather) and SYNC_KEY (= the WORKER_KEY GitHub secret).
// Keep the replies in step with app/alerts.py.

const WATCH_RE = /^\/watch(?:@\w+)?\s+([A-Za-z0-9]{2,12})(?:\s+([0-9]+(?:[.,][0-9]+)?|levels))?\s*$/i
const UNWATCH_RE = /^\/unwatch(?:@\w+)?\s+([A-Za-z0-9]{2,12})\s*$/i
const LIST_RE = /^\/(?:list|alerts)(?:@\w+)?\s*$/i
const WEEKLY_RE = /^\/weekly(?:@\w+)?\s+(on|off)\s*$/i
const START_RE = /^\/start\s+([A-Za-z0-9_-]{8,64})\s*$/
const STOP_RE = /^\/stop(@\w+)?\s*$/
const MAX_ALERTS = 20
const WELCOME = "✅ <b>Connected.</b> After each EGX close you'll get the day's signals here. Your share counts are on " +
  "the website.\nSend /help for alerts on the stocks you follow, or /stop to stop."
const STOPPED = "Stopped. To start again, open the website → Settings → Connect Telegram."
const HELP = "<b>Alerts for the stocks you follow</b>, checked after each close:\n" +
  "/watch COMI: when COMI gets a BUY signal\n" +
  "/watch COMI 45: when COMI closes above 45 (or below, if 45 is under today's price)\n" +
  "/watch COMI levels: when COMI closes near a strong support (a place to buy) or reaches resistance " +
  "(a place to take profit)\n" +
  "/unwatch COMI: stop COMI's alerts\n" +
  "/list: your alerts\n" +
  "/weekly off: no Thursday summary (/weekly on to have it again)\n" +
  "/stop: stop all messages"

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const px = v => v.toLocaleString("en-US", { minimumFractionDigits: Math.abs(v) < 10 ? 3 : 2,
                                             maximumFractionDigits: Math.abs(v) < 10 ? 3 : 2 })

async function sha(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("")
}

function alertText(a) {
  if (a.kind === "buy") return `${a.symbol}: a BUY signal`
  if (a.kind === "levels") return `${a.symbol}: near support or resistance`
  return `${a.symbol}: a close ${a.kind} ${px(a.price)}`
}

function watch(state, cid, text) {
  const mine = state.alerts[cid] || []
  if (LIST_RE.test(text)) {
    if (!mine.length) return "You have no alerts yet.\n\n" + HELP
    return "<b>Your alerts</b>\n" + [...mine].sort((a, b) => (a.symbol + a.kind).localeCompare(b.symbol + b.kind))
      .map(a => esc(alertText(a))).join("\n")
  }
  let m = UNWATCH_RE.exec(text)
  if (m) {
    const sym = m[1].toUpperCase(), n = mine.filter(a => a.symbol === sym).length
    state.alerts[cid] = mine.filter(a => a.symbol !== sym)
    return n ? `Removed ${n} alert${n !== 1 ? "s" : ""} for ${esc(sym)}.` : `You have no alert for ${esc(sym)}.`
  }
  m = WATCH_RE.exec(text)
  if (!m) return HELP
  const sym = m[1].toUpperCase()
  if (!(sym in state.stocks)) return `I don't know ${esc(sym)}. Use the stock's EGX symbol, like COMI.`
  if (mine.length >= MAX_ALERTS) return `You already have ${MAX_ALERTS} alerts. Remove some with /unwatch first.`
  const last = state.stocks[sym]
  let kind, price = null, reply
  if (m[2] === undefined) {
    kind = "buy"
    reply = `OK: I'll tell you when ${sym} gets a BUY signal, after any close.`
  } else if (m[2].toLowerCase() === "levels") {
    kind = "levels"
    reply = `OK: I'll tell you when ${sym} closes near a strong support or reaches resistance ` +
      "(the levels on its page on the website)."
  } else {
    price = parseFloat(m[2].replace(",", "."))
    if (last == null) return `There are no prices for ${esc(sym)} yet, so I can't watch its price.`
    kind = price > last ? "above" : "below"
    reply = `OK: I'll tell you when ${sym} closes ${kind} ${px(price)} (last close ${px(last)}).`
  }
  state.alerts[cid] = mine.filter(a => !(a.symbol === sym && a.kind === kind)).concat({ symbol: sym, kind, price })
  return reply
}

// One message: changes `state` the way the website's run will, and gives the reply (or null).
export async function handle(state, update) {
  const msg = update.message || {}, chat = msg.chat || {}
  if (chat.type !== "private") return null
  const cid = String(chat.id), text = (msg.text || "").trim(), subbed = cid in state.subs
  const m = START_RE.exec(text)
  if (m) {
    if (subbed || (await sha(m[1])).slice(0, 16) !== state.fp) return null
    state.subs[cid] = { weekly: true }
    return WELCOME
  }
  if (!subbed) return null
  if (STOP_RE.test(text)) {
    delete state.subs[cid]
    delete state.alerts[cid]
    return STOPPED
  }
  const w = WEEKLY_RE.exec(text)
  if (w) {
    state.subs[cid].weekly = w[1].toLowerCase() !== "off"
    return state.subs[cid].weekly ? "OK: you'll get the week's summary after Thursday's close."
      : "OK: no weekly summary. Send /weekly on to have it again."
  }
  return text.startsWith("/") ? watch(state, cid, text) : null
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

async function telegram(env, method, params) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) })
  return r.json()
}

// One Durable Object holds the data, so messages are handled one at a time, in order.
export class Bot {
  constructor(ctx, env) { this.ctx = ctx; this.env = env }

  async fetch(req) {
    const url = new URL(req.url), store = this.ctx.storage, env = this.env
    const hook = (await sha("hook:" + env.SYNC_KEY)).slice(0, 32)
    if (url.pathname === "/telegram") {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== hook) return new Response("", { status: 403 })
      const update = await req.json(), base = await store.get("state"), log = (await store.get("log")) || []
      if (!base || update.update_id <= base.seen || log.some(u => u.update_id === update.update_id)) return json({})
      const state = structuredClone(base)
      for (const u of log) await handle(state, u)          // what's happened since the website's last run
      const reply = await handle(state, update)
      await store.put("log", log.concat(update))
      if (reply) await telegram(env, "sendMessage", { chat_id: update.message.chat.id, text: reply,
                                                      parse_mode: "HTML", disable_web_page_preview: true })
        .catch(() => null)                                   // only a courtesy: the run still applies the command
      return json({})
    }
    if (req.headers.get("Authorization") !== `Bearer ${env.SYNC_KEY}`) return new Response("", { status: 403 })
    if (url.pathname === "/updates") return json({ updates: (await store.get("log")) || [] })
    if (url.pathname === "/state" && req.method === "POST") {
      const state = await req.json()
      await store.put("state", state)
      await store.put("log", ((await store.get("log")) || []).filter(u => u.update_id > state.seen))
      const want = `${url.origin}/telegram`, info = await telegram(env, "getWebhookInfo", {})
      if (info.result?.url !== want) {
        const set = await telegram(env, "setWebhook", { url: want, secret_token: hook, allowed_updates: ["message"] })
        if (!set.ok) return json({ ok: false, error: set.description || "setWebhook failed" }, 502)
      }
      return json({ ok: true })
    }
    return new Response("", { status: 404 })
  }
}

export default {
  fetch(req, env) {
    return env.BOT.get(env.BOT.idFromName("bot")).fetch(req)
  },
}
