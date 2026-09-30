// The website's Telegram bot, answering at once (a Cloudflare Worker). Telegram hands every message here the moment
// it's sent and the reply goes straight back. The website's run (app/site_daily.py) stays in charge: it picks up the
// messages from here (GET /updates), applies them to its data, and sends back who's connected and their alerts
// (POST /state). Secrets (set with wrangler): BOT_TOKEN (from @BotFather), SYNC_KEY (= the WORKER_KEY GitHub secret)
// and, for on-time scans, GH_TOKEN (a GitHub key that can only start this repository's runs).
// Keep the replies in step with app/alerts.py.

const WATCH_RE = /^\/watch(?:@\w+)?\s+([A-Za-z0-9]{2,12})(?:\s+([0-9]+(?:[.,][0-9]+)?|levels))?\s*$/i
const UNWATCH_RE = /^\/unwatch(?:@\w+)?\s+([A-Za-z0-9]{2,12})\s*$/i
const LIST_RE = /^\/(?:list|alerts)(?:@\w+)?\s*$/i
const WEEKLY_RE = /^\/weekly(?:@\w+)?\s+(on|off)\s*$/i
const QUIET_RE = /^\/quiet(?:@\w+)?(?:\s+(on|off))?\s*$/i
const LANG_RE = /^\/lang(?:@\w+)?(?:\s+(\S+))?\s*$/i
const START_RE = /^\/start\s+([A-Za-z0-9_-]{8,64})\s*$/
const STOP_RE = /^\/stop(@\w+)?\s*$/
const STOCK_RE = /^(?:\/(?:stock|s)(?:@\w+)?\s+)?([A-Za-z0-9]{2,12})\s*$/i
const ASK_RE = /^\/(?:stock|s)(?:@\w+)?\s+(.+)$/i
const TOP_RE = /^\/top(?:@\w+)?(?:\s+(10|20))?\s*$/i
const BUYS_RE = /^\/(?:buys|signals)(?:@\w+)?\s*$/i
const HELP_RE = /^\/(?:help|start)(?:@\w+)?\s*$/i
const CODE_LEN = 24           // the site's code (static_site.telegram_code); a longer /start carries a browser's link
const NONCE_RE = /^[a-f0-9]{32}$/
const MAX_ALERTS = 20

// ------------------------------------------------------------------ words, in English and Arabic
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const px = v => v.toLocaleString("en-US", { minimumFractionDigits: Math.abs(v) < 10 ? 3 : 2,
                                             maximumFractionDigits: Math.abs(v) < 10 ? 3 : 2 })
const pct = (v, sign = false) => (sign && v > 0 ? "+" : "") + (v * 100).toFixed(1) + "%"
const egp = v => Math.round(v).toLocaleString("en-US")
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"]

const EN = {
  day: d => d ? `${+d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]}` : "–",
  welcome: "✅ <b>Connected.</b> After each EGX close you'll get the day's signals here. Your share counts are on " +
    "the website.\nSend /help for what I can do, or /stop to stop.",
  linkedToo: "\n\n🔗 Your website portfolio is linked too: after each close I'll add what to do with your own " +
    "positions. /portfolio any time.",
  linkedOnly: "🔗 <b>This browser's portfolio is linked.</b> After each close I'll add what to do with your own " +
    "positions. /portfolio any time.",
  stopped: "Stopped. To start again, open the website → Settings → Connect Telegram.",
  help: "<b>Ask about any stock</b>: send its symbol (COMI) or part of its Arabic name (التجاري).\n" +
    "/top: the 10 best chances to reach the target in 10 days (/top 20: in 20 days)\n" +
    "/buys: today's BUY signals\n\n" +
    "<b>Alerts for the stocks you follow</b>, checked after each close:\n" +
    "/watch COMI: when COMI gets a BUY signal\n" +
    "/watch COMI 45: when COMI closes above 45 (or below, if 45 is under today's price)\n" +
    "/watch COMI levels: when COMI closes near a strong support (a place to buy) or reaches resistance " +
    "(a place to take profit)\n" +
    "/unwatch COMI: stop COMI's alerts (/unwatch all: every alert)\n" +
    "/list: your alerts\n\n" +
    "<b>Your own portfolio</b> (from the website):\n" +
    "/portfolio: your positions, profit and what the exit rules say\n" +
    "/watchlist: the stocks you starred\n" +
    "/link: connect them (once) · /unlink: disconnect\n\n" +
    "<b>Messages</b>\n" +
    "/quiet: only message me on days with a BUY or something to do (/quiet off: every close)\n" +
    "/weekly off: no Thursday summary (/weekly on to have it again)\n" +
    "/lang ar: بالعربية\n" +
    "/stop: stop all messages",
  noData: "The website's data hasn't reached me yet. Try again after its next run.",
  unknown: s => `I don't know ${s}. Use the stock's EGX symbol, like COMI.`,
  notFound: s => `I didn't find “${s}”. Send a stock's symbol (COMI) or part of its Arabic name (التجاري), or /help.`,
  didYouMean: "Did you mean one of these?",
  which: "Which stock? Send its symbol, like COMI.",
  whichWatch: "Which stock? Send its symbol (COMI), or with a price (COMI 45), or COMI levels.",
  whichUnwatch: "Which stock? Send its symbol, or all.",
  weeklyOn: "OK: you'll get the week's summary after Thursday's close.",
  weeklyOff: "OK: no weekly summary. Send /weekly on to have it again.",
  quietOn: "OK: after a close I'll only message you when there's a BUY signal or something to do with your " +
    "positions. Your alerts and the Thursday summary still come. /quiet off for every close.",
  quietOff: "OK: you'll get every close's message again.",
  langSet: "OK: I'll answer in English. /lang ar for Arabic.",
  close: (c, ch, d) => `Close ${c}${ch} on ${d}`,
  buy: (e, s, t) => `🟢 <b>BUY</b> up to ${e} · stop ${s} · target ${t}`,
  signal: (a, e, s, t) => `Signal: ${a}${e ? ` (entry up to ${e} · stop ${s} · target ${t})` : ""}`,
  noSignal: "No signal today.",
  chance: "Chance to reach the target: ",
  inDays: (p, hz, rank, x) => `${p} in ${hz} days (rank ${rank}${x ? `, expected ${x}` : ""})`,
  chart: (sup, res, s, t) => `Chart: support ${sup} · resistance ${res} · stop ${s} · target ${t}`,
  levelsTip: sym => `/watch ${sym} levels: an alert when it nears support or resistance`,
  top: (hz, d) => `<b>Best chances to reach the target in ${hz} days</b> (${d})`,
  expected: x => ` · expected ${x}`,
  topFoot: "Not advice: chances from the website's model. Tap a stock for more.",
  noPred: "No predictions yet.",
  noBuys: d => `No BUY signals at the ${d} close.`,
  buys: d => `<b>BUY signals at the ${d} close</b>`,
  buyLine: (sym, e, s, t) => `🟢 <b>${sym}</b> up to ${e} · stop ${s} · target ${t}`,
  buysFoot: "Your share counts are on the website.",
  alertBuy: s => `${s}: a BUY signal`,
  alertLevels: s => `${s}: near support or resistance`,
  alertPrice: (s, k, p) => `${s}: a close ${k} ${p}`,
  noAlerts: "You have no alerts yet.\n\n",
  yourAlerts: "<b>Your alerts</b>",
  removedAll: n => n ? `Removed all your alerts (${n}).` : "You have no alerts.",
  removed: (n, s) => n ? `Removed ${n} alert${n !== 1 ? "s" : ""} for ${s}.` : `You have no alert for ${s}.`,
  tooMany: m => `You already have ${m} alerts. Remove some with /unwatch first.`,
  okBuy: s => `OK: I'll tell you when ${s} gets a BUY signal, after any close.`,
  okLevels: s => `OK: I'll tell you when ${s} closes near a strong support or reaches resistance ` +
    "(the levels on its page on the website).",
  noPrices: s => `There are no prices for ${s} yet, so I can't watch its price.`,
  okPrice: (s, k, p, last) => `OK: I'll tell you when ${s} closes ${k} ${p} (last close ${last}).`,
  bBuy: "🔔 BUY alert", bLevels: "📍 Levels alert", bStop: "🔕 Stop its alerts", bApp: "📱 Open the app",
  bBuys: "🟢 Today's BUYs", bTop: "🏆 Best chances",
  // your portfolio
  linkCode: (code, mins) => `Your code: <code>${code}</code>\nOn the website: Settings → <b>Your portfolio in Telegram</b> → ` +
    `type it and press Link. It works once, for ${mins} minutes.\nThe website then sends me your portfolio whenever it ` +
    "changes, so /portfolio and /watchlist answer here, and after each close I tell you what to do with your positions. " +
    "/unlink to stop.",
  linkDone: "✅ <b>Your portfolio is linked.</b> Send /portfolio or /watchlist any time.",
  unlinked: "Unlinked: I've deleted the copy of your portfolio. The website keeps it, as before.",
  notLinked: "Your portfolio isn't linked yet. Open the website → Settings → Connect Telegram, or send /link.",
  worth: (w, since) => `<b>Your portfolio</b>: ${w} EGP${since ? ` (${since} since the start)` : ""}`,
  cash: (c, n) => `Cash ${c} EGP · ${n} open position${n === 1 ? "" : "s"}`,
  closed: (n, w, t) => `Closed trades: ${n}, ${w} won, ${t} EGP`,
  atStop: " ⚠️ at or under your stop", atTarget: " 🎯 at your target",
  stopW: "stop", targetW: "target",
  status: s => s,
  note: s => s,
  foot: (sent, scan) => `\n\nSent by your browser on ${sent}; prices from the ${scan} close. ` +
    "Open the website to update the exit rules.",
  fresh: scan => `\n\nChecked with the exit rules at the ${scan} close.`,
  wlEmpty: "Your watchlist is empty. Star stocks (☆) on the website.",
  wl: "<b>Your watchlist</b>",
  wlChance: p => ` · ${p} chance in 10 days`,
  wlFoot: "/stock SYMBOL for more.",
}

const AR = {
  day: d => d ? `${+d.slice(8, 10)} ${MONTHS_AR[+d.slice(5, 7) - 1]}` : "–",
  welcome: "✅ <b>تم الاتصال.</b> بعد كل إغلاق للبورصة المصرية ستصلك إشارات اليوم هنا. عدد الأسهم لكل صفقة على الموقع.\n" +
    "أرسل /help لتعرف ما يمكنني فعله، أو /stop للإيقاف.",
  linkedToo: "\n\n🔗 وتم ربط محفظتك على الموقع أيضًا: بعد كل إغلاق سأخبرك بما تفعله في مراكزك. /portfolio في أي وقت.",
  linkedOnly: "🔗 <b>تم ربط محفظة هذا المتصفح.</b> بعد كل إغلاق سأخبرك بما تفعله في مراكزك. /portfolio في أي وقت.",
  stopped: "تم الإيقاف. للبدء من جديد افتح الموقع ← الإعدادات ← ربط تيليجرام.",
  help: "<b>اسأل عن أي سهم</b>: أرسل رمزه (COMI) أو جزءًا من اسمه (التجاري).\n" +
    "/top: أفضل 10 فرص للوصول إلى الهدف خلال 10 أيام (/top 20: خلال 20 يومًا)\n" +
    "/buys: إشارات الشراء اليوم\n\n" +
    "<b>تنبيهات للأسهم التي تتابعها</b>، تُفحص بعد كل إغلاق:\n" +
    "/watch COMI: عندما يحصل COMI على إشارة شراء\n" +
    "/watch COMI 45: عندما يغلق COMI فوق 45 (أو تحته إذا كان 45 أقل من سعر اليوم)\n" +
    "/watch COMI levels: عندما يغلق قرب دعم قوي (مكان للشراء) أو يصل إلى مقاومة (مكان لجني الربح)\n" +
    "/unwatch COMI: إيقاف تنبيهات COMI (/unwatch all: كل التنبيهات)\n" +
    "/list: تنبيهاتك\n\n" +
    "<b>محفظتك</b> (من الموقع):\n" +
    "/portfolio: مراكزك وأرباحك وما تقوله قواعد الخروج\n" +
    "/watchlist: الأسهم التي ميّزتها بنجمة\n" +
    "/link: ربطها (مرة واحدة) · /unlink: فك الربط\n\n" +
    "<b>الرسائل</b>\n" +
    "/quiet: راسلني فقط في الأيام التي فيها إشارة شراء أو شيء أفعله (/quiet off: بعد كل إغلاق)\n" +
    "/weekly off: بدون ملخص الخميس (/weekly on لإعادته)\n" +
    "/lang en: English\n" +
    "/stop: إيقاف كل الرسائل",
  noData: "بيانات الموقع لم تصلني بعد. حاول بعد تشغيله القادم.",
  unknown: s => `لا أعرف ${s}. استخدم رمز السهم في البورصة المصرية، مثل COMI.`,
  notFound: s => `لم أجد «${s}». أرسل رمز السهم (COMI) أو جزءًا من اسمه (التجاري)، أو /help.`,
  didYouMean: "هل تقصد أحد هذه الأسهم؟",
  which: "أي سهم؟ أرسل رمزه، مثل COMI.",
  whichWatch: "أي سهم؟ أرسل رمزه (COMI)، أو مع سعر (COMI 45)، أو COMI levels.",
  whichUnwatch: "أي سهم؟ أرسل رمزه، أو all.",
  weeklyOn: "تم: سيصلك ملخص الأسبوع بعد إغلاق الخميس.",
  weeklyOff: "تم: بدون ملخص أسبوعي. أرسل /weekly on لإعادته.",
  quietOn: "تم: بعد الإغلاق سأراسلك فقط عندما توجد إشارة شراء أو شيء تفعله في مراكزك. تنبيهاتك وملخص الخميس تصلك كما هي. " +
    "/quiet off لرسالة بعد كل إغلاق.",
  quietOff: "تم: ستصلك رسالة بعد كل إغلاق مرة أخرى.",
  langSet: "تم: سأرد بالعربية. /lang en للإنجليزية.",
  close: (c, ch, d) => `الإغلاق ${c}${ch} يوم ${d}`,
  buy: (e, s, t) => `🟢 <b>شراء</b> حتى ${e} · الوقف ${s} · الهدف ${t}`,
  signal: (a, e, s, t) => `الإشارة: ${a}${e ? ` (الدخول حتى ${e} · الوقف ${s} · الهدف ${t})` : ""}`,
  noSignal: "لا توجد إشارة اليوم.",
  chance: "فرصة الوصول إلى الهدف: ",
  inDays: (p, hz, rank, x) => `${p} خلال ${hz} يومًا (الترتيب ${rank}${x ? `، المتوقع ${x}` : ""})`,
  chart: (sup, res, s, t) => `الرسم البياني: الدعم ${sup} · المقاومة ${res} · الوقف ${s} · الهدف ${t}`,
  levelsTip: sym => `/watch ${sym} levels: تنبيه عندما يقترب من الدعم أو المقاومة`,
  top: (hz, d) => `<b>أفضل الفرص للوصول إلى الهدف خلال ${hz} يومًا</b> (${d})`,
  expected: x => ` · المتوقع ${x}`,
  topFoot: "ليست نصيحة: فرص من نموذج الموقع. اضغط على سهم للمزيد.",
  noPred: "لا توجد توقعات بعد.",
  noBuys: d => `لا توجد إشارات شراء عند إغلاق ${d}.`,
  buys: d => `<b>إشارات الشراء عند إغلاق ${d}</b>`,
  buyLine: (sym, e, s, t) => `🟢 <b>${sym}</b> حتى ${e} · الوقف ${s} · الهدف ${t}`,
  buysFoot: "عدد الأسهم لكل صفقة على الموقع.",
  alertBuy: s => `${s}: إشارة شراء`,
  alertLevels: s => `${s}: قرب الدعم أو المقاومة`,
  alertPrice: (s, k, p) => `${s}: إغلاق ${k === "above" ? "فوق" : "تحت"} ${p}`,
  noAlerts: "ليس لديك تنبيهات بعد.\n\n",
  yourAlerts: "<b>تنبيهاتك</b>",
  removedAll: n => n ? `تم حذف كل تنبيهاتك (${n}).` : "ليس لديك تنبيهات.",
  removed: (n, s) => n ? `تم حذف ${n} تنبيه لـ ${s}.` : `ليس لديك تنبيه لـ ${s}.`,
  tooMany: m => `لديك ${m} تنبيهًا بالفعل. احذف بعضها بـ /unwatch أولًا.`,
  okBuy: s => `تم: سأخبرك عندما يحصل ${s} على إشارة شراء بعد أي إغلاق.`,
  okLevels: s => `تم: سأخبرك عندما يغلق ${s} قرب دعم قوي أو يصل إلى مقاومة (المستويات في صفحته على الموقع).`,
  noPrices: s => `لا توجد أسعار لـ ${s} بعد، فلا يمكنني متابعة سعره.`,
  okPrice: (s, k, p, last) => `تم: سأخبرك عندما يغلق ${s} ${k === "above" ? "فوق" : "تحت"} ${p} (آخر إغلاق ${last}).`,
  bBuy: "🔔 تنبيه شراء", bLevels: "📍 تنبيه المستويات", bStop: "🔕 إيقاف تنبيهاته", bApp: "📱 افتح التطبيق",
  bBuys: "🟢 شراء اليوم", bTop: "🏆 أفضل الفرص",
  linkCode: (code, mins) => `الكود: <code>${code}</code>\nعلى الموقع: الإعدادات ← <b>محفظتك في تيليجرام</b> ← اكتبه واضغط ربط. ` +
    `يعمل مرة واحدة لمدة ${mins} دقيقة.\nبعدها يرسل لي الموقع محفظتك كلما تغيّرت، فيجيب /portfolio و/watchlist هنا، ` +
    "وبعد كل إغلاق أخبرك بما تفعله في مراكزك. /unlink للإيقاف.",
  linkDone: "✅ <b>تم ربط محفظتك.</b> أرسل /portfolio أو /watchlist في أي وقت.",
  unlinked: "تم فك الربط: حذفت نسختي من محفظتك. الموقع يحتفظ بها كما كان.",
  notLinked: "محفظتك غير مربوطة بعد. افتح الموقع ← الإعدادات ← ربط تيليجرام، أو أرسل /link.",
  worth: (w, since) => `<b>محفظتك</b>: ${w} جنيه${since ? ` (${since} منذ البداية)` : ""}`,
  cash: (c, n) => `النقدية ${c} جنيه · ${n} مركز مفتوح`,
  closed: (n, w, t) => `صفقات مغلقة: ${n}، الرابحة ${w}، ${t} جنيه`,
  atStop: " ⚠️ عند وقف الخسارة أو تحته", atTarget: " 🎯 عند الهدف",
  stopW: "الوقف", targetW: "الهدف",
  status: s => ({ EXIT: "بيع", REVIEW: "مراجعة", "TIGHTEN STOP": "ارفع الوقف", HOLD: "احتفظ", ADJUST: "حدّث عدد الأسهم",
                  "NO DATA": "لا توجد بيانات" })[s] || s,
  note: s => arNote(s),
  foot: (sent, scan) => `\n\nأرسلها متصفحك يوم ${sent}؛ الأسعار من إغلاق ${scan}. افتح الموقع لتحديث قواعد الخروج.`,
  fresh: scan => `\n\nفُحصت بقواعد الخروج عند إغلاق ${scan}.`,
  wlEmpty: "قائمة متابعتك فارغة. ميّز الأسهم بنجمة (☆) على الموقع.",
  wl: "<b>قائمة متابعتك</b>",
  wlChance: p => ` · فرصة ${p} خلال 10 أيام`,
  wlFoot: "/stock ورمز السهم للمزيد.",
}

// The exit rules' notes (egx_agent/engine.py), in Arabic. Anything else stays as written. Kept in step with
// app/alerts.py (NOTES_AR) and the website's app/static/js/i18n.js.
const NOTES = [
  [/^Trend break \(closed below 50-day average\)/, "كسر الاتجاه (أغلق تحت متوسط 50 يومًا)"],
  [/^Max hold reached \((\d+) trading days\)/, "انتهت مدة الاحتفاظ ($1 جلسة)"],
  [/^Trailing stop/, "الوقف المتحرك"], [/^Breakeven stop/, "وقف التعادل"], [/^Stop-loss/, "وقف الخسارة"],
  [/^Target reached/, "تم الوصول للهدف"], [/: sell at the next open/, ": بع عند الافتتاح القادم"],
  [/: sell at the open \(flagged before ([\d-]+)\)/, ": بع عند الافتتاح (ظهرت قبل $1)"], [/ \(gap down\)/, " (فجوة هبوط)"],
  [/ \(gap up\)/, " (فجوة صعود)"], [/ on ([\d-]+) at ([\d.]+)/, " يوم $1 عند $2"],
  [/^Day (\d+): no \+1R move yet \(needs ([\d.]+)\)\. Consider exiting\./, "اليوم $1: لم يتحرك +1R بعد (يحتاج $2). فكّر في الخروج."],
  [/^Raise your stop to ([\d.]+)/, "ارفع وقفك إلى $1"], [/^Stop ([\d.]+), target ([\d.]+)/, "الوقف $1، الهدف $2"],
]
export const arNote = s => NOTES.reduce((out, [re, ar]) => out.replace(re, ar), String(s || ""))

const L = lang => (lang === "ar" ? AR : EN)
const langOf = (state, cid, msg) => (state.subs[cid] && state.subs[cid].lang) ||
  (String((msg && msg.from && msg.from.language_code) || "").startsWith("ar") ? "ar" : "en")
const LANG_WORDS = { ar: "ar", arabic: "ar", "عربي": "ar", "العربية": "ar", en: "en", english: "en", "انجليزي": "en",
                     "الإنجليزية": "en" }

async function sha(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("")
}

// ------------------------------------------------------------------ buttons under a reply
const reply = (text, kb) => ({ text, kb: kb && kb.length ? kb : undefined })
const cb = (text, data) => ({ text, callback_data: data })
// Buttons send these; each becomes the command it stands for (the website's run reads it like a typed message).
const CALLBACKS = { w: s => `/watch ${s}`, l: s => `/watch ${s} levels`, u: s => `/unwatch ${s}`, s: s => `/stock ${s}`,
                    b: () => "/buys", t: () => "/top", t20: () => "/top 20" }
export function callbackText(data) {
  const [k, sym = ""] = String(data || "").split(":")
  if (!Object.hasOwn(CALLBACKS, k)) return null
  const needs = CALLBACKS[k].length > 0
  return needs ? (/^[A-Z0-9]{2,12}$/.test(sym) ? CALLBACKS[k](sym) : null) : CALLBACKS[k]()
}

// The website inside Telegram (a mini app), opened on one of its pages.
function appButton(info, lang, go) {
  const site = info && info.site
  if (!/^https:\/\//.test(site || "")) return null
  return { text: L(lang).bApp, web_app: { url: site.replace(/\/?$/, "/") + (go ? `?go=${encodeURIComponent(go)}` : "") } }
}
const rows = (buttons, per) => {
  const out = []
  for (let i = 0; i < buttons.length; i += per) out.push(buttons.slice(i, i + per))
  return out
}
const symbolButtons = syms => rows(syms.map(s => cb(s, `s:${s}`)), 4)

// ------------------------------------------------------------------ asking about the website's data
function stockCard(state, cid, sym, lang) {
  const T = L(lang), info = state.info, s = info.stocks[sym]
  const lines = [`<b>${esc(sym)}</b> ${esc(s.n)}`,
    T.close(px(s.c), s.ch != null ? ` (${pct(s.ch, true)})` : "", T.day(s.d))]
  if (s.a === "BUY") lines.push(T.buy(px(s.e), px(s.s), px(s.t)))
  else if (s.a) lines.push(T.signal(esc(s.a), s.e ? px(s.e) : null, s.e ? px(s.s) : null, s.e ? px(s.t) : null))
  else lines.push(T.noSignal)
  const ch = [10, 20].filter(hz => s["p" + hz] != null).map(hz =>
    T.inDays(pct(s["p" + hz]), hz, s["r" + hz], s["x" + hz] != null ? pct(s["x" + hz], true) : null))
  if (ch.length) lines.push(T.chance + ch.join(" · "))
  if (s.cs != null) lines.push(T.chart(s.sup != null ? px(s.sup) : "–", s.res != null ? px(s.res) : "–", px(s.cs), px(s.ct)))
  lines.push(T.levelsTip(esc(sym)))
  const kb = [[cb(T.bBuy, `w:${sym}`), cb(T.bLevels, `l:${sym}`)]]
  if ((state.alerts[cid] || []).some(a => a.symbol === sym)) kb.push([cb(T.bStop, `u:${sym}`)])
  const app = appButton(info, lang, `stock/${sym}`)
  if (app) kb.push([app])
  return reply(lines.join("\n"), kb)
}

function top(info, hz, lang) {
  const T = L(lang)
  const list = Object.entries(info.stocks).filter(([, s]) => s["r" + hz] != null)
    .sort((a, b) => a[1]["r" + hz] - b[1]["r" + hz]).slice(0, 10)
  if (!list.length) return reply(T.noPred)
  return reply(T.top(hz, T.day(info.pred)) + "\n" + list.map(([sym, s], i) =>
    `${i + 1}. <b>${esc(sym)}</b> ${pct(s["p" + hz])}` + (s["x" + hz] != null ? T.expected(pct(s["x" + hz], true)) : "") +
    ` · ${px(s.c)}`).join("\n") + "\n\n" + T.topFoot, symbolButtons(list.map(([sym]) => sym)))
}

function buys(info, lang) {
  const T = L(lang)
  const list = Object.entries(info.stocks).filter(([, s]) => s.a === "BUY")
  if (!list.length) return reply(T.noBuys(T.day(info.scan)), [[cb(T.bTop, "t")]])
  return reply(T.buys(T.day(info.scan)) + "\n" + list.map(([sym, s]) => T.buyLine(esc(sym), px(s.e), px(s.s), px(s.t)))
    .join("\n") + "\n\n" + T.buysFoot, symbolButtons(list.map(([sym]) => sym)))
}

// Stock names: Arabic spelled several ways (أ/إ/آ/ا, ى/ي, ة/ه, with or without marks), English in any case.
export const plain = s => String(s || "").toLowerCase().replace(/[ً-ٰٟـ]/g, "")
  .replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim()

function distance(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]
    d[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j]
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return d[b.length]
}

// A symbol, a part of a name, or a typo: the stocks it could mean (best first).
export function search(info, text) {
  const q = plain(text), up = text.trim().toUpperCase()
  if (!q) return []
  if (info.stocks[up]) return [up]
  const named = q.length >= 3 ? Object.keys(info.stocks).filter(sym => plain(info.stocks[sym].n).includes(q)) : []
  if (named.length) return named.slice(0, 8)
  if (!/^[A-Z0-9]{2,12}$/.test(up)) return []
  const most = up.length >= 5 ? 2 : 1
  return Object.keys(info.stocks).map(sym => [sym, distance(up, sym)]).filter(([, n]) => n <= most)
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([sym]) => sym)
}

function ask(state, cid, text, lang) {
  const info = state.info, T = L(lang)
  let m = TOP_RE.exec(text)
  if (m) return info ? top(info, +(m[1] || 10), lang) : reply(T.noData)
  if (BUYS_RE.test(text)) return info ? buys(info, lang) : reply(T.noData)
  if (HELP_RE.test(text)) {
    const app = appButton(info, lang)
    return reply(T.help, [[cb(T.bBuys, "b"), cb(T.bTop, "t")], ...(app ? [[app]] : [])])
  }
  const command = text.startsWith("/")
  m = command ? ASK_RE.exec(text) : null
  if (command && !m) return undefined                  // another command
  if (!info) return command ? reply(T.noData) : undefined
  const q = command ? m[1].trim() : text
  const found = search(info, q)
  if (found.length === 1) return stockCard(state, cid, found[0], lang)
  if (found.length) return reply(T.didYouMean, symbolButtons(found))
  if (command && STOCK_RE.test(text)) return reply(T.unknown(esc(q.toUpperCase())))
  return reply(T.notFound(esc(q.slice(0, 40))))
}

function alertText(a, lang) {
  const T = L(lang)
  if (a.kind === "buy") return T.alertBuy(a.symbol)
  if (a.kind === "levels") return T.alertLevels(a.symbol)
  return T.alertPrice(a.symbol, a.kind, px(a.price))
}

function watch(state, cid, text, lang) {
  const T = L(lang), mine = state.alerts[cid] || []
  if (LIST_RE.test(text)) {
    if (!mine.length) return reply(T.noAlerts + T.help)
    return reply(T.yourAlerts + "\n" + [...mine].sort((a, b) => (a.symbol + a.kind).localeCompare(b.symbol + b.kind))
      .map(a => esc(alertText(a, lang))).join("\n"))
  }
  let m = UNWATCH_RE.exec(text)
  if (m) {
    const sym = m[1].toUpperCase(), n = mine.filter(a => sym === "ALL" || a.symbol === sym).length
    state.alerts[cid] = mine.filter(a => sym !== "ALL" && a.symbol !== sym)
    return reply(sym === "ALL" ? T.removedAll(n) : T.removed(n, esc(sym)))
  }
  m = WATCH_RE.exec(text)
  if (!m) return reply(T.help)
  const sym = m[1].toUpperCase()
  if (!(sym in state.stocks)) return reply(T.unknown(esc(sym)))
  if (mine.length >= MAX_ALERTS) return reply(T.tooMany(MAX_ALERTS))
  const last = state.stocks[sym]
  let kind, price = null, out
  if (m[2] === undefined) {
    kind = "buy"
    out = T.okBuy(sym)
  } else if (m[2].toLowerCase() === "levels") {
    kind = "levels"
    out = T.okLevels(sym)
  } else {
    price = parseFloat(m[2].replace(",", "."))
    if (last == null) return reply(T.noPrices(esc(sym)))
    kind = price > last ? "above" : "below"
    out = T.okPrice(sym, kind, px(price), px(last))
  }
  state.alerts[cid] = mine.filter(a => !(a.symbol === sym && a.kind === kind)).concat({ symbol: sym, kind, price })
  return reply(out, [[cb(T.bStop, `u:${sym}`)]])
}

// One message: changes `state` the way the website's run will (app/alerts.py), and gives the reply {text, kb}, or
// null for no reply.
export async function respond(state, update) {
  const msg = update.message || {}, chat = msg.chat || {}
  if (chat.type !== "private") return null
  const cid = String(chat.id)
  let text = (msg.text || "").trim()
  const subbed = cid in state.subs
  const m = START_RE.exec(text)
  if (m) {
    const code = m[1].length > CODE_LEN ? m[1].slice(0, CODE_LEN) : m[1]
    if (subbed || (await sha(code)).slice(0, 16) !== state.fp) return null
    state.subs[cid] = { weekly: true, lang: langOf(state, cid, msg) }
    const T = L(state.subs[cid].lang), app = appButton(state.info, state.subs[cid].lang)
    return reply(T.welcome, [[cb(T.bBuys, "b"), cb(T.bTop, "t")], ...(app ? [[app]] : [])])
  }
  if (!subbed) return null
  const lang = langOf(state, cid, msg), T = L(lang)
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
    return reply(pending[cid] === "watch" ? T.whichWatch : pending[cid] === "unwatch" ? T.whichUnwatch : T.which)
  }
  if (STOP_RE.test(text)) {
    delete state.subs[cid]
    delete state.alerts[cid]
    return reply(T.stopped)
  }
  const w = WEEKLY_RE.exec(text)
  if (w) {
    state.subs[cid].weekly = w[1].toLowerCase() !== "off"
    return reply(state.subs[cid].weekly ? T.weeklyOn : T.weeklyOff)
  }
  const q = QUIET_RE.exec(text)
  if (q) {
    state.subs[cid].quiet = (q[1] || "on").toLowerCase() === "on"
    return reply(state.subs[cid].quiet ? T.quietOn : T.quietOff)
  }
  const lg = LANG_RE.exec(text)
  if (lg) {
    const want = LANG_WORDS[(lg[1] || "").toLowerCase()] || (lang === "ar" ? "en" : "ar")
    state.subs[cid].lang = want
    return reply(L(want).langSet)
  }
  const answer = ask(state, cid, text, lang)
  if (answer !== undefined) return answer
  return text.startsWith("/") ? watch(state, cid, text, lang) : null
}

// The reply's text only (the tests, and anything that doesn't need the buttons).
export async function handle(state, update) {
  const r = await respond(state, update)
  return r ? r.text : null
}

// ------------------------------------------------------------------ your own portfolio, sent by your browser
// The website keeps each person's portfolio in their browser. Once linked (the Connect Telegram button, or /link and
// a code typed in Settings), that browser sends the bot a copy whenever it changes (POST /book): a summary for
// /portfolio and the whole record, which the website's run checks with the exit rules after each close (GET /books)
// and which another device of theirs can bring back (POST /restore).
const LINK_RE = /^\/link(?:@\w+)?\s*$/i
const UNLINK_RE = /^\/unlink(?:@\w+)?\s*$/i
const PORTFOLIO_RE = /^\/(?:portfolio|p)(?:@\w+)?\s*$/i
const WATCHLIST_RE = /^\/(?:watchlist|wl)(?:@\w+)?\s*$/i
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const LINK_MINUTES = 15
const MAX_BOOK = 1_000_000

// `fresh`: the website's run's check of the same positions at a newer close (their status, stop and last price).
export function portfolioText(book, info, lang = "en", fresh = null) {
  const T = L(lang), stocks = (info && info.stocks) || {}
  const newer = fresh && fresh.date > (book.date || "") ? Object.fromEntries(fresh.positions.map(p => [p.symbol, p])) : null
  let worth = book.cash
  const lines = book.positions.map(p0 => {
    const p = newer && newer[p0.symbol] ? { ...p0, ...newer[p0.symbol] } : p0
    const now = stocks[p.symbol], last = now && now.d >= (newer ? fresh.date : book.date || "") ? now.c : p.last
    worth += last * p.shares
    const move = last / p.avg - 1
    const flag = p.stop != null && last <= p.stop ? T.atStop : p.target != null && last >= p.target ? T.atTarget : ""
    return `<b>${esc(p.symbol)}</b> ${p.shares.toLocaleString("en-US")} × ${px(p.avg)} → ${px(last)} ` +
      `(${pct(move, true)}, ${move >= 0 ? "+" : "-"}${egp(Math.abs((last - p.avg) * p.shares))} EGP)${flag}\n` +
      `   ${esc(T.status(p.status || ""))}${p.stop != null ? ` · ${T.stopW} ${px(p.stop)}` : ""}` +
      `${p.target != null ? ` · ${T.targetW} ${px(p.target)}` : ""}` +
      (p.status && p.status !== "HOLD" && p.reason ? `\n   ${esc(T.note(p.reason))}` : "")
  })
  const head = [T.worth(egp(worth), book.start ? pct(worth / book.start - 1, true) : null),
    T.cash(egp(book.cash), book.positions.length)]
  if (book.closed && book.closed.count) head.push(T.closed(book.closed.count, pct(book.closed.win_rate),
    `${book.closed.total >= 0 ? "+" : "-"}${egp(Math.abs(book.closed.total))}`))
  return head.join("\n") + (lines.length ? "\n\n" + lines.join("\n") : "") +
    (newer ? T.fresh(T.day(fresh.date)) : T.foot(T.day(book.sent), T.day(info && info.scan)))
}

export function watchlistText(book, info, lang = "en") {
  const T = L(lang), stocks = (info && info.stocks) || {}
  if (!book.watchlist || !book.watchlist.length) return T.wlEmpty
  return T.wl + "\n" + book.watchlist.map(sym => {
    const s = stocks[sym]
    if (!s) return `<b>${esc(sym)}</b>`
    return `<b>${esc(sym)}</b> ${px(s.c)}${s.ch != null ? ` (${pct(s.ch, true)})` : ""}` +
      (s.a === "BUY" ? " · 🟢 BUY" : "") + (s.p10 != null ? T.wlChance(pct(s.p10)) : "")
  }).join("\n") + "\n\n" + T.wlFoot
}

// ------------------------------------------------------------------ on-time scans
// GitHub starts scheduled runs late, or not at all, when it's busy. After each close, every 10 minutes, the bot
// checks whether that close's scan has reached it; if not, at each of these times (minutes after midnight, Cairo) it
// asks GitHub to run the scan now. Holidays: the run finds no new prices and only rebuilds the site.
const SLOTS = [940, 970, 1000, 1060, 1150, 1270]      // 15:40, 16:10, 16:40, 17:40, 19:10, 21:10
const LAST_MINUTE = 1350                              // 22:30
const SESSION_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu"]

export function cairo(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
    .formatToParts(now).map(x => [x.type, x.value]))
  return { day: `${p.year}-${p.month}-${p.day}`, minute: +p.hour * 60 + +p.minute, weekday: p.weekday }
}

// The slot to ask for now ("2026-09-30 940"), or why not.
export function scanDue(info, now) {
  if (!SESSION_DAYS.includes(now.weekday)) return { why: "no session today" }
  if (now.minute > LAST_MINUTE) return { why: "too late today" }
  const slot = [...SLOTS].reverse().find(m => m <= now.minute)
  if (slot == null) return { why: "before the close's prices" }
  if (info && info.scan === now.day && info.final !== false) return { why: "today's scan is in" }
  return { key: `${now.day} ${slot}` }
}

// ------------------------------------------------------------------ the website inside Telegram (a mini app)
async function hmac(key, text) {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? new TextEncoder().encode(key) : key,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text)))
}
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("")

// Telegram signs what it tells the mini app about who opened it (core.telegram.org/bots/webapps): the user, if the
// signature is right and it's less than a day old.
export async function webAppUser(initData, botToken, now = Date.now()) {
  const p = new URLSearchParams(String(initData || "")), hash = p.get("hash")
  if (!hash) return null
  p.delete("hash")
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n")
  const sig = hex(await hmac(await hmac("WebAppData", botToken), check))
  let diff = sig.length ^ hash.length
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ hash.charCodeAt(i % hash.length)
  if (diff || now / 1000 - +p.get("auth_date") > 86400) return null
  try { return JSON.parse(p.get("user") || "null") } catch { return null }
}

// ------------------------------------------------------------------ the Worker
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } })
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS",
               "Access-Control-Allow-Headers": "content-type" }

async function telegram(env, method, params) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) })
  return r.json()
}

// The bot's menu, in English and Arabic (Telegram shows the one matching each person's app language).
const COMMANDS = {
  en: [["stock", "A stock's price, signal and chances"], ["buys", "Today's BUY signals"],
       ["top", "Best chances to reach the target"], ["portfolio", "Your positions and what to do"],
       ["watchlist", "The stocks you starred"], ["watch", "Alert me about a stock"], ["unwatch", "Stop a stock's alerts"],
       ["list", "My alerts"], ["quiet", "Only message me when there's something to do"],
       ["weekly", "The Thursday summary on or off"], ["lang", "العربية / English"], ["link", "Link your website portfolio"],
       ["unlink", "Unlink it"], ["help", "What I can do"], ["stop", "Stop all messages"]],
  ar: [["stock", "سعر السهم وإشارته وفرصه"], ["buys", "إشارات الشراء اليوم"], ["top", "أفضل فرص الوصول للهدف"],
       ["portfolio", "مراكزك وما تفعله"], ["watchlist", "الأسهم المميزة بنجمة"], ["watch", "نبّهني بخصوص سهم"],
       ["unwatch", "أوقف تنبيهات سهم"], ["list", "تنبيهاتي"], ["quiet", "راسلني فقط عندما يوجد ما أفعله"],
       ["weekly", "ملخص الخميس تشغيل أو إيقاف"], ["lang", "English / العربية"], ["link", "اربط محفظتك على الموقع"],
       ["unlink", "فك الربط"], ["help", "ما يمكنني فعله"], ["stop", "أوقف كل الرسائل"]],
}
const COMMANDS_VERSION = "2026-09-30"

// One Durable Object holds the data, so messages are handled one at a time, in order.
export class Bot {
  constructor(ctx, env) { this.ctx = ctx; this.env = env }

  async fetch(req) {
    const url = new URL(req.url), store = this.ctx.storage, env = this.env
    if (!env.SYNC_KEY || !env.BOT_TOKEN) return new Response("Not set up yet", { status: 503 })
    const hook = (await sha("hook:" + env.SYNC_KEY)).slice(0, 32)
    if (url.pathname === "/telegram") {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== hook) return new Response("", { status: 403 })
      let update = await req.json()
      const base = await store.get("state"), log = (await store.get("log")) || []
      if (!base || update.update_id <= base.seen || log.some(u => u.update_id === update.update_id)) return json({})
      const cq = update.callback_query
      if (cq) {                                            // a button: the command it stands for, from that person
        await telegram(env, "answerCallbackQuery", { callback_query_id: cq.id }).catch(() => null)
        const text = callbackText(cq.data)
        if (!text || !cq.message) return json({})
        update = { update_id: update.update_id, message: { message_id: cq.message.message_id, chat: cq.message.chat,
                                                           from: cq.from, date: Math.floor(Date.now() / 1000), text } }
      }
      if (!update.message) return json({})
      const state = structuredClone(base)
      for (const u of log) await respond(state, u)         // what's happened since the website's last run
      const linked = await this.noteStart(state, update)
      let out = (await this.personal(state, update)) ?? await respond(state, update)
      const lang = langOf(state, String((update.message.chat || {}).id), update.message)
      if (linked) out = out ? { ...out, text: out.text + L(lang).linkedToo } : reply(L(lang).linkedOnly)
      await store.put("log", log.concat(update))
      if (out) await this.send(update.message.chat.id, out)
      return json({})
    }
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS })
    if (req.method === "POST" && ["/pair", "/book", "/restore", "/miniapp", "/started", "/unpair"].includes(url.pathname)) {
      if (url.pathname === "/book") return this.book(await req.text())
      const body = await req.json().catch(() => ({}))
      if (url.pathname === "/pair") return this.pair(body)
      if (url.pathname === "/restore") return this.restore(body)
      if (url.pathname === "/miniapp") return this.miniapp(body)
      if (url.pathname === "/started") return this.started(body)
      const cid = await this.owner(body.token)
      if (cid) await this.forget(cid)
      return json({ ok: true })
    }
    if (req.headers.get("Authorization") !== `Bearer ${env.SYNC_KEY}`) return new Response("", { status: 403 })
    if (url.pathname === "/updates") return json({ updates: (await store.get("log")) || [] })
    if (url.pathname === "/books") return this.books()
    if (url.pathname === "/tick") return this.tick()
    if (url.pathname === "/state" && req.method === "POST") {
      const state = await req.json()
      await store.put("state", state)
      await store.put("log", ((await store.get("log")) || []).filter(u => u.update_id > state.seen))
      const want = `${url.origin}/telegram`, info = await telegram(env, "getWebhookInfo", {})
      if (info.result?.url !== want || !(info.result?.allowed_updates || []).includes("callback_query")) {
        const set = await telegram(env, "setWebhook", { url: want, secret_token: hook,
                                                        allowed_updates: ["message", "callback_query"] })
        if (!set.ok) return json({ ok: false, error: set.description || "setWebhook failed" }, 502)
      }
      if ((await store.get("commands")) !== COMMANDS_VERSION) {
        for (const [lang, list] of Object.entries(COMMANDS)) {
          await telegram(env, "setMyCommands", { commands: list.map(([command, description]) => ({ command, description })),
                                                 ...(lang === "en" ? {} : { language_code: lang }) })
        }
        await store.put("commands", COMMANDS_VERSION)
      }
      return json({ ok: true, dispatch: (await store.get("dispatch")) || null })
    }
    return new Response("", { status: 404 })
  }

  async send(chatId, out) {
    await telegram(this.env, "sendMessage", { chat_id: chatId, text: out.text, parse_mode: "HTML",
      link_preview_options: { is_disabled: true }, ...(out.kb ? { reply_markup: { inline_keyboard: out.kb } } : {}) })
      .catch(() => null)                                   // only a courtesy: the run still applies the command
  }

  // "/start <site code><browser's link>" (the website's Connect Telegram button) links that browser. Any other
  // /start (your Mac's own Connect link) is noted for the Mac to find (POST /started).
  async noteStart(state, update) {
    const msg = update.message || {}, chat = msg.chat || {}, m = START_RE.exec((msg.text || "").trim())
    if (!m || chat.type !== "private") return false
    const cid = String(chat.id), code = m[1].slice(0, CODE_LEN), nonce = m[1].slice(CODE_LEN)
    if (m[1].length > CODE_LEN && (await sha(code)).slice(0, 16) === state.fp) {
      if (!NONCE_RE.test(nonce)) return false
      await this.addToken(cid, nonce)
      return true
    }
    if ((await sha(m[1])).slice(0, 16) === state.fp) return false         // the site's plain link
    const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || ""
    await this.ctx.storage.put("start:" + await sha(m[1]), { id: cid, name, at: Date.now() })
    return false
  }

  async addToken(cid, token) {
    const store = this.ctx.storage, hash = await sha(token), toks = (await store.get("links:" + cid)) || []
    await store.put("tok:" + hash, cid)
    const keep = [...toks.filter(t => t !== hash), hash]
    await store.put("links:" + cid, keep.slice(-8))                           // up to 8 browsers
    if (keep.length > 8) await store.delete(keep.slice(0, -8).map(t => "tok:" + t))
  }

  // /link, /unlink, /portfolio and /watchlist: a reply, or null for everything else.
  async personal(state, update) {
    const msg = update.message || {}, chat = msg.chat || {}, text = (msg.text || "").trim(), cid = String(chat.id)
    if (chat.type !== "private" || !(cid in state.subs)) return null
    const store = this.ctx.storage, lang = langOf(state, cid, msg), T = L(lang)
    if (LINK_RE.test(text)) {
      const bytes = crypto.getRandomValues(new Uint8Array(8))
      const code = [...bytes].map(b => CODE_CHARS[b % CODE_CHARS.length]).join("")
      await store.put("pair:" + code, { cid, until: Date.now() + LINK_MINUTES * 60000 })
      return reply(T.linkCode(code, LINK_MINUTES))
    }
    if (UNLINK_RE.test(text)) {
      await this.forget(cid)
      return reply(T.unlinked)
    }
    if (PORTFOLIO_RE.test(text) || WATCHLIST_RE.test(text)) {
      const book = await store.get("book:" + cid)
      if (!book) return reply(T.notLinked)
      const mine = PORTFOLIO_RE.test(text), app = appButton(state.info, lang, mine ? "portfolio" : "watchlist")
      return mine
        ? reply(portfolioText(book, state.info, lang, state.mine && state.mine[cid]), app ? [[app]] : null)
        : reply(watchlistText(book, state.info, lang), [...symbolButtons((book.watchlist || []).slice(0, 12)),
                                                        ...(app ? [[app]] : [])])
    }
    if (STOP_RE.test(text)) await this.forget(cid)       // /stop deletes the copy too; the usual reply follows
    return null
  }

  async owner(token) {
    return typeof token === "string" && token.length >= 32 ? this.ctx.storage.get("tok:" + await sha(token)) : undefined
  }

  async forget(cid) {
    const store = this.ctx.storage, toks = (await store.get("links:" + cid)) || [], mini = await store.get("mini:" + cid)
    await store.delete(["book:" + cid, "full:" + cid, "links:" + cid, "mini:" + cid,
                        ...toks.map(t => "tok:" + t), ...(mini ? ["tok:" + mini] : [])])
  }

  async pair(body) {
    const store = this.ctx.storage, code = String(body.code || "").trim().toUpperCase()
    const p = /^[A-Z0-9]{8}$/.test(code) ? await store.get("pair:" + code) : null
    if (!p || p.until < Date.now()) return json({ error: "That code isn't right or has expired. Send /link to the bot for a new one." }, 400)
    await store.delete("pair:" + code)
    const token = [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, "0")).join("")
    await this.addToken(p.cid, token)
    const state = await store.get("state"), lang = state ? langOf(state, p.cid) : "en"
    await telegram(this.env, "sendMessage", { chat_id: p.cid, parse_mode: "HTML", text: L(lang).linkDone }).catch(() => null)
    return json({ token })
  }

  // The browser's copy: a summary (for /portfolio) and, from newer pages, the whole record. A device holding an
  // older record than the one kept (another device changed it since) is told so, and brings the newer one back.
  async book(raw) {
    if (raw.length > MAX_BOOK) return json({ error: "Too big" }, 413)
    let body
    try { body = JSON.parse(raw) } catch { return json({ error: "Bad request" }, 400) }
    const cid = await this.owner(body.token), b = body.book, store = this.ctx.storage
    if (!cid) return json({ error: "Not linked" }, 401)
    if (!b || !Array.isArray(b.positions) || typeof b.cash !== "number") return json({ error: "Bad request" }, 400)
    const sent = new Date().toISOString().slice(0, 10)
    if (body.full) {
      if (!Array.isArray(body.full.trades)) return json({ error: "Bad request" }, 400)
      const changed = String(body.changed || ""), have = await store.get("full:" + cid)
      if (have && have.changed > changed) return json({ error: "Newer on another device", changed: have.changed }, 409)
      await store.put("full:" + cid, { book: body.full, changed, sent })
    }
    await store.put("book:" + cid, { ...b, sent })
    return json({ ok: true })
  }

  async restore(body) {
    const cid = await this.owner(body.token)
    if (!cid) return json({ error: "Not linked" }, 401)
    const have = await this.ctx.storage.get("full:" + cid)
    return json(have ? { book: have.book, changed: have.changed, sent: have.sent } : { book: null })
  }

  // For the website's run: each linked person's whole record, to check their positions after the close (the run
  // keeps only the people still connected).
  async books() {
    const out = {}
    for (const [key, v] of await this.ctx.storage.list({ prefix: "full:" })) out[key.slice(5)] = v.book
    return json({ books: out })
  }

  // The mini app, opened from a button in Telegram: someone connected gets the site's key (no password to type)
  // and their own link, so their portfolio follows them between Telegram and their browsers.
  async miniapp(body) {
    const user = await webAppUser(body.initData, this.env.BOT_TOKEN), cid = user && String(user.id)
    const state = structuredClone(await this.ctx.storage.get("state"))
    for (const u of (state && (await this.ctx.storage.get("log"))) || []) await respond(state, u)  // joined since the run
    if (!cid || !state || !(cid in state.subs)) return json({ error: "Press Connect Telegram on the website first." }, 403)
    if (!state.sitekey) return json({ error: "The website's key hasn't reached the bot yet." }, 503)
    const token = hex(await hmac(this.env.SYNC_KEY, "mini:" + cid)), hash = await sha(token)
    await this.ctx.storage.put("tok:" + hash, cid)
    await this.ctx.storage.put("mini:" + cid, hash)
    return json({ key: state.sitekey, token })
  }

  // Your Mac's Connect Telegram: Telegram hands the messages only to this Worker now, so the Mac asks here who
  // pressed Start through its link. Each is kept a day and answered once.
  async started(body) {
    const code = String(body.code || "")
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(code)) return json({ error: "Bad request" }, 400)
    const key = "start:" + await sha(code), hit = await this.ctx.storage.get(key)
    if (!hit || Date.now() - hit.at > 86400000) return json({ found: false })
    await this.ctx.storage.delete(key)
    return json({ found: true, id: hit.id, name: hit.name })
  }

  async tick(now = new Date()) {
    const env = this.env, store = this.ctx.storage
    if (!env.GH_TOKEN || !env.GITHUB_REPO) return json({ ok: false, why: "no GitHub key" })
    const state = await store.get("state"), due = scanDue(state && state.info, cairo(now))
    if (!due.key) return json({ ok: true, why: due.why })
    const last = await store.get("dispatch")
    if (last && last.key === due.key) return json({ ok: true, why: "asked already" })
    const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/site.yml/dispatches`, {
      method: "POST", body: JSON.stringify({ ref: "main", inputs: { force_scan: "false" } }),
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "egx-bot",
                 "X-GitHub-Api-Version": "2022-11-28", "content-type": "application/json" } })
    await store.put("dispatch", { key: due.key, at: now.toISOString(), status: r.status })
    return json({ ok: r.status === 204, status: r.status })
  }
}

export default {
  fetch(req, env) {
    return env.BOT.get(env.BOT.idFromName("bot")).fetch(req)
  },
  // Every 10 minutes (wrangler.toml): only the evening hours can need a scan, so the rest return at once.
  scheduled(event, env, ctx) {
    const hour = new Date(event.scheduledTime).getUTCHours()
    if (hour < 12 || hour > 20 || !env.SYNC_KEY) return
    ctx.waitUntil(env.BOT.get(env.BOT.idFromName("bot")).fetch("https://bot/tick",
      { method: "POST", headers: { Authorization: `Bearer ${env.SYNC_KEY}` } }))
  },
}
