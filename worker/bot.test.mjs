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
assert.match(await ask("hello there"), /didn't find “hello there”/)       // a hint, not silence
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
assert.match(await handle(st, u("hello")), /didn't find/)
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
assert.match(pt, /COMI<\/b> 100 × 120.00 → 128.01 \(\+6.7%, \+801 EGP\)\n   Hold · stop 115.80/)
assert.match(pt, /ABUK<\/b> 10 × 55.00 → 50.00 \(-9.1%, -50 EGP\) ⚠️ at or under your stop\n   Sell .*\n   Closed under the stop/)
// like Thndr's: the buy fees count in what you paid (12,000 + 21.5), no selling fee until you sell
const withFees = portfolioText({ ...book, positions: [{ ...book.positions[0], fees: 21.5 }], sent: "2026-09-29" }, st.info)
assert.match(withFees, /\(\+6.5%, \+780 EGP\)/)
assert.match(portfolioText({ ...book, positions: [{ ...book.positions[1], status: "BOUNCE",
  reason: "Big loss (-35.0%): sell at the first close above its 20-day average (59.77 now), by 2026-10-29 at the latest" }],
  sent: "2026-09-29" }, st.info), /Sell on a bounce · stop 51.00[\s\S]*Big loss \(-35.0%\)/)
assert.match(pt, /Closed trades: 2, 50.0% won, \+1,500 EGP/)
assert.match(watchlistText(book, st.info), /COMI<\/b> 128.01 \(-0.4%\) · 13.4% chance in 10 days\n<b>ZZZZ<\/b>/)
console.log("portfolio ok")

// The whole link, on a stand-in for Cloudflare's storage and Telegram
import { Bot } from "./bot.js"
const kv = new Map(), sentMsgs = []
const storage = { get: async k => structuredClone(kv.get(k)), put: async (k, v) => { kv.set(k, structuredClone(v)) },
  delete: async ks => { for (const k of [].concat(ks)) kv.delete(k) },
  list: async ({ prefix }) => new Map([...kv].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])) }
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

// Buttons, names, typos, Arabic, /quiet
import { respond, callbackText, search, plain, arNote, scanDue, cairo, webAppUser } from "./bot.js"
import { createHmac } from "node:crypto"
st.info.site = "https://example.github.io/egx-agent"
st.info.stocks.COMI.n = "البنك التجاري الدولي-مصر (سى اى بى )"
const card = await respond(st, u("comi"))
assert.deepEqual(card.kb[0].map(b => b.callback_data), ["w:COMI", "l:COMI"])
assert.equal(card.kb.at(-1)[0].web_app.url, "https://example.github.io/egx-agent/?go=stock%2FCOMI")
assert.equal(callbackText("w:COMI"), "/watch COMI")
assert.equal(callbackText("l:COMI"), "/watch COMI levels")
assert.equal(callbackText("t20"), "/top 20")
assert.equal(callbackText("w:<b>"), null)
assert.equal(callbackText("x:COMI"), null)
assert.equal(plain("التجارى"), plain("التجاري"))
assert.deepEqual(search(st.info, "التجارى"), ["COMI"])                     // ى or ي, either way
assert.deepEqual(search(st.info, "COMMI"), ["COMI"])                        // a typo
assert.equal(search(st.info, "zz").length, 0)
assert.match(await handle(st, u("البنك التجاري")), /<b>COMI<\/b>/)
const tapped = await respond(st, u("/watch COMI"))
assert.equal(tapped.kb[0][0].callback_data, "u:COMI")                     // a way to undo it
const arMsg = text => ({ update_id: 5, message: { chat: { id: 9, type: "private" }, from: { language_code: "en" }, text } })
assert.match(await handle(st, arMsg("/lang ar")), /سأرد بالعربية/)
assert.equal(st.subs[9].lang, "ar")
assert.match(await handle(st, arMsg("comi")), /الإغلاق 128.01/)
assert.match(await handle(st, arMsg("/lang")), /answer in English/)          // no word: the other language
assert.match(await handle(st, arMsg("/quiet")), /only message you/)
assert.equal(st.subs[9].quiet, true)
assert.match(await handle(st, arMsg("/quiet off")), /every close/)
assert.equal(st.subs[9].quiet, false)
const newbie = { fp, seen: 0, stocks: {}, subs: {}, alerts: {} }
await handle(newbie, { update_id: 6, message: { chat: { id: 4, type: "private" }, from: { language_code: "ar-EG" },
                                               text: "/start secretcode1" } })
assert.equal(newbie.subs[4].lang, "ar")                                      // their Telegram is in Arabic
assert.equal(arNote("Trend break (closed below 50-day average): sell at the next open"),
             "كسر الاتجاه (أغلق تحت متوسط 50 يومًا): بع عند الافتتاح القادم")
console.log("buttons and languages ok")

// On-time scans: when the bot asks GitHub to scan
const at = (day, hm, weekday = "Wed") => ({ day, minute: +hm.slice(0, 2) * 60 + +hm.slice(3), weekday })
assert.equal(scanDue({ scan: "2026-09-29" }, at("2026-09-30", "15:30")).key, undefined)          // prices not out yet
assert.equal(scanDue({ scan: "2026-09-29" }, at("2026-09-30", "15:45")).key, "2026-09-30 940")
assert.equal(scanDue({ scan: "2026-09-29" }, at("2026-09-30", "16:20")).key, "2026-09-30 970")
assert.equal(scanDue({ scan: "2026-09-30", final: true }, at("2026-09-30", "16:20")).key, undefined)  // it's in
assert.equal(scanDue({ scan: "2026-09-30", final: false }, at("2026-09-30", "16:20")).key, "2026-09-30 970")
assert.equal(scanDue({ scan: "2026-09-29" }, at("2026-10-02", "16:20", "Fri")).key, undefined)
assert.equal(scanDue({ scan: "2026-09-29" }, at("2026-09-30", "23:00")).key, undefined)
assert.equal(scanDue({ scan: "2026-09-30", final: false }, at("2026-09-30", "10:35")).key, "2026-09-30 s630")   // session
assert.equal(scanDue({ scan: "2026-09-30", final: false }, at("2026-09-30", "11:05")).key, "2026-09-30 s660")
assert.equal(scanDue({ scan: "2026-09-30", final: false }, at("2026-09-30", "14:40")).key, "2026-09-30 s870")
assert.equal(scanDue({ scan: "2026-09-29" }, at("2026-09-30", "10:10")).key, undefined)          // not yet
assert.deepEqual(cairo(new Date("2026-09-30T13:05:00Z")), { day: "2026-09-30", minute: 16 * 60 + 5, weekday: "Wed" })
console.log("scan times ok")

// One tap: the website's Connect button links the browser; the whole record syncs between devices; the Mac's link
const kv2 = new Map(), sent2 = [], github = []
const storage2 = { get: async k => structuredClone(kv2.get(k)), put: async (k, v) => { kv2.set(k, structuredClone(v)) },
  delete: async ks => { for (const k of [].concat(ks)) kv2.delete(k) },
  list: async ({ prefix }) => new Map([...kv2].filter(([k]) => k.startsWith(prefix))) }
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://api.github.com/")) { github.push(JSON.parse(init.body)); return new Response(null, { status: 204 }) }
  if (String(url).includes("/file/bot")) return new Response(new Uint8Array([137, 80, 78, 71]))     // a photo's bytes
  const body = JSON.parse(init.body)
  if (url.endsWith("/sendMessage")) sent2.push(body)
  return new Response(JSON.stringify({ ok: true, result: url.endsWith("/getWebhookInfo") ? { url: "" }
    : url.endsWith("/getFile") ? { file_path: "photos/1.jpg" } : true }))
}
const env2 = { BOT_TOKEN: "123:test", SYNC_KEY: "k".repeat(48), GH_TOKEN: "gh", GITHUB_REPO: "me/egx" }
const bot2 = new Bot({ storage: storage2 }, env2)
const post2 = (path, body, headers = {}) => bot2.fetch(new Request(W + path, { method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers } }))
const auth = { Authorization: `Bearer ${env2.SYNC_KEY}` }
const code24 = "secretcode1secretcode1ab"
const fp24 = createHash("sha256").update(code24).digest("hex").slice(0, 16)
await post2("/state", { fp: fp24, seen: 0, stocks: { COMI: 128 }, subs: {}, alerts: {}, info: st.info,
                        sitekey: { salt: "c2FsdA==", iter: 600000, key: "a2V5" } }, auth)
let uid2 = 100
const tg2 = (text, id = 11, extra = {}) => post2("/telegram", { update_id: ++uid2,
  message: { chat: { id, type: "private", first_name: "Sam" }, from: { language_code: "en" }, text }, ...extra },
  { "X-Telegram-Bot-Api-Secret-Token": hook })
const nonce = "0123456789abcdef0123456789abcdef"
await tg2(`/start ${code24}${nonce}`)
assert.match(sent2.at(-1).text, /Connected[\s\S]*portfolio is linked too/)
assert.ok(sent2.at(-1).reply_markup.inline_keyboard.flat().some(b => b.web_app))
const full = { v: 1, trades: [{ id: 1, account: "real", status: "open", symbol: "COMI" }], fills: [], dividends: [], adjustments: [] }
assert.equal((await post2("/book", { token: nonce, book, full, changed: "2026-09-30T10:00:00Z" })).status, 200)
assert.equal((await post2("/book", { token: nonce, book, full, changed: "2026-09-30T09:00:00Z" })).status, 409)  // older
assert.equal((await (await post2("/restore", { token: nonce })).json()).book.trades[0].symbol, "COMI")
assert.equal((await post2("/books", {})).status, 403)
assert.deepEqual(Object.keys((await (await post2("/books", {}, auth)).json()).books), ["11"])
// a second browser of the same person: already connected, so only the link
await tg2(`/start ${code24}${"f".repeat(32)}`)
assert.match(sent2.at(-1).text, /This browser's portfolio is linked/)
// your Mac's own Connect link: noted for the Mac to find, once
await tg2("/start macCode12345", 12)
assert.deepEqual(await (await post2("/started", { code: "macCode12345" })).json(), { found: true, id: "12", name: "Sam" })
assert.deepEqual(await (await post2("/started", { code: "macCode12345" })).json(), { found: false })
// a button press is the command it stands for, logged for the website's run
await tg2(null, 11, { message: undefined, callback_query: { id: "q1", data: "w:COMI", from: { id: 11 },
                                                            message: { message_id: 5, chat: { id: 11, type: "private" } } } })
const logged = (await (await bot2.fetch(new Request(W + "/updates", { headers: auth }))).json()).updates.at(-1)
assert.equal(logged.message.text, "/watch COMI")
assert.match(sent2.at(-1).text, /tell you when COMI gets a BUY/)
// the mini app: Telegram's signature gets the site's key and a link, a wrong one nothing
const user = JSON.stringify({ id: 11, first_name: "Sam" }), authDate = String(Math.floor(Date.now() / 1000))
const check = `auth_date=${authDate}\nquery_id=AAA\nuser=${user}`
const secret = createHmac("sha256", "WebAppData").update(env2.BOT_TOKEN).digest()
const signed = new URLSearchParams({ query_id: "AAA", user, auth_date: authDate,
  hash: createHmac("sha256", secret).update(check).digest("hex") }).toString()
assert.equal((await webAppUser(signed, env2.BOT_TOKEN)).id, 11)
assert.equal(await webAppUser(signed.replace("Sam", "Tom"), env2.BOT_TOKEN), null)
const mini = await (await post2("/miniapp", { initData: signed })).json()
assert.equal(mini.key.iter, 600000)
assert.equal((await post2("/restore", { token: mini.token })).status, 200)
assert.equal((await post2("/miniapp", { initData: signed.replace("Sam", "Tom") })).status, 403)
// /unlink forgets every link, the mini app's too
await tg2("/unlink")
assert.equal((await post2("/restore", { token: mini.token })).status, 401)
assert.equal((await post2("/restore", { token: nonce })).status, 401)
// on-time scans: asks GitHub once per slot
assert.equal((await post2("/tick", {}, auth)).status, 200)
console.log("one tap, sync, Mac, mini app ok")

// /why, /morning, the 9:30 reminder and a broker screenshot read
import { parseHoldings } from "./bot.js"
st.info.bands = [[91, 100, 0.2116, 0.0093], [71, 90, 0.1654, 0.0053], [51, 70, 0.1353, 0.0025], [1, 50, 0.1041, 0.0003]]
Object.assign(st.info, { base10: 0.1338, rated: 147, min_value: 5e6 })
Object.assign(st.info.stocks.COMI, { g: 71, k: "11001", h20: 131.2, vr: 1.08, adx: 31.6, co: [0.28, 0.12, 0.35, 6.1, 5.0] })
const why = await handle(st, u("/why comi"))
assert.match(why, /Rating 71\/100<\/b>: where the model's 2-week chance puts it among the 147 liquid stocks/)
assert.match(why, /Company: profit \+28.0% in a year · sales \+12.0% · P\/E 6.1 \(sector 5.0\)/)
assert.match(why, /stocks rated 71–90 reached the target before the stop 16.5% of the time \(the average stock 13.4%\), \+0.5% a trade/)
assert.match(why, /Not a BUY today[\s\S]*✅ Liquid: at least 5M EGP[\s\S]*❌ Breakout: a close above its 20-day high \(131.20\)/)
assert.match(why, /❌ Volume at least 1.5× normal \(last session 1.1×\)\n✅ Trend strength ADX above 20 \(now 32\)/)
assert.equal(callbackText("y:COMI"), "/why COMI")
assert.equal((await respond(st, u("comi"))).kb[1][0].callback_data, "y:COMI")        // a Why button under the card
assert.match(await handle(st, u("/why")), /Which stock\?/)
assert.match(await handle(st, u("abuk")), /No rating[\s\S]*BUY<\/b> up to 50.50/)     // the answer to "which stock?"
assert.match(await handle(st, arMsg("/lang ar")), /بالعربية/)
assert.match(await handle(st, arMsg("/why COMI")), /التقييم 71\/100[\s\S]*الشركة: الأرباح \+28.0% خلال سنة[\s\S]*❌ اختراق: إغلاق فوق أعلى سعر في 20 يومًا/)
assert.match(await handle(st, arMsg("/morning off")), /بدون تذكير صباحي/)
assert.equal(st.subs[9].morning, false)
assert.match(await handle(st, arMsg("/lang en")), /English/)
assert.match(await handle(st, u("/morning")), /remind you at 9:30/)
assert.equal(st.subs[9].morning, true)
assert.deepEqual(parseHoldings('```json\n{"holdings": [{"symbol": "comi", "name": "CIB", "shares": "1,200", ' +
  '"avg_price": 81.2, "last": null}, {"symbol": null, "name": null, "shares": 5}, {"symbol": "FWRY", "shares": 0}]}\n```'),
  [{ symbol: "COMI", name: "CIB", shares: 1200, avg_price: 81.2, last: null, value: null, pnl: null }])
assert.deepEqual(parseHoldings("I can't read that."), [])
{ // a screenshot against your portfolio, by what you paid (fees in): Thndr's KORA screen, 12,299 at 6.433 a share
  const { shotText } = await import("./bot.js")
  const site = (avg, fees = 0) => ({ positions: [{ symbol: "KORA", shares: 12299, avg, fees }] })
  const screen = { symbol: "KORA", shares: 12299, avg_price: 6.43, value: 76007.82, pnl: -3111.38 }
  assert.match(shotText([screen], site(6.433), st.info), /✅ <b>KORA<\/b> matches: you paid 79,119 EGP/)
  assert.doesNotMatch(shotText([screen], site(6.433), st.info), /Only on the website|isn't on/)
  // a buy fee counted twice on the website: 88 EGP more
  assert.match(shotText([screen], site(6.43, 125), st.info), /⚠️ <b>KORA<\/b>: you paid 79,119 EGP on the picture, 79,208 EGP on the website/)
  assert.match(shotText([{ ...screen, shares: 12000 }], site(6.433), st.info), /12,000 shares on the picture, 12,299 on the website/)
  // only Thndr's rounded average: close enough
  assert.match(shotText([{ symbol: "KORA", shares: 12299, avg_price: 6.43 }], site(6.433), st.info), /✅ <b>KORA<\/b> matches/)
  assert.match(shotText([screen], site(6.433), st.info, "ar"), /✅ <b>KORA<\/b> متطابق: دفعت 79,119 جنيه/)
  assert.match(shotText([], site(6.433), st.info), /found no holdings/)
}
// Thndr's list of stocks: only each one's market value and profit/loss (a loss with a minus, or as a number)
assert.deepEqual(parseHoldings('{"holdings": [{"symbol": "FCMD", "shares": null, "value": 23130, "pnl": 1202}, ' +
  '{"symbol": "KORA", "value": "76,008", "pnl": "−3,111"}, {"symbol": "AMES", "value": null, "pnl": -50}]}'),
  [{ symbol: "FCMD", name: null, shares: null, avg_price: null, last: null, value: 23130, pnl: 1202 },
   { symbol: "KORA", name: null, shares: null, avg_price: null, last: null, value: 76008, pnl: -3111 }])

// the reminder: once, at 9:30 Cairo on the day it's for, to friends who haven't turned it off
await post2("/state", { fp: fp24, seen: uid2, stocks: {}, subs: { 11: { weekly: true }, 12: { weekly: true, morning: false } },
                        alerts: {}, info: st.info, morning: { day: "2026-10-01", texts: { 11: "☀️ Before the open", 12: "x", 13: "y" } } }, auth)
const before = sent2.length
await bot2.tick(new Date("2026-10-01T06:05:00Z"))                     // 9:05 Cairo: too early
assert.equal(sent2.length, before)
await bot2.tick(new Date("2026-10-01T06:35:00Z"))                     // 9:35
assert.deepEqual(sent2.slice(before).map(m => [m.chat_id, m.text]), [["11", "☀️ Before the open"]])
await bot2.tick(new Date("2026-10-01T06:45:00Z"))
assert.equal(sent2.length, before + 1)                                // once
await bot2.tick(new Date("2026-10-02T06:35:00Z"))                     // another day: not that day's message
assert.equal(sent2.length, before + 1)

// a screenshot: only a linked browser, a picture, 20 a day; the model's answer checked
const nonce2 = "fedcba9876543210fedcba9876543210"
await tg2(`/start ${code24}${nonce2}`)
const png = "data:image/png;base64,iVBORw0KGgo="
assert.equal((await post2("/read", { token: nonce2, image: png })).status, 503)            // no AI binding yet
bot2.env.AI = { run: async (model, input) => {
  assert.equal(input.messages[0].content[1].image_url.url, png)
  return { response: '{"holdings": [{"symbol": "COMI", "name": "CIB", "shares": 450, "avg_price": 81.2, "last": 86.95}]}' }
} }
assert.equal((await post2("/read", { token: "x".repeat(32), image: png })).status, 401)
assert.equal((await post2("/read", { token: nonce2, image: "data:text/html;base64,PGI+" })).status, 400)
assert.deepEqual((await (await post2("/read", { token: nonce2, image: png })).json()).holdings,
                 [{ symbol: "COMI", name: "CIB", shares: 450, avg_price: 81.2, last: 86.95, value: null, pnl: null }])
// a screenshot sent to the bot itself: read the same way (the same 20 a day), checked against the linked portfolio
let asked = null
bot2.env.AI = { run: async (model, input) => {
  asked = input.messages[0].content[1].image_url.url
  return { response: '{"holdings": [{"symbol": "COMI", "value": 12801, "pnl": 801}, {"symbol": "FCMD", "value": 23130, "pnl": 1202}]}' }
} }
assert.equal((await post2("/book", { token: nonce2, book })).status, 200)
await post2("/telegram", { update_id: ++uid2, message: { chat: { id: 11, type: "private" }, from: { language_code: "en" },
  photo: [{ file_id: "small", file_size: 10 }, { file_id: "big", file_size: 900 }] } }, { "X-Telegram-Bot-Api-Secret-Token": hook })
assert.equal(asked, "data:image/jpeg;base64,iVBORw==")
assert.match(sent2.at(-2).text, /Reading your screenshot/)
assert.match(sent2.at(-1).text, /COMI<\/b> matches: you paid 12,000 EGP, fees in\n➕ <b>FCMD<\/b> isn't on the website \(23,130 worth, \+1,202 EGP\)\nOnly on the website: ABUK/)
for (let i = 0; i < 17; i++) await post2("/read", { token: nonce2, image: png })
assert.equal((await post2("/read", { token: nonce2, image: png })).status, 200)             // the 20th
assert.equal((await post2("/read", { token: nonce2, image: png })).status, 429)
console.log("why, morning, screenshots ok")

{ // /quotes: the website's live prices, from TradingView's screener (Kashif codes ↔ TradingView's)
  const { quotes } = await import("./bot.js")
  let asked = null
  const get = async (u, o) => {
    asked = JSON.parse(o.body)
    return { ok: true, json: async () => ({ data: [{ s: "EGX:AIH", d: [0.75, 1.5] }, { s: "EGX:COMI", d: [127.7, -0.4] }] }) }
  }
  const res = await quotes(new URL("https://w/quotes?s=comi,AIHC,bad!"), get)
  assert.deepEqual(asked.symbols.tickers, ["EGX:AIH", "EGX:COMI"])
  assert.deepEqual(await res.json(), { AIHC: { price: 0.75, change: 0.015 }, COMI: { price: 127.7, change: -0.004 } })
  console.log("quotes ok")
}

{ // next week (Predictions → Next week) and EGX30 (Market → EGX30)
  const info = { ...st.info, week: { strong: 0.4815, all: 0.3106, top: 1, weak: false },
    x30: { d: "2026-10-01", c: 53055, ch: 0.0224, e50: 54220.17, r: { "1W": -0.0134, "1M": -0.0471, YTD: 0.2684, "1Y": 0.5068 },
           u: { YTD: 0.1563, "1Y": 0.3883 }, ath: -0.0639, hi: 56937.2, lo: 35207.5, off: true, blk: true, b50: 0.324 },
    stocks: { COMI: { ...st.info.stocks.COMI, w: 0.42, wr: 2, wm: 0.05, wl: "good" },
              ABUK: { ...st.info.stocks.ABUK, w: 0.48, wr: 1, wm: 0.06, wl: "good" } } }
  const s2 = { ...st, info }, q = text => handle(s2, u(text))
  const wk = await q("/week")
  assert.match(wk, /Next week's best chances<\/b> \(from the 29 Sep close\)\n1\. <b>ABUK<\/b> 48.0% · target 53.00 \(\+6.0%\) · stop 47.00 · 💪 Strong\n2\. <b>COMI<\/b> 42.0% · target 134.41 \(\+5.0%\) · stop 121.61\n/)
  assert.match(wk, /strong picks .* got there first 48.1% of the time, the average stock 31.1%/)
  assert.doesNotMatch(wk, /Weak market/)
  info.week.weak = true
  assert.match(await q("/week"), /close\)\n⚠️ <b>Weak market<\/b>/)
  assert.match(await q("/stock comi"), /No signal today.\nNext week: 42.0% chance to reach 134.41 before 121.61 \(rank 2\)\nChance to reach/)
  assert.match(await q("/egx30"), /<b>EGX30<\/b> 53,055 \(\+2.2%\) · 1 Oct\nWeek -1.3% · month -4.7% · this year \+26.8% · a year \+50.7%\nIn dollars: this year \+15.6% · a year \+38.8%\n1-year range 35,208 – 56,937 · 6.4% under its record\n🔴 Under its 50-day average \(54,220\): the agent makes no new BUYs\n32.4% of stocks/)
  assert.equal(callbackText("k"), "/week")
  assert.equal(callbackText("e"), "/egx30")
  assert.match(await q("/help"), /\/week[\s\S]*\/egx30[\s\S]*📷 Send a screenshot/)
  assert.match(await handle({ ...st, info: { ...st.info, x30: null } }, u("/egx30")), /hasn't reached me/)
  console.log("week and egx30 ok")
}
