// The website's Telegram bot, answering at once (a Cloudflare Worker). Telegram hands every message here the moment
// it's sent and the reply goes straight back. The website's run (app/site_daily.py) stays in charge: it picks up the
// messages from here (GET /updates), applies them to its data, and sends back who's connected and their alerts
// (POST /state). Secrets (set with wrangler): BOT_TOKEN (from @BotFather), SYNC_KEY (= the WORKER_KEY GitHub secret)
// and, for on-time scans, GH_TOKEN (a GitHub key that can only start this repository's runs).
// Keep the replies in step with app/alerts.py.

const WATCH_RE = /^\/watch(?:@\w+)?\s+([A-Za-z0-9]{2,12})(?:\s+([0-9]+(?:[.,][0-9]+)?|levels))?\s*$/i
const UNWATCH_RE = /^\/unwatch(?:@\w+)?\s+([A-Za-z0-9]{2,12})(?:\s+(buy|levels))?\s*$/i   // a kind: only that alert
const LIST_RE = /^\/(?:list|alerts)(?:@\w+)?\s*$/i
const WEEKLY_RE = /^\/weekly(?:@\w+)?\s+(on|off)\s*$/i
const QUIET_RE = /^\/quiet(?:@\w+)?(?:\s+(on|off))?\s*$/i
const MORNING_RE = /^\/morning(?:@\w+)?(?:\s+(on|off))?\s*$/i
const WHY_RE = /^\/why(?:@\w+)?\s+(.+)$/i
const LANG_RE = /^\/lang(?:@\w+)?(?:\s+(\S+))?\s*$/i
const START_RE = /^\/start\s+([A-Za-z0-9_-]{8,64})\s*$/
const BELL_RE = /^\/start\s+watch-([A-Za-z0-9]{2,12})\s*$/i   // the website's bell (Picks): /watch SYMBOL
const STOP_RE = /^\/stop(@\w+)?\s*$/
const STOCK_RE = /^(?:\/(?:stock|s)(?:@\w+)?\s+)?([A-Za-z0-9]{2,12})\s*$/i
const ASK_RE = /^\/(?:stock|s)(?:@\w+)?\s+(.+)$/i
const TOP_RE = /^\/top(?:@\w+)?(?:\s+(10|20))?\s*$/i
const BUYS_RE = /^\/(?:buys|signals)(?:@\w+)?\s*$/i
const WEEK_RE = /^\/(?:week|next)(?:@\w+)?\s*$/i
const EGX30_RE = /^\/(?:egx30|index)(?:@\w+)?\s*$/i
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
  help: "💬 <b>Ask about any stock</b>\nSend its symbol (COMI) or part of its Arabic name (التجاري).\n\n" +
    "📊 <b>The market</b>\n" +
    "/week · next week's best chances (target before stop, within 5 sessions)\n" +
    "/top · the 10 best chances in 10 days (/top 20: in 20 days)\n" +
    "/buys · today's BUY signals\n" +
    "/why COMI · why it is or isn't a BUY, its rating and levels\n" +
    "/egx30 · the index in brief\n" +
    "📷 Send a screenshot of your broker's holdings to check it against the website\n\n" +
    "🔔 <b>Alerts</b> (checked after each close)\n" +
    "/watch COMI · when it gets a BUY signal\n" +
    "/watch COMI 45 · when it closes above 45 (or below, if 45 is under its price)\n" +
    "/watch COMI levels · near a strong support or at resistance\n" +
    "/unwatch COMI · stop its alerts (/unwatch all: every alert)\n" +
    "/list · your alerts\n\n" +
    "💼 <b>Your portfolio</b> (from the website)\n" +
    "/portfolio · your positions, profit and what to do\n" +
    "/watchlist · the stocks you starred\n" +
    "/link · connect it (once) · /unlink · disconnect\n\n" +
    "✉️ <b>Messages</b>\n" +
    "/quiet · only on days with a BUY or something to do (/quiet off: every close)\n" +
    "/morning off · no 9:30 reminder (/morning on: back)\n" +
    "/weekly off · no Thursday summary (/weekly on: back)\n" +
    "/lang ar · بالعربية\n" +
    "/stop · stop all messages",
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
  morningOn: "OK: on session days I'll remind you at 9:30 what to do at the open, when there's something to do.",
  morningOff: "OK: no morning reminder. /morning on to have it again.",
  langSet: "OK: I'll answer in English. /lang ar for Arabic.",
  rating: (g, n) => `⭐ <b>Rating ${g}/100</b>\nWhere the model's 2-week chance puts it among the ${n} liquid stocks it ` +
    "rates today, from its chart and the company's results (100 = its first).",
  co: { head: "🏢 <b>Company</b>", lost: "lost money over the last year", profit: g => `profit ${g} in a year`,
        sales: g => `sales ${g}`, pe: (pe, sec) => `P/E ${pe}${sec ? ` (sector ${sec})` : ""}` },
  band: (lo, hi, hit, base, ret) => `In its tests, stocks rated ${lo}–${hi} reached the target before the stop ${hit} ` +
    `of the time${base ? ` (the average stock ${base})` : ""}${ret ? `, ${ret} a trade after fees` : ""}.`,
  noRating: "No rating: the model rates only stocks with enough daily trading.",
  checks: "✅ <b>The BUY rule's checks</b>",
  notBuy: "❌ <b>Not a BUY today</b> · the BUY rule's checks",
  check: [m => `Liquid: at least ${m}M EGP traded a day, a year of history`,
          () => "Uptrend: above its 20- and 50-day averages",
          h => `Breakout: a close above its 20-day high (${h})`,
          v => `Volume at least 1.5× normal (last session ${v}×)`,
          a => `Trend strength ADX above 20 (now ${a})`],
  whyFoot: "Rules and a model, not advice.",
  bWhy: "❓ Why",
  head: (c, ch, d) => `💰 <b>${c}</b>${ch} · close of ${d}`,
  sigBuy: "🟢 <b>BUY</b>",
  sigNear: "👀 <b>Near a buy</b>",
  noSignal: "⚪ <b>No signal today</b>",
  planBuy: (e, s, t) => `Buy up to <b>${e}</b> · stop ${s} · target ${t}`,
  planNear: (e, s, t) => `If it triggers: up to ${e} · stop ${s} · target ${t}`,
  hBest: "🎯 <b>Best way in</b>",
  bestHow: (how, p, away) => `${how === "d" ? "On a dip to about" : "On a close above"} <b>${p}</b> (${away})`,
  stopTgt: (s, t) => `Stop ${s} · target ${t}`,
  rr: r => `${r}× reward for the risk`,
  notUp: "⚠️ Not in an uptrend yet: a price to watch, not a buy.",
  hWeek: "📅 <b>Next week</b>",
  wkChance: (p, tgt, stop, rank) => `${p} chance to reach ${tgt} before ${stop} · rank ${rank}`,
  hChance: "🎲 <b>Chance to reach the target</b>",
  inDays: (hz, p, rank, x) => `${hz} days: ${p} · rank ${rank}${x ? ` · expected ${x}` : ""}`,
  hChart: "📊 <b>Chart</b>",
  supRes: (a, b) => `Support ${a} · resistance ${b}`,
  levelsTip: sym => `/watch ${sym} levels: an alert when it nears support or resistance`,
  top: (hz, d) => `🏆 <b>Best chances in ${hz} days</b> · ${d}\n<i>to reach the target before the stop</i>`,
  expected: x => ` · expected ${x}`,
  topFoot: "<i>Chances from the website's model, not advice. Tap a stock for more.</i>",
  noPred: "No predictions yet.",
  noBuys: d => `⚪ <b>No BUY signals</b> at the ${d} close.`,
  buys: d => `🟢 <b>BUY signals</b> · ${d} close`,
  buyLine: (sym, name, e, s, t) => `<b>${sym}</b>${name}\nBuy up to <b>${e}</b> · stop ${s} · target ${t}`,
  buysFoot: "<i>Your share counts are on the website.</i>",
  alertBuy: s => `${s}: a BUY signal`,
  alertLevels: s => `${s}: near support or resistance`,
  alertPrice: (s, k, p) => `${s}: a close ${k} ${p}`,
  noAlerts: "You have no alerts yet.\n\n",
  yourAlerts: "🔔 <b>Your alerts</b>",
  removedAll: n => n ? `Removed all your alerts (${n}).` : "You have no alerts.",
  removed: (n, s) => n ? `Removed ${n} alert${n !== 1 ? "s" : ""} for ${s}.` : `You have no alert for ${s}.`,
  tooMany: m => `You already have ${m} alerts. Remove some with /unwatch first.`,
  okBuy: s => `OK: I'll tell you when ${s} gets a BUY signal, after any close.`,
  okLevels: s => `OK: I'll tell you when ${s} closes near a strong support or reaches resistance ` +
    "(the levels on its page on the website).",
  noPrices: s => `There are no prices for ${s} yet, so I can't watch its price.`,
  okPrice: (s, k, p, last) => `OK: I'll tell you when ${s} closes ${k} ${p} (last close ${last}).`,
  bBellOn: "🔔 BUY alert: on (tap to stop)", bBellOff: "🔕 Tell me when it's a BUY",
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
  worth: (w, since) => `💼 <b>Your portfolio</b>\n<b>${w} EGP</b>${since ? ` · ${since} since the start` : ""}`,
  cash: (c, n) => `Cash ${c} EGP · ${n} open position${n === 1 ? "" : "s"}`,
  closed: (n, w, t) => `Closed trades: ${n} · ${w} won · ${t} EGP`,
  atStop: " ⚠️ at or under your stop", atTarget: " 🎯 at your target",
  stopW: "Stop", targetW: "target", egpW: "EGP",
  status: s => ({ EXIT: "Sell", BOUNCE: "Sell on a bounce", REVIEW: "Consider selling", "TIGHTEN STOP": "Raise your stop",
                  HOLD: "Hold", ADJUST: "Update your shares", "NO DATA": "No price yet" })[s] || s,
  note: s => s,
  foot: (sent, scan) => `\n\n<i>Sent by your browser on ${sent}; prices from the ${scan} close. ` +
    "Open the website to update the exit rules.</i>",
  fresh: scan => `\n\n<i>Checked with the exit rules at the ${scan} close.</i>`,
  wlEmpty: "Your watchlist is empty. Star stocks (☆) on the website.",
  wl: "⭐ <b>Your watchlist</b>",
  wlChance: p => ` · ${p} chance in 10 days`,
  wlFoot: "<i>🔔 = a message when it gets a BUY. Tap a bell to turn it on or off, or a stock for more.</i>",
  bOn: "🔔 On", bOff: "🔕 Off",
  // next week (the website's Predictions → Next week)
  bWeek: "📅 Next week", bX30: "📈 EGX30",
  week: d => `📅 <b>Next week's best chances</b> · from the ${d} close`,
  weekLine: (i, sym, p, tgt, up, stop, strong) => `${i}. <b>${sym}</b> · ${p}${strong ? " · 💪 Strong" : ""}\n` +
    `      target ${tgt} (+${up}) · stop ${stop}`,
  weekWeak: "⚠️ <b>Weak market</b>: fewer than 40% of stocks are above their 50-day average. Better to skip short " +
    "trades this week.",
  weekFoot: (strong, all) => "<i>Chance: it rises to the target (1.5× its daily range) before it falls as far to the " +
    "stop, within 5 sessions." + (strong ? ` In its tests, strong picks (its top 10%, in an uptrend, while the market ` +
    `is healthy) got there first ${strong} of the time, the average stock ${all}.` : "") + " Always use the stop. Not advice.</i>",
  // EGX30 (the website's Home → EGX30)
  x30: (c, move, d) => `📈 <b>EGX30</b> · ${d}\n💰 <b>${c}</b>${move}`,
  x30Ret: r => `📊 <b>Returns</b>\nWeek ${r["1W"]} · month ${r["1M"]}\nThis year ${r.YTD} · a year ${r["1Y"]}`,
  x30Usd: (y, yr) => `In dollars: this year ${y} · a year ${yr}`,
  x30Range: (lo, hi, ath) => `📏 <b>1-year range</b>\n${lo} – ${hi} · ${ath ? `${ath} under its record` : "at its record"}`,
  x30Up: e => `🟢 <b>Above its 50-day average</b> (${e})\nThe BUY rules are on.`,
  x30Down: (e, blk) => `🔴 <b>Under its 50-day average</b> (${e})` + (blk ? "\nThe agent makes no new BUYs." : ""),
  x30Breadth: b => `${b} of stocks are above their own 50-day average.`,
  // a broker screenshot sent here, against the website's portfolio
  shotReading: "📷 Reading your screenshot…",
  shotNone: "I found no holdings on that picture. Send a screenshot of your broker's list of stocks or a stock's screen.",
  shotFail: "I couldn't read that picture just now. Try again in a minute.",
  shotLimit: n => `That's ${n} pictures today. Try again tomorrow.`,
  shotHead: "📷 <b>Your screenshot against your website portfolio</b>\n",
  shotSame: (sym, paid) => `✅ <b>${sym}</b> matches: you paid ${paid} EGP, fees in`,
  shotSameShares: (sym, n) => `✅ <b>${sym}</b>: the same ${n} shares`,
  shotDiff: (sym, them, site) => `⚠️ <b>${sym}</b>: you paid ${them} EGP on the picture, ${site} EGP on the website`,
  shotShares: (sym, them, site) => `⚠️ <b>${sym}</b>: ${them} shares on the picture, ${site} on the website`,
  shotMissing: (sym, v, pl) => `➕ <b>${sym}</b> isn't on the website (${v} worth, ${pl} EGP)`,
  shotOnly: syms => `Only on the website: ${syms}`,
  shotFoot: missing => "<i>" + (missing ? "To add them: the website → My Portfolio → From a screenshot. " : "") +
    "To fix one: the website → My Portfolio → Sell or edit. What you paid is the market value − the profit/loss, so " +
    "the price moving since doesn't count.</i>",
}

const days = n => (n <= 10 ? `${n} أيام` : `${n} يومًا`)     // Arabic: 3–10 take the plural, 11+ the singular

const AR = {
  day: d => d ? `${+d.slice(8, 10)} ${MONTHS_AR[+d.slice(5, 7) - 1]}` : "–",
  welcome: "✅ <b>تم الاتصال.</b> بعد كل إغلاق للبورصة المصرية ستصلك إشارات اليوم هنا. عدد الأسهم لكل صفقة على الموقع.\n" +
    "أرسل /help لتعرف ما يمكنني فعله، أو /stop للإيقاف.",
  linkedToo: "\n\n🔗 وتم ربط محفظتك على الموقع أيضًا: بعد كل إغلاق سأخبرك بما تفعله في مراكزك. /portfolio في أي وقت.",
  linkedOnly: "🔗 <b>تم ربط محفظة هذا المتصفح.</b> بعد كل إغلاق سأخبرك بما تفعله في مراكزك. /portfolio في أي وقت.",
  stopped: "تم الإيقاف. للبدء من جديد افتح الموقع ← الإعدادات ← ربط تيليجرام.",
  help: "💬 <b>اسأل عن أي سهم</b>\nأرسل رمزه (COMI) أو جزءًا من اسمه (التجاري).\n\n" +
    "📊 <b>السوق</b>\n" +
    "/week · أفضل فرص الأسبوع القادم (الهدف قبل الوقف خلال 5 جلسات)\n" +
    "/top · أفضل 10 فرص خلال 10 أيام (/top 20: خلال 20 يومًا)\n" +
    "/buys · إشارات الشراء اليوم\n" +
    "/why COMI · لماذا هو إشارة شراء أو لا، وتقييمه ومستوياته\n" +
    "/egx30 · المؤشر باختصار\n" +
    "📷 أرسل صورة لأسهمك في تطبيق السمسرة لأقارنها بالموقع\n\n" +
    "🔔 <b>التنبيهات</b> (تُفحص بعد كل إغلاق)\n" +
    "/watch COMI · عندما يحصل على إشارة شراء\n" +
    "/watch COMI 45 · عندما يغلق فوق 45 (أو تحته إذا كان 45 أقل من سعره)\n" +
    "/watch COMI levels · قرب دعم قوي أو عند مقاومة\n" +
    "/unwatch COMI · إيقاف تنبيهاته (/unwatch all: كل التنبيهات)\n" +
    "/list · تنبيهاتك\n\n" +
    "💼 <b>محفظتك</b> (من الموقع)\n" +
    "/portfolio · مراكزك وأرباحك وما تفعله\n" +
    "/watchlist · الأسهم التي ميّزتها بنجمة\n" +
    "/link · ربطها (مرة واحدة) · /unlink · فك الربط\n\n" +
    "✉️ <b>الرسائل</b>\n" +
    "/quiet · فقط في الأيام التي فيها إشارة شراء أو شيء تفعله (/quiet off: بعد كل إغلاق)\n" +
    "/morning off · بدون تذكير 9:30 (/morning on: لإعادته)\n" +
    "/weekly off · بدون ملخص الخميس (/weekly on: لإعادته)\n" +
    "/lang en · English\n" +
    "/stop · إيقاف كل الرسائل",
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
  morningOn: "تم: في أيام الجلسات سأذكّرك الساعة 9:30 بما تفعله عند الافتتاح، إذا كان هناك ما تفعله.",
  morningOff: "تم: بدون تذكير صباحي. /morning on لإعادته.",
  rating: (g, n) => `⭐ <b>التقييم ${g}/100</b>\nترتيب فرصة النموذج خلال أسبوعين بين ${n} سهمًا سائلًا يقيّمها اليوم، من الرسم البياني ونتائج الشركة (100 = الأول).`,
  co: { head: "🏢 <b>الشركة</b>", lost: "خسرت خلال آخر سنة", profit: g => `الأرباح ${g} خلال سنة`,
        sales: g => `المبيعات ${g}`, pe: (pe, sec) => `مكرر الربحية ${pe}${sec ? ` (القطاع ${sec})` : ""}` },
  band: (lo, hi, hit, base, ret) => `في اختباراته، الأسهم المقيّمة ${lo}–${hi} وصلت إلى الهدف قبل الوقف في ${hit} من المرات` +
    `${base ? ` (متوسط الأسهم ${base})` : ""}${ret ? `، و${ret} للصفقة بعد الرسوم` : ""}.`,
  noRating: "بدون تقييم: يقيّم النموذج الأسهم ذات التداول اليومي الكافي فقط.",
  checks: "✅ <b>شروط قاعدة الشراء</b>",
  notBuy: "❌ <b>ليست إشارة شراء اليوم</b> · شروط قاعدة الشراء",
  check: [m => `السيولة: تداول ${m} مليون جنيه يوميًا على الأقل، وسنة من التاريخ`,
          () => "اتجاه صاعد: فوق متوسطي 20 و50 يومًا",
          h => `اختراق: إغلاق فوق أعلى سعر في 20 يومًا (${h})`,
          v => `حجم تداول 1.5 ضعف المعتاد على الأقل (آخر جلسة ${v}×)`,
          a => `قوة الاتجاه ADX فوق 20 (الآن ${a})`],
  whyFoot: "قواعد ونموذج، وليست نصيحة.",
  bWhy: "❓ لماذا",
  langSet: "تم: سأرد بالعربية. /lang en للإنجليزية.",
  head: (c, ch, d) => `💰 <b>${c}</b>${ch} · إغلاق ${d}`,
  sigBuy: "🟢 <b>شراء</b>",
  sigNear: "👀 <b>قريب من الشراء</b>",
  noSignal: "⚪ <b>لا توجد إشارة اليوم</b>",
  planBuy: (e, s, t) => `اشترِ حتى <b>${e}</b> · الوقف ${s} · الهدف ${t}`,
  planNear: (e, s, t) => `إذا تحققت الإشارة: حتى ${e} · الوقف ${s} · الهدف ${t}`,
  hBest: "🎯 <b>أفضل دخول</b>",
  bestHow: (how, p, away) => `${how === "d" ? "عند الهبوط إلى نحو" : "عند إغلاق فوق"} <b>${p}</b> (${away})`,
  stopTgt: (s, t) => `الوقف ${s} · الهدف ${t}`,
  rr: r => `عائد ${r}× مقابل المخاطرة`,
  notUp: "⚠️ ليس في اتجاه صاعد بعد: سعر للمتابعة، لا للشراء.",
  hWeek: "📅 <b>الأسبوع القادم</b>",
  wkChance: (p, tgt, stop, rank) => `فرصة ${p} للوصول إلى ${tgt} قبل ${stop} · الترتيب ${rank}`,
  hChance: "🎲 <b>فرصة الوصول إلى الهدف</b>",
  inDays: (hz, p, rank, x) => `${days(hz)}: ${p} · الترتيب ${rank}${x ? ` · المتوقع ${x}` : ""}`,
  hChart: "📊 <b>الرسم البياني</b>",
  supRes: (a, b) => `الدعم ${a} · المقاومة ${b}`,
  levelsTip: sym => `/watch ${sym} levels: تنبيه عندما يقترب من الدعم أو المقاومة`,
  top: (hz, d) => `🏆 <b>أفضل الفرص خلال ${days(hz)}</b> · ${d}\n<i>للوصول إلى الهدف قبل الوقف</i>`,
  expected: x => ` · المتوقع ${x}`,
  topFoot: "<i>فرص من نموذج الموقع، وليست نصيحة. اضغط على سهم للمزيد.</i>",
  noPred: "لا توجد توقعات بعد.",
  noBuys: d => `⚪ <b>لا توجد إشارات شراء</b> عند إغلاق ${d}.`,
  buys: d => `🟢 <b>إشارات الشراء</b> · إغلاق ${d}`,
  buyLine: (sym, name, e, s, t) => `<b>${sym}</b>${name}\nاشترِ حتى <b>${e}</b> · الوقف ${s} · الهدف ${t}`,
  buysFoot: "<i>عدد الأسهم لكل صفقة على الموقع.</i>",
  alertBuy: s => `${s}: إشارة شراء`,
  alertLevels: s => `${s}: قرب الدعم أو المقاومة`,
  alertPrice: (s, k, p) => `${s}: إغلاق ${k === "above" ? "فوق" : "تحت"} ${p}`,
  noAlerts: "ليس لديك تنبيهات بعد.\n\n",
  yourAlerts: "🔔 <b>تنبيهاتك</b>",
  removedAll: n => n ? `تم حذف كل تنبيهاتك (${n}).` : "ليس لديك تنبيهات.",
  removed: (n, s) => n ? `تم حذف ${n} تنبيه لـ ${s}.` : `ليس لديك تنبيه لـ ${s}.`,
  tooMany: m => `لديك ${m} تنبيهًا بالفعل. احذف بعضها بـ /unwatch أولًا.`,
  okBuy: s => `تم: سأخبرك عندما يحصل ${s} على إشارة شراء بعد أي إغلاق.`,
  okLevels: s => `تم: سأخبرك عندما يغلق ${s} قرب دعم قوي أو يصل إلى مقاومة (المستويات في صفحته على الموقع).`,
  noPrices: s => `لا توجد أسعار لـ ${s} بعد، فلا يمكنني متابعة سعره.`,
  okPrice: (s, k, p, last) => `تم: سأخبرك عندما يغلق ${s} ${k === "above" ? "فوق" : "تحت"} ${p} (آخر إغلاق ${last}).`,
  bBellOn: "🔔 تنبيه الشراء: مفعّل (اضغط للإيقاف)", bBellOff: "🔕 نبّهني عند إشارة الشراء",
  bBuy: "🔔 تنبيه شراء", bLevels: "📍 تنبيه المستويات", bStop: "🔕 إيقاف تنبيهاته", bApp: "📱 افتح التطبيق",
  bBuys: "🟢 شراء اليوم", bTop: "🏆 أفضل الفرص",
  linkCode: (code, mins) => `الكود: <code>${code}</code>\nعلى الموقع: الإعدادات ← <b>محفظتك في تيليجرام</b> ← اكتبه واضغط ربط. ` +
    `يعمل مرة واحدة لمدة ${mins} دقيقة.\nبعدها يرسل لي الموقع محفظتك كلما تغيّرت، فيجيب /portfolio و/watchlist هنا، ` +
    "وبعد كل إغلاق أخبرك بما تفعله في مراكزك. /unlink للإيقاف.",
  linkDone: "✅ <b>تم ربط محفظتك.</b> أرسل /portfolio أو /watchlist في أي وقت.",
  unlinked: "تم فك الربط: حذفت نسختي من محفظتك. الموقع يحتفظ بها كما كان.",
  notLinked: "محفظتك غير مربوطة بعد. افتح الموقع ← الإعدادات ← ربط تيليجرام، أو أرسل /link.",
  worth: (w, since) => `💼 <b>محفظتك</b>\n<b>${w} جنيه</b>${since ? ` · ${since} منذ البداية` : ""}`,
  cash: (c, n) => `النقدية ${c} جنيه · ${n} مركز مفتوح`,
  closed: (n, w, t) => `صفقات مغلقة: ${n} · الرابحة ${w} · ${t} جنيه`,
  atStop: " ⚠️ عند وقف الخسارة أو تحته", atTarget: " 🎯 عند الهدف",
  stopW: "الوقف", targetW: "الهدف", egpW: "جنيه",
  status: s => ({ EXIT: "بيع", BOUNCE: "بع عند الارتداد", REVIEW: "مراجعة", "TIGHTEN STOP": "ارفع الوقف", HOLD: "احتفظ", ADJUST: "حدّث عدد الأسهم",
                  "NO DATA": "لا توجد بيانات" })[s] || s,
  note: s => arNote(s),
  foot: (sent, scan) => `\n\n<i>أرسلها متصفحك يوم ${sent}؛ الأسعار من إغلاق ${scan}. افتح الموقع لتحديث قواعد الخروج.</i>`,
  fresh: scan => `\n\n<i>فُحصت بقواعد الخروج عند إغلاق ${scan}.</i>`,
  wlEmpty: "قائمة متابعتك فارغة. ميّز الأسهم بنجمة (☆) على الموقع.",
  wl: "⭐ <b>قائمة متابعتك</b>",
  wlChance: p => ` · فرصة ${p} خلال 10 أيام`,
  wlFoot: "<i>🔔 = رسالة عندما يحصل على إشارة شراء. اضغط على الجرس لتشغيله أو إيقافه، أو على سهم للمزيد.</i>",
  bOn: "🔔 مفعّل", bOff: "🔕 متوقف",
  bWeek: "📅 الأسبوع القادم", bX30: "📈 EGX30",
  week: d => `📅 <b>أفضل فرص الأسبوع القادم</b> · من إغلاق ${d}`,
  weekLine: (i, sym, p, tgt, up, stop, strong) => `${i}. <b>${sym}</b> · ${p}${strong ? " · 💪 قوي" : ""}\n` +
    `      الهدف ${tgt} (+${up}) · الوقف ${stop}`,
  weekWeak: "⚠️ <b>سوق ضعيف</b>: أقل من 40% من الأسهم فوق متوسط 50 يومًا. الأفضل تجنب الصفقات القصيرة هذا الأسبوع.",
  weekFoot: (strong, all) => "<i>الفرصة: أن يصعد إلى الهدف (1.5 ضعف مداه اليومي) قبل أن يهبط بالقدر نفسه إلى الوقف، خلال 5 جلسات." +
    (strong ? ` في اختباراته، الاختيارات القوية (أفضل 10% لديه، في اتجاه صاعد، والسوق سليم) وصلت أولًا في ${strong} من المرات، ومتوسط الأسهم ${all}.` : "") +
    " استخدم الوقف دائمًا. ليست نصيحة.</i>",
  x30: (c, move, d) => `📈 <b>EGX30</b> · ${d}\n💰 <b>${c}</b>${move}`,
  x30Ret: r => `📊 <b>العوائد</b>\nأسبوع ${r["1W"]} · شهر ${r["1M"]}\nهذا العام ${r.YTD} · سنة ${r["1Y"]}`,
  x30Usd: (y, yr) => `بالدولار: هذا العام ${y} · سنة ${yr}`,
  x30Range: (lo, hi, ath) => `📏 <b>مدى سنة</b>\n${lo} – ${hi} · ${ath ? `${ath} تحت قمته التاريخية` : "عند قمته التاريخية"}`,
  x30Up: e => `🟢 <b>فوق متوسط 50 يومًا</b> (${e})\nقواعد الشراء تعمل.`,
  x30Down: (e, blk) => `🔴 <b>تحت متوسط 50 يومًا</b> (${e})` + (blk ? "\nلا يشتري الوكيل جديدًا." : ""),
  x30Breadth: b => `${b} من الأسهم فوق متوسط 50 يومًا الخاص بها.`,
  shotReading: "📷 أقرأ صورتك…",
  shotNone: "لم أجد أسهمًا في هذه الصورة. أرسل صورة لقائمة أسهمك في تطبيق السمسرة أو لشاشة سهم.",
  shotFail: "لم أستطع قراءة الصورة الآن. حاول بعد دقيقة.",
  shotLimit: n => `هذه ${n} صورة اليوم. حاول غدًا.`,
  shotHead: "📷 <b>صورتك مقارنة بمحفظتك على الموقع</b>\n",
  shotSame: (sym, paid) => `✅ <b>${sym}</b> متطابق: دفعت ${paid} جنيه شاملًا الرسوم`,
  shotSameShares: (sym, n) => `✅ <b>${sym}</b>: نفس عدد الأسهم (${n})`,
  shotDiff: (sym, them, site) => `⚠️ <b>${sym}</b>: دفعت ${them} جنيه في الصورة، و${site} جنيه على الموقع`,
  shotShares: (sym, them, site) => `⚠️ <b>${sym}</b>: ${them} سهم في الصورة، و${site} على الموقع`,
  shotMissing: (sym, v, pl) => `➕ <b>${sym}</b> ليس على الموقع (قيمته ${v}، ${pl} جنيه)`,
  shotOnly: syms => `على الموقع فقط: ${syms}`,
  shotFoot: missing => "<i>" + (missing ? "لإضافتها: الموقع ← محفظتي ← من صورة. " : "") +
    "لتصحيح سهم: الموقع ← محفظتي ← بيع أو تعديل. ما دفعته = القيمة السوقية − الربح أو الخسارة، فتحرك السعر بعدها لا يُحسب.</i>",
}

// The exit rules' notes (egx_agent/engine.py), in Arabic. Anything else stays as written. Kept in step with
// app/alerts.py (NOTES_AR) and the website's app/static/js/i18n.js.
const NOTES = [
  [/^Trend break \(closed below 50-day average\)/, "كسر الاتجاه (أغلق تحت متوسط 50 يومًا)"],
  [/^Max hold reached \((\d+) trading days\)/, "انتهت مدة الاحتفاظ ($1 جلسة)"],
  [/^Trailing stop/, "الوقف المتحرك"], [/^Breakeven stop/, "وقف التعادل"], [/^Stop-loss/, "وقف الخسارة"],
  [/: closed at ([\d.]+), under your stop \(([\d.]+)\)/, ": أغلق عند $1، تحت وقفك ($2)"],
  [/^Big loss \(([-−]?[\d.]+%)\): back above its 20-day average on ([\d-]+)/, "خسارة كبيرة ($1): عاد فوق متوسط 20 يومًا يوم $2"],
  [/^Big loss \(([-−]?[\d.]+%)\): no close above its 20-day average in (\d+) sessions/, "خسارة كبيرة ($1): لم يغلق فوق متوسط 20 يومًا خلال $2 جلسة"],
  [/^Big loss \(([-−]?[\d.]+%)\): sell at the first close above its 20-day average \(([\d.]+) now\), by ([\d-]+) at the latest/, "خسارة كبيرة ($1): بع عند أول إغلاق فوق متوسط 20 يومًا (الآن $2)، وفي موعد أقصاه $3"],
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
const CALLBACKS = { w: s => `/watch ${s}`, l: s => `/watch ${s} levels`, u: s => `/unwatch ${s}`, n: s => `/unwatch ${s} buy`, s: s => `/stock ${s}`,
                    y: s => `/why ${s}`, b: () => "/buys", t: () => "/top", t20: () => "/top 20", k: () => "/week",
                    e: () => "/egx30" }
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
const menuButtons = T => [[cb(T.bBuys, "b"), cb(T.bWeek, "k")], [cb(T.bTop, "t"), cb(T.bX30, "e")]]

// ------------------------------------------------------------------ asking about the website's data
// Every reply in the same shape: a bold title with an emoji, short sections with a blank line between them, each
// stock's symbol in bold with its numbers under it, and the fine print in italics at the end.
const block = (...lines) => lines.filter(Boolean).join("\n")
const move = ch => (ch != null ? `  ${ch < 0 ? "▼" : "▲"} ${pct(ch, true)}` : "")

function signalBlock(s, T) {
  const plan = s.e ? T.planNear(px(s.e), px(s.s), px(s.t)) : null
  if (s.a === "BUY") return block(T.sigBuy, T.planBuy(px(s.e), px(s.s), px(s.t)))
  if (s.a === "WATCH") return block(T.sigNear, plan)
  return s.a ? block(`<b>${esc(s.a)}</b>`, plan) : T.noSignal
}

// The best way in besides today's price (the website's Where to buy it), for a stock without a BUY.
function bestBlock(s, T) {
  if (s.a === "BUY" || !s.be) return null
  const [how, p, st, t, rr] = s.be
  return block(T.hBest, T.bestHow(how, px(p), pct(p / s.c - 1, true)), `${T.stopTgt(px(st), px(t))} · ${T.rr(rr.toFixed(1))}`,
               s.k && s.k[1] === "0" ? T.notUp : null)
}

function chartBlock(s, T) {
  if (s.cs == null) return null
  return block(T.hChart, T.supRes(s.sup != null ? px(s.sup) : "–", s.res != null ? px(s.res) : "–"), T.stopTgt(px(s.cs), px(s.ct)))
}

function stockCard(state, cid, sym, lang) {
  const T = L(lang), info = state.info, s = info.stocks[sym]
  const chances = [10, 20].filter(hz => s["p" + hz] != null).map(hz =>
    T.inDays(hz, pct(s["p" + hz]), s["r" + hz], s["x" + hz] != null ? pct(s["x" + hz], true) : null))
  const text = [
    block(`<b>${esc(sym)}</b>${s.n ? ` · ${esc(s.n)}` : ""}`, T.head(px(s.c), move(s.ch), T.day(s.d))),
    signalBlock(s, T),
    bestBlock(s, T),
    s.w != null ? block(T.hWeek, T.wkChance(pct(s.w), px(s.c * (1 + s.wm)), px(s.c * (1 - s.wm)), s.wr)) : null,
    chances.length ? block(T.hChance, ...chances) : null,
    chartBlock(s, T),
    `<i>${T.levelsTip(esc(sym))}</i>`,
  ].filter(Boolean).join("\n\n")
  // the bell, as on the website: lit when its BUY alert is on (a tap stops it), else a tap turns it on
  const bell = (state.alerts[cid] || []).some(a => a.symbol === sym && a.kind === "buy")
  const kb = [[bell ? cb(T.bBellOn, `n:${sym}`) : cb(T.bBellOff, `w:${sym}`)], [cb(T.bLevels, `l:${sym}`), cb(T.bWhy, `y:${sym}`)]]
  if ((state.alerts[cid] || []).some(a => a.symbol === sym)) kb.push([cb(T.bStop, `u:${sym}`)])
  const app = appButton(info, lang, `stock/${sym}`)
  if (app) kb.push([app])
  return reply(text, kb)
}

// /why COMI: the agent's own reasons, from the website's data (app/alerts.py bot_info): its rating and what stocks
// rated like it did in the model's tests, the BUY rule's checks passed or not, and the chart's levels.
function whyCard(info, sym, lang) {
  const T = L(lang), s = info.stocks[sym]
  const lines = [`<b>${esc(sym)}</b>${s.n ? ` · ${esc(s.n)}` : ""}`, T.head(px(s.c), move(s.ch), T.day(s.d)), ""]
  if (s.g != null) {
    lines.push(T.rating(s.g, info.rated))
    const b = (info.bands || []).find(([lo, hi]) => s.g >= lo && s.g <= hi)
    if (b && b[2] != null) {
      lines.push(T.band(b[0], b[1], pct(b[2]), info.base10 != null ? pct(info.base10) : null,
                        b[3] != null ? pct(b[3], true) : null))
    }
  } else lines.push(T.noRating)
  if (s.co) {                            // [profit growth, sales growth, margin, P/E, sector P/E] (app/alerts.py)
    const [g, sales, margin, pe, secPe] = s.co, parts = []
    if (margin != null && margin < 0) parts.push(T.co.lost)
    else if (g != null) parts.push(T.co.profit(pct(g, true)))
    if (sales != null) parts.push(T.co.sales(pct(sales, true)))
    if (pe != null) parts.push(T.co.pe(pe.toFixed(1), secPe != null ? secPe.toFixed(1) : null))
    if (parts.length) lines.push("", T.co.head, parts.join(" · "))
  }
  lines.push("")
  if (s.a) lines.push(signalBlock(s, T), "")
  if (s.k) {
    const vals = [+((info.min_value || 5e6) / 1e6).toFixed(1), null, s.h20 != null ? px(s.h20) : "–",
                  s.vr != null ? s.vr.toFixed(1) : "–", s.adx != null ? Math.round(s.adx) : "–"]
    lines.push(s.a === "BUY" ? T.checks : T.notBuy)
    for (let i = 0; i < 5; i++) lines.push(`${s.k[i] === "1" ? "✅" : "❌"} ${T.check[i](vals[i])}`)
  }
  for (const b of [chartBlock(s, T), bestBlock(s, T)]) if (b) lines.push("", b)
  lines.push("", `<i>${T.whyFoot}</i>`)
  const app = appButton(info, lang, `stock/${sym}`)
  return reply(lines.join("\n"), [[cb(T.bBuy, `w:${sym}`), cb(T.bLevels, `l:${sym}`)], ...(app ? [[app]] : [])])
}

function top(info, hz, lang) {
  const T = L(lang)
  const list = Object.entries(info.stocks).filter(([, s]) => s["r" + hz] != null)
    .sort((a, b) => a[1]["r" + hz] - b[1]["r" + hz]).slice(0, 10)
  if (!list.length) return reply(T.noPred)
  return reply(T.top(hz, T.day(info.pred)) + "\n\n" + list.map(([sym, s], i) =>
    `${i + 1}. <b>${esc(sym)}</b> · ${pct(s["p" + hz])}` + (s["x" + hz] != null ? T.expected(pct(s["x" + hz], true)) : "") +
    ` · ${px(s.c)}`).join("\n") + "\n\n" + T.topFoot, symbolButtons(list.map(([sym]) => sym)))
}

// Next week (the website's Predictions → Next week): the 10 best chances of rising 1.5× the daily range before
// falling as far within 5 sessions. Strong: its top 10%, in an uptrend, while the market is healthy (level "good").
function week(info, lang) {
  const T = L(lang), w = info.week || {}
  const list = Object.entries(info.stocks).filter(([, s]) => s.wr != null).sort((a, b) => a[1].wr - b[1].wr).slice(0, 10)
  if (!list.length) return reply(T.noPred)
  const lines = list.map(([sym, s], i) => T.weekLine(i + 1, esc(sym), pct(s.w), px(s.c * (1 + s.wm)), pct(s.wm),
    px(s.c * (1 - s.wm)), s.wl === "good" && w.top != null && s.wr <= w.top))
  return reply([T.week(T.day(info.pred)), "", ...(w.weak ? [T.weekWeak, ""] : []), ...lines, "",
                T.weekFoot(w.strong != null ? pct(w.strong) : null, w.all != null ? pct(w.all) : null)].join("\n"),
               symbolButtons(list.map(([sym]) => sym)))
}

function egx30(info, lang) {
  const T = L(lang), x = info.x30
  if (!x) return reply(T.noData)
  const r = Object.fromEntries(Object.entries(x.r).map(([k, v]) => [k, v != null ? pct(v, true) : "–"]))
  const text = [
    T.x30(egp(x.c), move(x.ch), T.day(x.d)),
    block(T.x30Ret(r), x.u && x.u.YTD != null ? T.x30Usd(pct(x.u.YTD, true), x.u["1Y"] != null ? pct(x.u["1Y"], true) : "–") : null),
    T.x30Range(egp(x.lo), egp(x.hi), x.ath < -0.0005 ? pct(-x.ath) : null),
    block(x.off ? T.x30Down(egp(x.e50), x.blk) : T.x30Up(egp(x.e50)), x.b50 != null ? T.x30Breadth(pct(x.b50)) : null),
  ].join("\n\n")
  const app = appButton(info, lang, "egx30")
  return reply(text, [[cb(T.bWeek, "k"), cb(T.bBuys, "b")], ...(app ? [[app]] : [])])
}

function buys(info, lang) {
  const T = L(lang)
  const list = Object.entries(info.stocks).filter(([, s]) => s.a === "BUY")
  if (!list.length) return reply(T.noBuys(T.day(info.scan)), [[cb(T.bWeek, "k"), cb(T.bTop, "t")]])
  return reply([T.buys(T.day(info.scan)), ...list.map(([sym, s]) => T.buyLine(esc(sym), s.n ? ` · ${esc(s.n)}` : "",
    px(s.e), px(s.s), px(s.t))), T.buysFoot].join("\n\n"), symbolButtons(list.map(([sym]) => sym)))
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
  if (WEEK_RE.test(text)) return info ? week(info, lang) : reply(T.noData)
  if (EGX30_RE.test(text)) return info ? egx30(info, lang) : reply(T.noData)
  if (HELP_RE.test(text)) {
    const app = appButton(info, lang)
    return reply(T.help, [...menuButtons(T), ...(app ? [[app]] : [])])
  }
  m = WHY_RE.exec(text)
  if (m) {
    if (!info) return reply(T.noData)
    const found = search(info, m[1].trim())
    if (found.length === 1) return whyCard(info, found[0], lang)
    if (found.length) return reply(T.didYouMean, rows(found.map(sym => cb(sym, `y:${sym}`)), 4))
    return reply(T.notFound(esc(m[1].trim().slice(0, 40))))
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
    return reply(T.yourAlerts + "\n\n" + [...mine].sort((a, b) => (a.symbol + a.kind).localeCompare(b.symbol + b.kind))
      .map(a => "• " + esc(alertText(a, lang))).join("\n"))
  }
  let m = UNWATCH_RE.exec(text)
  if (m) {
    const sym = m[1].toUpperCase(), kind = m[2] && m[2].toLowerCase()
    const gone = a => sym === "ALL" || (a.symbol === sym && (!kind || a.kind === kind))
    const n = mine.filter(gone).length
    state.alerts[cid] = mine.filter(a => !gone(a))
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
  const bell = BELL_RE.exec(text)
  if (bell) text = msg.text = `/watch ${bell[1]}`        // rewritten in place: the website's run reads the same
  const m = START_RE.exec(text)
  if (m) {
    const code = m[1].length > CODE_LEN ? m[1].slice(0, CODE_LEN) : m[1]
    if (subbed || (await sha(code)).slice(0, 16) !== state.fp) return null
    state.subs[cid] = { weekly: true, lang: langOf(state, cid, msg) }
    const T = L(state.subs[cid].lang), app = appButton(state.info, state.subs[cid].lang)
    return reply(T.welcome, [...menuButtons(T), ...(app ? [[app]] : [])])
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
  const bare = /^\/(stock|s|watch|unwatch|why)(?:@\w+)?$/i.exec(text)
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
  const mo = MORNING_RE.exec(text)
  if (mo) {
    state.subs[cid].morning = (mo[1] || "on").toLowerCase() === "on"
    return reply(state.subs[cid].morning ? T.morningOn : T.morningOff)
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
    // like your broker's (and the website's): against what you paid with the buy fees; selling fees once you sell
    const cost = p.avg * p.shares + (p.fees || 0), pnl = last * p.shares - cost
    const flag = p.stop != null && last <= p.stop ? T.atStop : p.target != null && last >= p.target ? T.atTarget : ""
    return block(`<b>${esc(p.symbol)}</b> · ${esc(T.status(p.status || ""))}${flag}`,
      `${p.shares.toLocaleString("en-US")} × ${px(p.avg)} → ${px(last)} · <b>${pct(pnl / cost, true)}</b> ` +
      `(${pnl >= 0 ? "+" : "-"}${egp(Math.abs(pnl))} ${T.egpW})`,
      [p.stop != null ? `${T.stopW} ${px(p.stop)}` : "", p.target != null ? `${T.targetW} ${px(p.target)}` : ""].filter(Boolean).join(" · "),
      p.status && p.status !== "HOLD" && p.reason ? `<i>${esc(T.note(p.reason))}</i>` : null)
  })
  const head = [T.worth(egp(worth), book.start ? pct(worth / book.start - 1, true) : null),
    T.cash(egp(book.cash), book.positions.length)]
  if (book.closed && book.closed.count) head.push(T.closed(book.closed.count, pct(book.closed.win_rate),
    `${book.closed.total >= 0 ? "+" : "-"}${egp(Math.abs(book.closed.total))}`))
  return head.join("\n") + (lines.length ? "\n\n" + lines.join("\n\n") : "") +
    (newer ? T.fresh(T.day(fresh.date)) : T.foot(T.day(book.sent), T.day(info && info.scan)))
}

// A broker screenshot (parseHoldings) against the linked portfolio. Each stock is checked by what you paid, fees in:
// the picture's market value − profit/loss (exact, whatever the price did since), or its average × shares (Thndr shows
// the average to 2 decimals, so within half a piastre a share); the website's average × shares + buy fees.
export function shotText(holdings, book, info, lang = "en") {
  const T = L(lang), known = { stocks: (info && info.stocks) || {} }
  if (!holdings.length) return T.shotNone
  const mine = Object.fromEntries((book.positions || []).map(p => [p.symbol, p]))
  const signed = v => `${v >= 0 ? "+" : "−"}${egp(Math.abs(v))}`
  const seen = new Set(), lines = [T.shotHead]
  let missing = 0
  for (const h of holdings) {
    const found = h.symbol && (known.stocks[h.symbol] || mine[h.symbol]) ? [h.symbol] : search(known, h.name || h.symbol || "")
    const sym = found.length === 1 ? found[0] : h.symbol || h.name, p = mine[sym]
    if (!p) {
      missing += 1
      lines.push(T.shotMissing(esc(sym), h.value ? egp(h.value) : "–", h.pnl != null ? signed(h.pnl) : "–"))
      continue
    }
    seen.add(sym)
    const site = p.avg * p.shares + (p.fees || 0), exact = h.value && h.pnl != null && h.value - h.pnl > 0
    const paid = exact ? h.value - h.pnl : h.avg_price && (h.shares || p.shares) ? h.avg_price * (h.shares || p.shares) : null
    const near = exact ? Math.max(3, site * 1e-4) : 0.005 * p.shares + 3
    if (h.shares && h.shares !== p.shares) lines.push(T.shotShares(esc(sym), egp(h.shares), egp(p.shares)))
    else if (paid == null) lines.push(T.shotSameShares(esc(sym), egp(p.shares)))
    else if (Math.abs(paid - site) <= near) lines.push(T.shotSame(esc(sym), egp(site)))
    else lines.push(T.shotDiff(esc(sym), egp(paid), egp(site)))
  }
  const only = Object.keys(mine).filter(s => !seen.has(s))
  if (holdings.length > 1 && only.length) lines.push(T.shotOnly(only.map(esc).join(", ")))
  return lines.join("\n") + "\n\n" + T.shotFoot(missing > 0)
}

// bells: the stocks whose BUY alert is on (🔔 beside them; watchButtons turns each on or off).
export function watchlistText(book, info, lang = "en", bells = []) {
  const T = L(lang), stocks = (info && info.stocks) || {}
  if (!book.watchlist || !book.watchlist.length) return T.wlEmpty
  return T.wl + "\n\n" + book.watchlist.map(sym => {
    const s = stocks[sym], name = `<b>${esc(sym)}</b>${bells.includes(sym) ? " 🔔" : ""}`
    if (!s) return name
    return `${name} ${px(s.c)}${move(s.ch)}` +
      (s.a === "BUY" ? " · 🟢 BUY" : "") + (s.p10 != null ? T.wlChance(pct(s.p10)) : "")
  }).join("\n") + "\n\n" + T.wlFoot
}

// Each starred stock: its card, and its bell (lit 🔔: a tap stops its BUY alert; 🔕: a tap turns it on).
function watchButtons(syms, bells, T) {
  return syms.map(sym => [cb(sym, `s:${sym}`), bells.includes(sym) ? cb(T.bOn, `n:${sym}`) : cb(T.bOff, `w:${sym}`)])
}

// ------------------------------------------------------------------ a broker screenshot, read (the website's import)
// The website's "Add from a screenshot" sends a picture of your broker's portfolio screen; Cloudflare's free AI reads
// the holdings off it. Only a linked browser can ask (20 a day), and the picture isn't kept.
const READ_MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct"
const MAX_IMAGE = 4_000_000                         // the picture as a data: URL, about 3 MB
const READS_A_DAY = 20
// Thndr's list of stocks shows each one's market value and profit/loss only (no share count or price): the website
// works out the rest from them. Tested on Thndr's list and stock screens (2026-10).
const READ_PROMPT = "This is a screenshot of a stock broker app on the Egyptian Exchange (for example Thndr). List " +
  "every stock holding it shows: there may be several. Answer with JSON only: {\"holdings\": [{\"symbol\": the " +
  "ticker as shown or null, \"name\": the company name as shown or null, \"shares\": the number of shares (units) " +
  "or null, \"avg_price\": the average buy price or null, \"last\": the price of one share now or null, \"value\": " +
  "the holding's market value (its total worth now) or null, \"pnl\": its profit or loss in money, negative for a " +
  "loss (red, a down arrow or a minus sign), or null}]}. In Thndr's list of stocks, the large amount beside each " +
  "stock is its market value and the amount under it is its profit or loss; that list shows no share count or " +
  "price, so give null for those. Plain numbers, without commas, currency or %. Not holdings: totals such as net " +
  "worth, wallet, cash, stocks total or clouds. If it shows no holdings, answer {\"holdings\": []}."

// The model's answer, checked: at most 40 rows, each with a share count or a market value; anything odd becomes null.
export function parseHoldings(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || ""))
  let got
  try { got = JSON.parse(m ? m[0] : "") } catch { return [] }
  const signed = v => {
    const x = typeof v === "string" && v.trim() ? Number(v.replace(/[,\s]|EGP|ج\.?م/gi, "").replace(/^[−–]/, "-")) : v
    return typeof x === "number" && Number.isFinite(x) ? x : null
  }
  const num = v => (signed(v) > 0 ? signed(v) : null)
  return (Array.isArray(got && got.holdings) ? got.holdings : []).slice(0, 40).map(h => ({
    symbol: typeof h.symbol === "string" && /^[A-Za-z0-9]{2,12}$/.test(h.symbol.trim()) ? h.symbol.trim().toUpperCase() : null,
    name: typeof h.name === "string" ? h.name.trim().slice(0, 80) : null,
    shares: num(h.shares), avg_price: num(h.avg_price), last: num(h.last), value: num(h.value), pnl: signed(h.pnl),
  })).filter(h => (h.shares || h.value) && (h.symbol || h.name))
}

// ------------------------------------------------------------------ on-time scans
// GitHub starts scheduled runs late, or not at all, when it's busy. After each close, every 10 minutes, the bot
// checks whether that close's scan has reached it; if not, at each of these times (minutes after midnight, Cairo) it
// asks GitHub to run the scan now. Holidays: the run finds no new prices and only rebuilds the site.
const SLOTS = [940, 970, 1000, 1060, 1150, 1270]      // 15:40, 16:10, 16:40, 17:40, 19:10, 21:10
const MORNING = [570, 600]                            // the reminder before the open: 9:30–10:00 Cairo
const LAST_MINUTE = 1350                              // 22:30
const SESSION_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu"]

export function cairo(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
    .formatToParts(now).map(x => [x.type, x.value]))
  return { day: `${p.year}-${p.month}-${p.day}`, minute: +p.hour * 60 + +p.minute, weekday: p.weekday }
}

const SESSION = [630, 885]                            // 10:30–14:45: the live prices every half hour (scan.session_scan_due)

// The slot to ask for now ("2026-09-30 940", or "2026-09-30 s660" during the session), or why not.
export function scanDue(info, now) {
  if (!SESSION_DAYS.includes(now.weekday)) return { why: "no session today" }
  if (now.minute >= SESSION[0] && now.minute <= SESSION[1]) {
    return { key: `${now.day} s${SESSION[0] + Math.floor((now.minute - SESSION[0]) / 30) * 30}` }
  }
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
// Live prices for the website's positions: TradingView's screener, about 15 minutes late (the same as its own price
// boxes). GET /quotes?s=COMI,ETEL → {COMI: {price, change}}, change against the last close. Kept a minute; 40 at most.
const TV_ALIASES = { AIHC: "AIH", ANFI: "TYCN", FCMD: "EGS3I0S1C019", NAPR: "EGS370O1C013" }   // app/static/js/ui.js
const QUOTES = new Map()
export async function quotes(url, get = fetch) {
  const syms = [...new Set((url.searchParams.get("s") || "").toUpperCase().split(","))]
    .filter(s => /^[A-Z0-9]{1,12}$/.test(s)).slice(0, 40).sort()
  const key = syms.join(","), hit = QUOTES.get(key)
  if (!syms.length) return json({})
  if (hit && Date.now() - hit.at < 60000) return json(hit.out)
  const tv = Object.fromEntries(syms.map(s => [`EGX:${TV_ALIASES[s] || s}`, s]))
  const r = await get("https://scanner.tradingview.com/egypt/scan", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ symbols: { tickers: Object.keys(tv) }, columns: ["close", "change"] }) }).catch(() => null)
  if (!r || !r.ok) return json({}, 502)
  const out = {}
  for (const row of ((await r.json().catch(() => ({}))).data || [])) {
    const [price, change] = row.d || []
    if (tv[row.s] && price > 0) out[tv[row.s]] = { price, change: change == null ? null : change / 100 }
  }
  if (QUOTES.size > 200) QUOTES.clear()
  QUOTES.set(key, { at: Date.now(), out })
  return json(out)
}

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
       ["week", "Next week's best chances"], ["top", "Best chances to reach the target"], ["egx30", "EGX30 in brief"], ["portfolio", "Your positions and what to do"],
       ["watchlist", "The stocks you starred"], ["watch", "Alert me about a stock"], ["unwatch", "Stop a stock's alerts"],
       ["why", "Why a stock is or isn't a BUY"], ["list", "My alerts"],
       ["quiet", "Only message me when there's something to do"], ["morning", "The 9:30 reminder on or off"],
       ["weekly", "The Thursday summary on or off"], ["lang", "العربية / English"], ["link", "Link your website portfolio"],
       ["unlink", "Unlink it"], ["help", "What I can do"], ["stop", "Stop all messages"]],
  ar: [["stock", "سعر السهم وإشارته وفرصه"], ["buys", "إشارات الشراء اليوم"], ["week", "أفضل فرص الأسبوع القادم"],
       ["top", "أفضل فرص الوصول للهدف"], ["egx30", "مؤشر EGX30 باختصار"],
       ["portfolio", "مراكزك وما تفعله"], ["watchlist", "الأسهم المميزة بنجمة"], ["watch", "نبّهني بخصوص سهم"],
       ["unwatch", "أوقف تنبيهات سهم"], ["why", "لماذا السهم إشارة شراء أو لا"], ["list", "تنبيهاتي"],
       ["quiet", "راسلني فقط عندما يوجد ما أفعله"], ["morning", "تذكير 9:30 تشغيل أو إيقاف"],
       ["weekly", "ملخص الخميس تشغيل أو إيقاف"], ["lang", "English / العربية"], ["link", "اربط محفظتك على الموقع"],
       ["unlink", "فك الربط"], ["help", "ما يمكنني فعله"], ["stop", "أوقف كل الرسائل"]],
}
const COMMANDS_VERSION = "2026-10-04"

// One Durable Object holds the data, so messages are handled one at a time, in order.
// The website's bells (Picks): /watch SYMBOL or /unwatch SYMBOL buy from a linked browser, kept in order here until
// the website's run has applied them (app/alerts.py web_commands), like the messages in the log.
async function catchUp(state, store) {
  for (const u of (await store.get("log")) || []) await respond(state, u)
  for (const w of (await store.get("web")) || []) {
    if (w.seq > (state.web_seen || 0)) await respond(state, webUpdate(w))
  }
}
const webUpdate = w => ({ update_id: 0, message: { chat: { id: w.cid, type: "private" }, text: w.text } })

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
      await catchUp(state, store)                          // what's happened since the website's last run
      const linked = await this.noteStart(state, update)
      let out = (await this.personal(state, update)) ?? await respond(state, update)
      const lang = langOf(state, String((update.message.chat || {}).id), update.message)
      if (linked) out = out ? { ...out, text: out.text + L(lang).linkedToo } : reply(L(lang).linkedOnly)
      await store.put("log", log.concat(update))
      if (out) await this.send(update.message.chat.id, out)
      return json({})
    }
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS })
    if (req.method === "POST" && ["/pair", "/book", "/restore", "/miniapp", "/started", "/unpair", "/read", "/bell", "/bells"].includes(url.pathname)) {
      if (url.pathname === "/book") return this.book(await req.text())
      if (url.pathname === "/read") return this.read(await req.text())
      const body = await req.json().catch(() => ({}))
      if (url.pathname === "/pair") return this.pair(body)
      if (url.pathname === "/restore") return this.restore(body)
      if (url.pathname === "/miniapp") return this.miniapp(body)
      if (url.pathname === "/started") return this.started(body)
      if (url.pathname === "/bell" || url.pathname === "/bells") return this.bell(body, url.pathname === "/bell")
      const cid = await this.owner(body.token)
      if (cid) await this.forget(cid)
      return json({ ok: true })
    }
    if (req.headers.get("Authorization") !== `Bearer ${env.SYNC_KEY}`) return new Response("", { status: 403 })
    if (url.pathname === "/updates") return json({ updates: (await store.get("log")) || [], web: (await store.get("web")) || [] })
    if (url.pathname === "/books") return this.books()
    if (url.pathname === "/tick") return this.tick()
    if (url.pathname === "/state" && req.method === "POST") {
      const state = await req.json()
      await store.put("state", state)
      await store.put("log", ((await store.get("log")) || []).filter(u => u.update_id > state.seen))
      await store.put("web", ((await store.get("web")) || []).filter(w => w.seq > (state.web_seen || 0)))
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
    const msg = { chat_id: chatId, text: out.text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }
    const r = await telegram(this.env, "sendMessage", out.kb ? { ...msg, reply_markup: { inline_keyboard: out.kb } } : msg)
      .catch(() => null)                                   // only a courtesy: the run still applies the command
    if (out.kb && r && r.ok === false) await telegram(this.env, "sendMessage", msg).catch(() => null)   // without buttons
  }

  // "/start <site code><browser's link>" (the website's Connect Telegram button) links that browser. Any other
  // /start (your Mac's own Connect link) is noted for the Mac to find (POST /started).
  async noteStart(state, update) {
    const msg = update.message || {}, chat = msg.chat || {}, m = START_RE.exec((msg.text || "").trim())
    if (!m || chat.type !== "private" || BELL_RE.test(msg.text.trim())) return false
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
    if (msg.photo || /^image\/(png|jpeg|webp)$/.test((msg.document || {}).mime_type || "")) return this.shot(cid, msg, state, lang)
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
      const bells = (state.alerts[cid] || []).filter(a => a.kind === "buy").map(a => a.symbol)
      return mine
        ? reply(portfolioText(book, state.info, lang, state.mine && state.mine[cid]), app ? [[app]] : null)
        : reply(watchlistText(book, state.info, lang, bells), [...watchButtons((book.watchlist || []).slice(0, 12), bells, T),
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
    await store.delete(["book:" + cid, "full:" + cid, "links:" + cid, "mini:" + cid, "reads:" + cid,
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

  async read(raw) {
    if (raw.length > MAX_IMAGE) return json({ error: "That picture is too big. Try a plain screenshot." }, 413)
    let body
    try { body = JSON.parse(raw) } catch { return json({ error: "Bad request" }, 400) }
    const cid = await this.owner(body.token)
    if (!cid) return json({ error: "Not linked" }, 401)
    if (!this.env.AI) return json({ error: "The bot can't read pictures yet." }, 503)
    const image = String(body.image || "")
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) {
      return json({ error: "Send a PNG or JPEG screenshot." }, 400)
    }
    const got = await this.readImage(cid, image)
    return got.error ? json({ error: got.error }, got.status) : json({ holdings: got.holdings })
  }

  // The day's limit (shared by the website and pictures sent here), then Cloudflare's AI: {holdings} or {error, status}.
  async readImage(cid, image) {
    const store = this.ctx.storage, day = new Date().toISOString().slice(0, 10), used = await store.get("reads:" + cid)
    const n = used && used.day === day ? used.n : 0
    if (n >= READS_A_DAY) return { error: `That's ${READS_A_DAY} pictures today. Try again tomorrow.`, status: 429 }
    await store.put("reads:" + cid, { day, n: n + 1 })
    let out
    try {
      out = await this.env.AI.run(READ_MODEL, { messages: [{ role: "user", content: [{ type: "text", text: READ_PROMPT },
        { type: "image_url", image_url: { url: image } }] }], max_tokens: 1500, temperature: 0 })
    } catch {
      return { error: "The picture reader didn't answer. Try again in a minute.", status: 502 }
    }
    const text = out && (out.response ?? (out.choices && out.choices[0] && out.choices[0].message.content))
    return { holdings: parseHoldings(text) }
  }

  // A screenshot of your broker's holdings sent to the bot: read like the website's import, then checked against your
  // linked portfolio (shotText). The picture isn't kept.
  async shot(cid, msg, state, lang) {
    const T = L(lang), book = await this.ctx.storage.get("book:" + cid)
    if (!book) return reply(T.notLinked)
    if (!this.env.AI) return reply(T.shotFail)
    const doc = msg.photo ? msg.photo[msg.photo.length - 1] : msg.document
    const mime = msg.photo ? "image/jpeg" : doc.mime_type
    if (!doc.file_id || doc.file_size > MAX_IMAGE * 0.7) return reply(T.shotNone)
    await this.send(cid, reply(T.shotReading))
    let got
    try {
      const f = await telegram(this.env, "getFile", { file_id: doc.file_id })
      const r = await fetch(`https://api.telegram.org/file/bot${this.env.BOT_TOKEN}/${f.result.file_path}`)
      const bytes = new Uint8Array(await r.arrayBuffer())
      let bin = ""
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      got = await this.readImage(cid, `data:${mime};base64,${btoa(bin)}`)
    } catch {
      return reply(T.shotFail)
    }
    if (got.error) return reply(got.status === 429 ? T.shotLimit(READS_A_DAY) : T.shotFail)
    const app = appButton(state.info, lang, "portfolio")
    return reply(shotText(got.holdings, book, state.info, lang), app ? [[app]] : null)
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
    if (state) await catchUp(state, this.ctx.storage)                                       // joined since the run
    if (!cid || !state || !(cid in state.subs)) return json({ error: "Press Connect Telegram on the website first." }, 403)
    if (!state.sitekey) return json({ error: "The website's key hasn't reached the bot yet." }, 503)
    const token = hex(await hmac(this.env.SYNC_KEY, "mini:" + cid)), hash = await sha(token)
    await this.ctx.storage.put("tok:" + hash, cid)
    await this.ctx.storage.put("mini:" + cid, hash)
    return json({ key: state.sitekey, token })
  }

  // The website's bell on a stock (Picks): a Telegram message when it gets a BUY, turned on or off from a linked
  // browser without opening Telegram. /bells: which stocks have one. {bells: [SYMBOL…]} or {error}.
  async bell(body, change) {
    const store = this.ctx.storage, cid = await this.owner(body.token)
    if (!cid) return json({ error: "Not linked" }, 401)
    const base = await store.get("state")
    if (!base) return json({ error: "The bot has no data yet." }, 503)
    const state = structuredClone(base)
    await catchUp(state, store)
    if (!(cid in state.subs)) return json({ error: "Press Connect Telegram on the website first." }, 403)
    const bells = () => (state.alerts[cid] || []).filter(a => a.kind === "buy").map(a => a.symbol)
    if (!change) return json({ bells: bells() })
    const sym = String(body.symbol || "").toUpperCase()
    if (!/^[A-Z0-9]{2,12}$/.test(sym) || !(sym in state.stocks)) return json({ error: "Unknown stock" }, 400)
    const on = body.on !== false, mine = state.alerts[cid] || []
    if (on && mine.length >= MAX_ALERTS && !bells().includes(sym)) {
      return json({ error: `You already have ${MAX_ALERTS} alerts. Remove some first.` }, 400)
    }
    const web = (await store.get("web")) || [], seq = Math.max(base.web_seen || 0, ...web.map(w => w.seq)) + 1
    const w = { seq, cid, text: on ? `/watch ${sym}` : `/unwatch ${sym} buy` }
    await respond(state, webUpdate(w))
    await store.put("web", web.concat(w))
    return json({ bells: bells() })
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

  // The reminder before the open (app/site_daily.py morning_texts): once, on the session day it was written for, to
  // each friend still connected who hasn't sent /morning off since.
  async morning(now) {
    const store = this.ctx.storage, base = await store.get("state"), m = base && base.morning
    if (!m || m.day !== now.day || now.minute < MORNING[0] || now.minute >= MORNING[1]) return 0
    if ((await store.get("morning_sent")) === m.day) return 0
    await store.put("morning_sent", m.day)
    const state = structuredClone(base)
    await catchUp(state, store)                                             // what's happened since the run
    let sent = 0
    for (const [cid, text] of Object.entries(m.texts || {})) {
      const s = state.subs[cid]
      if (!s || s.morning === false) continue
      const app = appButton(state.info, s.lang, "today")
      await this.send(cid, reply(text, app ? [[app]] : null))
      sent += 1
    }
    return sent
  }

  async tick(now = new Date()) {
    const env = this.env, store = this.ctx.storage, c = cairo(now)
    const morning = await this.morning(c)
    if (!env.GH_TOKEN || !env.GITHUB_REPO) return json({ ok: false, why: "no GitHub key", morning })
    const state = await store.get("state"), due = scanDue(state && state.info, c)
    if (!due.key) return json({ ok: true, why: due.why, morning })
    const last = await store.get("dispatch")
    if (last && last.key === due.key) return json({ ok: true, why: "asked already", morning })
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
    const url = new URL(req.url)
    if (url.pathname === "/quotes" && req.method === "GET") return quotes(url)
    return env.BOT.get(env.BOT.idFromName("bot")).fetch(req)
  },
  // Every 10 minutes (wrangler.toml): only the morning (the reminder at 9:30 Cairo, UTC+2 or +3), the session (a scan
  // every half hour) and the evening (a scan after the close) have anything to do, so the night returns at once.
  scheduled(event, env, ctx) {
    const hour = new Date(event.scheduledTime).getUTCHours()
    if (!env.SYNC_KEY || hour < 6 || hour > 20) return
    ctx.waitUntil(env.BOT.get(env.BOT.idFromName("bot")).fetch("https://bot/tick",
      { method: "POST", headers: { Authorization: `Bearer ${env.SYNC_KEY}` } }))
  },
}
