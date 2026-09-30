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
const STOCK_RE = /^(?:\/(?:stock|s)(?:@\w+)?\s+)?([A-Za-z0-9]{2,12})\s*$/i
const TOP_RE = /^\/top(?:@\w+)?(?:\s+(10|20))?\s*$/i
const BUYS_RE = /^\/(?:buys|signals)(?:@\w+)?\s*$/i
const MAX_ALERTS = 20
const WELCOME = "✅ <b>Connected.</b> After each EGX close you'll get the day's signals here. Your share counts are on " +
  "the website.\nSend /help for alerts on the stocks you follow, or /stop to stop."
const STOPPED = "Stopped. To start again, open the website → Settings → Connect Telegram."
const HELP = "<b>Alerts for the stocks you follow</b>, checked after each close:\n" +
  "/watch COMI: when COMI gets a BUY signal\n" +
  "/watch COMI 45: when COMI closes above 45 (or below, if 45 is under today's price)\n" +
  "/watch COMI levels: when COMI closes near a strong support (a place to buy) or reaches resistance " +
  "(a place to take profit)\n" +
  "/unwatch COMI: stop COMI's alerts (/unwatch all: every alert)\n" +
  "/list: your alerts\n" +
  "/weekly off: no Thursday summary (/weekly on to have it again)\n" +
  "/stop: stop all messages\n\n" +
  "<b>Ask about the website's data</b>, any time:\n" +
  "/stock COMI (or just COMI): price, today's signal, chances, support and resistance\n" +
  "/top: the 10 best chances to reach the target in 10 days (/top 20: in 20 days)\n" +
  "/buys: today's BUY signals"

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const px = v => v.toLocaleString("en-US", { minimumFractionDigits: Math.abs(v) < 10 ? 3 : 2,
                                             maximumFractionDigits: Math.abs(v) < 10 ? 3 : 2 })

async function sha(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("")
}

const pct = (v, sign = false) => (sign && v > 0 ? "+" : "") + (v * 100).toFixed(1) + "%"
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const day = d => d ? `${+d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]}` : "–"
const noData = "The website's data hasn't reached me yet. Try again after its next run."

function stockCard(info, sym) {
  const s = info.stocks[sym]
  const lines = [`<b>${esc(sym)}</b> ${esc(s.n)}`,
    `Close ${px(s.c)}${s.ch != null ? ` (${pct(s.ch, true)})` : ""} on ${day(s.d)}`]
  if (s.a === "BUY") lines.push(`🟢 <b>BUY</b> up to ${px(s.e)} · stop ${px(s.s)} · target ${px(s.t)}`)
  else if (s.a) lines.push(`Signal: ${esc(s.a)}${s.e ? ` (entry up to ${px(s.e)} · stop ${px(s.s)} · target ${px(s.t)})` : ""}`)
  else lines.push("No signal today.")
  const ch = [10, 20].filter(hz => s["p" + hz] != null).map(hz =>
    `${pct(s["p" + hz])} in ${hz} days (rank ${s["r" + hz]}${s["x" + hz] != null ? `, expected ${pct(s["x" + hz], true)}` : ""})`)
  if (ch.length) lines.push("Chance to reach the target: " + ch.join(" · "))
  if (s.cs != null) lines.push(`Chart: support ${s.sup != null ? px(s.sup) : "–"} · resistance ${s.res != null ? px(s.res) : "–"}` +
    ` · stop ${px(s.cs)} · target ${px(s.ct)}`)
  lines.push(`/watch ${esc(sym)} levels: an alert when it nears support or resistance`)
  return lines.join("\n")
}

function top(info, hz) {
  const rows = Object.entries(info.stocks).filter(([, s]) => s["r" + hz] != null)
    .sort((a, b) => a[1]["r" + hz] - b[1]["r" + hz]).slice(0, 10)
  if (!rows.length) return "No predictions yet."
  return `<b>Best chances to reach the target in ${hz} days</b> (${day(info.pred)})\n` + rows.map(([sym, s], i) =>
    `${i + 1}. <b>${esc(sym)}</b> ${pct(s["p" + hz])}` + (s["x" + hz] != null ? ` · expected ${pct(s["x" + hz], true)}` : "") +
    ` · ${px(s.c)}`).join("\n") + "\n\nNot advice: chances from the website's model. /stock SYMBOL for more."
}

function buys(info) {
  const rows = Object.entries(info.stocks).filter(([, s]) => s.a === "BUY")
  if (!rows.length) return `No BUY signals at the ${day(info.scan)} close.`
  return `<b>BUY signals at the ${day(info.scan)} close</b>\n` + rows.map(([sym, s]) =>
    `🟢 <b>${esc(sym)}</b> up to ${px(s.e)} · stop ${px(s.s)} · target ${px(s.t)}`).join("\n") +
    "\n\nYour share counts are on the website."
}

function ask(state, text) {
  const info = state.info
  let m = TOP_RE.exec(text)
  if (m) return info ? top(info, +(m[1] || 10)) : noData
  if (BUYS_RE.test(text)) return info ? buys(info) : noData
  m = STOCK_RE.exec(text)
  if (!m || /^\/(help|start)/i.test(text)) return undefined
  if (!info) return text.startsWith("/") ? noData : undefined
  const sym = m[1].toUpperCase()
  if (info.stocks[sym]) return stockCard(info, sym)
  return text.startsWith("/") ? `I don't know ${esc(sym)}. Use the stock's EGX symbol, like COMI.` : undefined
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
    const sym = m[1].toUpperCase(), n = mine.filter(a => sym === "ALL" || a.symbol === sym).length
    state.alerts[cid] = mine.filter(a => sym !== "ALL" && a.symbol !== sym)
    if (sym === "ALL") return n ? `Removed all your alerts (${n}).` : "You have no alerts."
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
  const cid = String(chat.id)
  let text = (msg.text || "").trim(), subbed = cid in state.subs
  const m = START_RE.exec(text)
  if (m) {
    if (subbed || (await sha(m[1])).slice(0, 16) !== state.fp) return null
    state.subs[cid] = { weekly: true }
    return WELCOME
  }
  if (!subbed) return null
  // A command tapped in the menu comes without its symbol: ask for it, and treat the next message as its rest.
  // The message is rewritten in place (to "/watch COMI"), so the website's run reads the whole command.
  const pending = (state.pending ||= {})
  if (!text.startsWith("/") && pending[cid]) {
    text = msg.text = `/${pending[cid]} ${text}`
  }
  delete pending[cid]
  const bare = /^\/(stock|s|watch|unwatch)(?:@\w+)?$/i.exec(text)
  if (bare) {
    pending[cid] = bare[1].toLowerCase()
    return pending[cid] === "watch" ? "Which stock? Send its symbol (COMI), or with a price (COMI 45), or COMI levels."
      : pending[cid] === "unwatch" ? "Which stock? Send its symbol, or all." : "Which stock? Send its symbol, like COMI."
  }
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
  const answer = ask(state, text)
  if (answer !== undefined) return answer
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
    if (!env.SYNC_KEY || !env.BOT_TOKEN) return new Response("Not set up yet", { status: 503 })
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
