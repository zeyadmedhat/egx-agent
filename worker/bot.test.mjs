// node worker/bot.test.mjs: the Worker's replies match the website's (app/alerts.py).
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { handle } from "./bot.js"

const fp = createHash("sha256").update("secretcode1").digest("hex").slice(0, 16)
const state = { fp, seen: 0, stocks: { COMI: 80.5, NEWS: null }, subs: {}, alerts: {} }
const say = (text, id = 7, type = "private") => handle(state, { update_id: 1, message: { chat: { id, type }, text } })

assert.equal(await say("/watch COMI"), null)                                   // not connected: no reply
assert.equal(await say("/start wrongcode99"), null)
assert.match(await say("/start secretcode1"), /Connected/)
assert.equal(await say("/start secretcode1"), null)                          // already in
assert.match(await say("/watch comi"), /BUY signal/)
assert.match(await say("/watch COMI 90"), /closes above 90.00 \(last close 80.50\)/)
assert.match(await say("/watch COMI levels"), /support/)
assert.match(await say("/watch NEWS 5"), /no prices/)
assert.match(await say("/watch XXXX"), /don't know XXXX/)
assert.match(await say("/list"), /COMI: a close above 90.00\nCOMI: a BUY signal\nCOMI: near support/)
assert.match(await say("/unwatch COMI"), /Removed 3 alerts/)
assert.match(await say("/weekly off"), /no weekly summary/)
assert.equal(state.subs["7"].weekly, false)
assert.match(await say("/help"), /\/watch COMI/)
assert.equal(await say("hello"), null)
assert.equal(await say("/list", 8, "group"), null)
assert.match(await say("/stop"), /Stopped/)
assert.deepEqual(state.subs, {})
console.log("worker ok")

// Asking about the website's data
const st = { fp, seen: 0, stocks: { COMI: 128 }, subs: { 9: { weekly: true } }, alerts: { 9: [{ symbol: "COMI", kind: "buy" }] } }
const ask = text => handle(st, { update_id: 2, message: { chat: { id: 9, type: "private" }, text } })
assert.match(await ask("/top"), /hasn't reached me/)
st.info = { scan: "2026-09-29", pred: "2026-09-29", stocks: {
  COMI: { n: "CIB", c: 128.01, d: "2026-09-29", ch: -0.0038, p10: 0.134, r10: 2, p20: 0.25, r20: 1, x20: 0.021,
          cs: 115.8, ct: 151.56, sup: 127.11, res: 129.73 },
  ABUK: { n: "Abu Qir", c: 50, d: "2026-09-29", ch: 0.01, a: "BUY", e: 50.5, s: 47, t: 56, p10: 0.4, r10: 1 } } }
assert.match(await ask("comi"), /<b>COMI<\/b> CIB\nClose 128.01 \(-0.4%\) on 29 Sep\nNo signal today.\nChance to reach the target: 13.4% in 10 days \(rank 2\) · 25.0% in 20 days \(rank 1, expected \+2.1%\)\nChart: support 127.11 · resistance 129.73/)
assert.match(await ask("/stock abuk"), /BUY<\/b> up to 50.50 · stop 47.00 · target 56.00/)
assert.match(await ask("/s XXXX"), /don't know XXXX/)
assert.equal(await ask("hello there"), null)
assert.match(await ask("/top"), /1\. <b>ABUK<\/b> 40.0%.*\n2\. <b>COMI<\/b>/)
assert.match(await ask("/top 20"), /in 20 days.*\n1\. <b>COMI<\/b> 25.0% · expected \+2.1%/)
assert.match(await ask("/buys"), /ABUK<\/b> up to 50.50/)
assert.match(await ask("/help"), /\/top/)
assert.match(await ask("/unwatch all"), /Removed all your alerts \(1\)/)
assert.deepEqual(st.alerts[9], [])
console.log("asking ok")

// A command from the menu, then its symbol
st.stocks.ABUK = 50
const u = text => ({ update_id: 3, message: { chat: { id: 9, type: "private" }, text } })
assert.match(await handle(st, u("/watch")), /Which stock\?/)
const next = u("abuk levels")
assert.match(await handle(st, next), /ABUK closes near a strong support/)
assert.equal(next.message.text, "/watch abuk levels")          // what the website's run will read
assert.match(await handle(st, u("/stock")), /Which stock\?/)
assert.match(await handle(st, u("/list")), /ABUK: near support/)   // another command: the question is dropped
assert.equal(await handle(st, u("hello")), null)
assert.match(await handle(st, u("/unwatch")), /or all/)
assert.match(await handle(st, u("all")), /Removed all your alerts \(1\)/)
console.log("menu ok")

// Your own portfolio
import { portfolioText, watchlistText } from "./bot.js"
const book = { date: "2026-09-28", start: 100000, cash: 20000, closed: { count: 2, win_rate: 0.5, total: 1500 },
  watchlist: ["COMI", "ZZZZ"],
  positions: [{ symbol: "COMI", shares: 100, avg: 120, last: 127, stop: 115.8, target: 151.56, status: "HOLD", reason: "" },
              { symbol: "ABUK", shares: 10, avg: 55, last: 51, stop: 51, target: 60, status: "EXIT", reason: "Closed under the stop" }] }
const pt = portfolioText({ ...book, sent: "2026-09-29" }, st.info)
assert.match(pt, /Your portfolio<\/b>: 33,301 EGP \(-66.7% since the start\)/)      // 20000 + 100×128.01 + 10×50
assert.match(pt, /COMI<\/b> 100 × 120.00 → 128.01 \(\+6.7%, \+801 EGP\)\n   HOLD · stop 115.80/)
assert.match(pt, /ABUK<\/b> 10 × 55.00 → 50.00 \(-9.1%, -50 EGP\) ⚠️ at or under your stop\n   EXIT .*\n   Closed under the stop/)
assert.match(pt, /Closed trades: 2, 50.0% won, \+1,500 EGP/)
assert.match(watchlistText(book, st.info), /COMI<\/b> 128.01 \(-0.4%\) · 13.4% chance in 10 days\n<b>ZZZZ<\/b>/)
console.log("portfolio ok")

// The whole link, on a stand-in for Cloudflare's storage and Telegram
import { Bot } from "./bot.js"
const kv = new Map(), sentMsgs = []
const storage = { get: async k => structuredClone(kv.get(k)), put: async (k, v) => { kv.set(k, structuredClone(v)) },
  delete: async ks => { for (const k of [].concat(ks)) kv.delete(k) } }
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  if (url.endsWith("/sendMessage")) sentMsgs.push(body.text)
  return new Response(JSON.stringify({ ok: true, result: url.endsWith("/getWebhookInfo") ? { url: "" } : true }))
}
const env = { BOT_TOKEN: "123:test", SYNC_KEY: "k".repeat(48) }
const bot = new Bot({ storage }, env)
const W = "https://w.example"
const post = (path, body, headers = {}) => bot.fetch(new Request(W + path, { method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers } }))
const hook = createHash("sha256").update("hook:" + env.SYNC_KEY).digest("hex").slice(0, 32)
let uid = 10
const tg = text => post("/telegram", { update_id: ++uid, message: { chat: { id: 9, type: "private" }, text } },
                        { "X-Telegram-Bot-Api-Secret-Token": hook })
assert.equal((await post("/state", { ...st, seen: 0 })).status, 403)                        // no key
assert.equal((await post("/state", { ...st, seen: 0 }, { Authorization: `Bearer ${env.SYNC_KEY}` })).status, 200)
await tg("/portfolio")
assert.match(sentMsgs.at(-1), /isn't linked yet/)
await tg("/link")
const code = /<code>([A-Z0-9]{8})<\/code>/.exec(sentMsgs.at(-1))[1]
assert.equal((await post("/pair", { code: "WRONG123" })).status, 400)
const { token } = await (await post("/pair", { code })).json()
assert.match(sentMsgs.at(-1), /portfolio is linked/)
assert.equal((await post("/pair", { code })).status, 400)                                  // works once
assert.equal((await post("/book", { token: "x".repeat(48), book })).status, 401)
assert.equal((await post("/book", { token, book })).status, 200)
await tg("/portfolio")
assert.match(sentMsgs.at(-1), /COMI<\/b> 100 × 120.00/)
await tg("/watchlist")
assert.match(sentMsgs.at(-1), /Your watchlist/)
await tg("/unlink")
assert.equal((await post("/book", { token, book })).status, 401)                           // the browser's link is gone
await tg("/portfolio")
assert.match(sentMsgs.at(-1), /isn't linked yet/)
console.log("link ok")
