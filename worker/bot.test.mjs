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
