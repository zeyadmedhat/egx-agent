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
