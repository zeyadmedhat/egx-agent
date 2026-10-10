// English / Arabic. t('English text', { name: value }) gives the text in the chosen language, with {name} filled in.
// The English text is the key, so a string without an Arabic entry simply shows in English. Stock names, numbers and
// the agent's own long explanations (signal reasons, order details) stay as the agent writes them.
import { store } from './lib.js';

export const isAr = () => store.lang === 'ar';

// The Arabic words (ar.js, the biggest file of the page code) load only when Arabic is chosen: loadArabic() first.
let AR = {};
export async function loadArabic() {
  if (!AR.__ready) AR = { ...(await import('./ar.js')).AR, __ready: true };
}

export function t(en, vars) {
  let s = (isAr() && AR[en]) || en;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v);
  return s;
}

// Like t(), but the values can be pieces of page (a bold number, a link): returns a list to put in html``.
export function tp(en, vars) {
  return ((isAr() && AR[en]) || en).split(/\{(\w+)\}/).map((part, i) => (i % 2 ? vars[part] : part));
}

// The agent's own notes (a signal's reasons, an order's details, a position's exit note, sizing notes, sectors),
// written in English by the scan and the exit rules: tn() gives them in Arabic by their patterns. Anything it doesn't
// know stays as written. The exit-rule notes are the same as the Telegram bot's (worker/bot.js).
const STRENGTH = { strong: 'قوي', moderate: 'متوسط', weak: 'ضعيف' };
const NOTES = [
  [/^Closed at ([\d.]+), above its 20-day high of ([\d.]+), on ([\d.]+)× normal volume$/, 'أغلق عند $1، فوق أعلى سعر في 20 يومًا ($2)، بحجم تداول $3× المعتاد'],
  [/^Dipped to its 20-day average \(([\d.]+)\) and bounced; RSI turning up at (\d+)$/, 'هبط إلى متوسط 20 يومًا ($1) وارتد؛ مؤشر RSI يتجه للصعود عند $2'],
  [/^Uptrend: price above its 20- and 50-day averages; ADX (\d+) \((strong|moderate|weak) trend\)$/,
    (m, adx, s) => `اتجاه صاعد: السعر فوق متوسطي 20 و50 يومًا؛ ADX ${adx} (اتجاه ${STRENGTH[s]})`],
  [/^3-month return ([+−-]?[\d.]+%)(?: vs EGX30 ([+−-]?[\d.]+%))?; stronger than (\d+%) of liquid EGX stocks$/,
    (m, r, i, p) => `عائد 3 أشهر ${r}${i ? ` مقابل EGX30 ${i}` : ''}؛ أقوى من ${p} من الأسهم السائلة`],
  [/^Accumulation: ([\d.]+)× more volume on up days than down days \(20 days\)$/, 'تجميع: حجم تداول أكبر $1× في أيام الصعود من أيام الهبوط (20 يومًا)'],
  [/^Caution: more volume on down days than up days \(([\d.]+)×\)$/, 'تنبيه: حجم تداول أكبر في أيام الهبوط من أيام الصعود ($1×)'],
  [/^Room to the 6-month high \(([\d.]+)\): ([\d.]+)× the risk$/, 'المسافة حتى أعلى سعر في 6 أشهر ($1): $2× المخاطرة'],
  [/^Caution: stretched \(([+−-]?[\d.]+%) vs 20-day avg, RSI (\d+)\); a dip entry is safer$/, 'تنبيه: ممتد ($1 عن متوسط 20 يومًا، RSI $2)؛ الدخول عند التراجع أكثر أمانًا'],
  [/^Plan: stop ([\d.]+) \(([\d.]+%) below\), target ([\d.]+) \(\+([\d.]+%)\)$/, 'الخطة: الوقف $1 (أقل بـ $2)، الهدف $3 (+$4)'],
  [/^Stop sits just under support: (.*)$/, 'الوقف أسفل الدعم مباشرة: $1'],
  [/^Target sits just under resistance: (.*)$/, 'الهدف أسفل المقاومة مباشرة: $1'],
  [/^No resistance overhead within reach: the target is ([\d.]+)× the risk$/, 'لا توجد مقاومة قريبة فوقه: الهدف $1× المخاطرة'],
  [/^Caution: resistance at ([\d.]+) \((.*)\) comes before the target$/, 'تنبيه: مقاومة عند $1 ($2) قبل الهدف'],
  [/^The prediction model's #(\d+) of (\d+) stocks today \(its top (\d+) are BUYs when they pass the liquidity and uptrend checks\)$/,
    'رقم $1 من $2 سهمًا في نموذج التوقع اليوم (أفضل $3 تصبح إشارات شراء إذا اجتازت فحص السيولة والاتجاه الصاعد)'],
  // orders (local/api.js, app/views.py)
  [/^Sell all ([\d,]+) (\S+) at the open$/, 'بع كل $1 من $2 عند الافتتاح'],
  [/^Move your (\S+) stop up to ([\d.,]+)$/, 'ارفع وقف $1 إلى $2'],
  [/^It was ([\d.,]+)\. Sell if the price falls to ([\d.,]+)\.$/, 'كان $1. بع إذا هبط السعر إلى $2.'],
  [/^Decide on (\S+): day (\d+) without progress$/, 'قرّر بشأن $1: اليوم $2 بدون تقدم'],
  [/^Sell (\S+) on a bounce: at its first close above ([\d.,]+)$/, 'بع $1 عند الارتداد: عند أول إغلاق فوق $2'],
  [/^Update (\S+) for its bonus shares$/, 'حدّث $1 لأسهم المنحة'],
  [/, from ([^.]+)\. On My Portfolio, enter the shares you hold now\. Its stop can't be checked until then\.$/,
    '، من $1. في صفحة محفظتي أدخل عدد الأسهم التي تملكها الآن. لا يمكن فحص الوقف حتى تفعل.'],
  [/^Lower your (\S+) stop to ([\d.,]+) before the open$/, 'اخفض وقف $1 إلى $2 قبل الافتتاح'],
  [/^(\S+) goes ex-dividend: the price opens about ([\d.,]+) EGP lower, and you get ([\d.,]+) EGP a share \(([\d,]+) EGP\)\. The agent moves the stop and the target down by the same amount, so the drop alone doesn't sell\.$/,
    '$1 يصرف توزيعًا نقديًا: يفتح السعر أقل بحوالي $2 جنيه، وتحصل على $3 جنيه للسهم ($4 جنيه). يخفض الوكيل الوقف والهدف بنفس القيمة، فلا يبيع الهبوط وحده.'],
  [/^Buy ([\d,]+) (\S+), paying no more than ([\d.,]+)$/, 'اشترِ $1 من $2 بسعر لا يزيد عن $3'],
  [/^Use a limit order; skip it if it opens higher\. Once filled: stop ([\d.,]+), target ([\d.,]+), max loss ([\d,]+) EGP\.$/,
    'استخدم أمرًا بسعر محدد؛ تجاوزه إذا فتح أعلى. بعد التنفيذ: الوقف $1، الهدف $2، أقصى خسارة $3 جنيه.'],
  [/^Bonus shares or split from ([^:]+): (.*)\. Enter the shares you hold now so the stop and P&L stay right\.$/,
    'أسهم منحة أو تجزئة من $1: $2. أدخل عدد الأسهم التي تملكها الآن ليبقى الوقف والربح صحيحين.'],
  [/^Rights issue from ([^:]+): past prices ÷ ([\d.]+)\. Once you've subscribed or sold your rights, enter the shares you hold now so the stop and P&L stay right\.$/,
    'حق اكتتاب من $1: الأسعار السابقة ÷ $2. بعد أن تكتتب أو تبيع حقوقك، أدخل عدد الأسهم التي تملكها الآن ليبقى الوقف والربح صحيحين.'],
  // sizing (egx_agent/risk.py, local/engine.js)
  [/^([\d.]+)% risk rule$/, 'قاعدة مخاطرة $1%'],
  [/^reduced: total open risk limit \(([\d.]+)%\)$/, 'مخفّض: حد إجمالي المخاطرة المفتوحة ($1%)'],
  [/^capped by max ([\d.]+)% of account per stock$/, 'محدود بحد أقصى $1% من الحساب للسهم'],
  [/^capped by liquidity: ([\d.]+)% of daily traded value$/, 'محدود بالسيولة: $1% من قيمة التداول اليومية'],
  [/^portfolio full \((\d+) positions( in risk-off mode)?\)$/, (m, n, off) => `المحفظة ممتلئة (${n} مراكز${off ? ' في وضع تجنب المخاطر' : ''})`],
  [/^already (\d+) positions in (.+)$/, (m, n, s) => `بالفعل ${n} مراكز في ${AR[s] || s}`],
  // the exit rules (egx_agent/engine.py)
  [/^Trend break \(closed below 50-day average\)/, 'كسر الاتجاه (أغلق تحت متوسط 50 يومًا)'],
  [/^Max hold reached \((\d+) trading days\)/, 'انتهت مدة الاحتفاظ ($1 جلسة)'],
  [/^Trailing stop/, 'الوقف المتحرك'], [/^Breakeven stop/, 'وقف التعادل'], [/^Stop-loss/, 'وقف الخسارة'],
  [/: closed at ([\d.]+), under your stop \(([\d.]+)\)/, ': أغلق عند $1، تحت وقفك ($2)'],
  [/^Big loss \(([-−]?[\d.]+%)\): back above its 20-day average on ([\d-]+)/, 'خسارة كبيرة ($1): عاد فوق متوسط 20 يومًا يوم $2'],
  [/^Big loss \(([-−]?[\d.]+%)\): no close above its 20-day average in (\d+) sessions/, 'خسارة كبيرة ($1): لم يغلق فوق متوسط 20 يومًا خلال $2 جلسة'],
  [/^Big loss \(([-−]?[\d.]+%)\): sell at the first close above its 20-day average \(([\d.]+) now\), by ([\d-]+) at the latest/, 'خسارة كبيرة ($1): بع عند أول إغلاق فوق متوسط 20 يومًا (الآن $2)، وفي موعد أقصاه $3'],
  [/^Target reached/, 'تم الوصول للهدف'], [/: sell at the next open/, ': بع عند الافتتاح القادم'],
  [/: sell at the open \(flagged before ([\d-]+)\)/, ': بع عند الافتتاح (ظهرت قبل $1)'], [/ \(gap down\)/, ' (فجوة هبوط)'],
  [/ \(gap up\)/, ' (فجوة صعود)'], [/ on ([\d-]+) at ([\d.]+)$/, ' يوم $1 عند $2'],
  [/^Day (\d+): no \+1R move yet \(needs ([\d.]+)\)\. Consider exiting\./, 'اليوم $1: لم يتحرك +1R بعد (يحتاج $2). فكّر في الخروج.'],
  [/^Raise your stop to ([\d.]+)/, 'ارفع وقفك إلى $1'], [/^Stop ([\d.]+), target ([\d.]+)/, 'الوقف $1، الهدف $2'],
  // the scan's warnings (egx_agent/scan.py)
  [/^No price data from TradingView for (\d+) stocks: (.*), and (\d+) more$/, 'لم تصل أسعار جديدة من TradingView لـ$1 سهمًا: $2، و$3 غيرها'],
  [/^No price data from TradingView for: (.*)$/, 'لم تصل أسعار جديدة من TradingView لهذه الأسهم: $1'],
];

export function tn(text) {
  if (!isAr() || text == null) return text;
  const s = String(text);
  if (AR[s]) return AR[s];
  return NOTES.reduce((out, [re, ar]) => out.replace(re, ar), s);
}

// The prediction model's reasons (egx_agent/predict.py WHY_TEXT), written "label value", e.g. "3-month change +24%":
// tw() gives them in Arabic by their label. tests/test_static_site.py checks every label is here.
export const WHY_AR = {
  'Last session': 'آخر جلسة', '1-week change': 'تغير أسبوع', '2-week change': 'تغير أسبوعين',
  '1-month change': 'تغير شهر', '3-month change': 'تغير 3 أشهر', '6-month change': 'تغير 6 أشهر',
  '1-year change': 'تغير سنة', 'vs its 20-day average': 'مقارنة بمتوسط 20 يومًا',
  'vs its 50-day average': 'مقارنة بمتوسط 50 يومًا', 'vs its 200-day average': 'مقارنة بمتوسط 200 يوم',
  "20-day average's slope": 'ميل متوسط 20 يومًا', "50-day average's slope": 'ميل متوسط 50 يومًا',
  'RSI': 'RSI', 'RSI change this week': 'تغير RSI هذا الأسبوع', 'MACD momentum': 'زخم MACD',
  'Trend strength (ADX)': 'قوة الاتجاه (ADX)', 'Daily range': 'المدى اليومي', 'Stop distance': 'بعد الوقف',
  'Jumpiness vs usual': 'التذبذب مقارنة بالمعتاد', 'vs its 20-day high': 'مقارنة بأعلى سعر في 20 يومًا',
  'vs its 1-year high': 'مقارنة بأعلى سعر في سنة', 'above its 1-year low': 'فوق أدنى سعر في سنة',
  "Closed at this point of the day's range": 'موضع الإغلاق في مدى اليوم', 'Opening gap': 'فجوة الافتتاح',
  'Volume vs usual': 'حجم التداول مقارنة بالمعتاد', "This week's volume vs usual": 'حجم تداول الأسبوع مقارنة بالمعتاد',
  'Up-day vs down-day volume': 'حجم أيام الصعود مقابل أيام الهبوط',
  'Days without trades (last month)': 'أيام بلا تداول (الشهر الماضي)', 'Breakout setup': 'نمط اختراق',
  'Pullback setup': 'نمط ارتداد', 'MACD cross': 'تقاطع MACD', 'Uptrend check': 'فحص الاتجاه الصاعد',
  "Rules' score": 'درجة القواعد', '1-month change vs other stocks': 'تغير شهر مقارنة بالأسهم الأخرى',
  '3-month change vs other stocks': 'تغير 3 أشهر مقارنة بالأسهم الأخرى',
  'Money traded vs other stocks': 'قيمة التداول مقارنة بالأسهم الأخرى',
  'Daily range vs other stocks': 'المدى اليومي مقارنة بالأسهم الأخرى', '1-month change vs its sector': 'تغير شهر مقارنة بقطاعه',
  'Its sector in uptrends': 'أسهم قطاعه في اتجاه صاعد', 'Next ex-dividend date': 'تاريخ الاستحقاق القادم',
  'Last ex-dividend': 'آخر تاريخ استحقاق', 'Last dividend announced': 'آخر توزيع معلن',
  'Dividends in 3 years': 'توزيعات في 3 سنوات', 'Bonus shares coming': 'أسهم مجانية قادمة',
  'Bonus shares announced': 'إعلان أسهم مجانية', 'Rights issue coming': 'حق اكتتاب قادم',
  'Share buyback announced': 'إعلان شراء أسهم خزينة', 'Profit for its price (earnings yield)': 'الربح مقارنة بالسعر (عائد الأرباح)',
  'Sales for its price': 'المبيعات مقارنة بالسعر', 'Free cash for its price': 'النقد الحر مقارنة بالسعر',
  'Dividend yield': 'عائد التوزيعات', 'Profit growth in a year': 'نمو الربح في سنة',
  'Sales growth in a year': 'نمو المبيعات في سنة', "Last quarter's profit vs a year before": 'ربح آخر ربع مقارنة بالعام السابق',
  'Profit margin': 'هامش الربح', 'Return on assets': 'العائد على الأصول', 'Debt for its assets': 'الدين مقارنة بالأصول',
  'Profitable over the last year': 'رابحة في آخر سنة',
  'Cheapness for its profit vs other stocks': 'رخص السعر مقابل الربح مقارنة بالأسهم الأخرى',
  'Profit growth vs other stocks': 'نمو الربح مقارنة بالأسهم الأخرى',
  'Return on assets vs other stocks': 'العائد على الأصول مقارنة بالأسهم الأخرى',
};
const WHY_LABELS = Object.keys(WHY_AR).sort((a, b) => b.length - a.length);   // longest first: "RSI change…" before "RSI"
const WHY_REST = [[/^: top (\d+)%$/, ': أعلى $1%'], [/^: bottom (\d+)%$/, ': أدنى $1%'], [/^: yes$/, ': نعم'],
  [/^: no$/, ': لا'], [/^: none$/, ': لا يوجد'], [/^: in (\d+) days$/, ': بعد $1 يوم'], [/^: (\d+) days ago$/, ': منذ $1 يوم']];

export function tw(text) {
  if (!isAr() || !text) return text;
  const label = WHY_LABELS.find(l => text === l || text.startsWith(l + ' ') || text.startsWith(l + ':'));
  if (!label) return text;
  return WHY_AR[label] + WHY_REST.reduce((out, [re, ar]) => out.replace(re, ar), text.slice(label.length));
}

// ------------------------------------------------------------------ market terms, explained in two lines
export const GLOSSARY = {
  score: {
    en: ['Score (0–100)', "The agent's rating of the trend, strength against other stocks, volume and room to run. 70 or more is strong."],
    ar: ['التقييم (0–100)', 'تقييم الوكيل للاتجاه وقوة السهم مقارنة بباقي الأسهم وحجم التداول والمساحة المتاحة للصعود. 70 فأكثر يعني قوي.'],
  },
  stop: {
    en: ['Stop-loss', 'The price where you sell to cap the loss. The agent raises it as the price rises and never lowers it (except by a dividend).'],
    ar: ['وقف الخسارة', 'السعر الذي تبيع عنده لتحدد خسارتك. يرفعه الوكيل مع صعود السعر ولا يخفضه أبدًا (إلا بقيمة توزيع نقدي).'],
  },
  target: {
    en: ['Target', 'The price where the agent takes the profit: just under the first resistance on the chart that pays at least 1.5× the risk.'],
    ar: ['الهدف', 'السعر الذي يجني عنده الوكيل الربح: أسفل أول مقاومة على الرسم البياني تعطي 1.5 ضعف المخاطرة على الأقل.'],
  },
  buyupto: {
    en: ['Buy up to', 'The highest price worth paying at the next session. If the stock opens higher, skip it: the risk and reward no longer fit.'],
    ar: ['اشترِ حتى', 'أعلى سعر يستحق الدفع في الجلسة القادمة. إذا فتح السهم أعلى منه فتجاوزه: لم تعد المخاطرة والعائد مناسبين.'],
  },
  riskoff: {
    en: ['Weak market', 'EGX30 is below its 50-day average, or fewer than 40% of stocks are above theirs. Breakouts fail more often then, so the agent stops new BUY calls until it recovers.'],
    ar: ['سوق ضعيف', 'مؤشر EGX30 أقل من متوسط 50 يومًا، أو أقل من 40% من الأسهم فوق متوسطها. الاختراقات تفشل أكثر في هذا الوقت، فيوقف الوكيل إشارات الشراء الجديدة حتى يتعافى السوق.'],
  },
  ema50: {
    en: ['50-day average', 'The average close of the last 50 sessions. A price above it means a medium-term uptrend.'],
    ar: ['متوسط 50 يومًا', 'متوسط سعر الإغلاق لآخر 50 جلسة. السعر فوقه يعني اتجاهًا صاعدًا على المدى المتوسط.'],
  },
  breadth: {
    en: ['Stocks in uptrend', 'The share of EGX stocks above their 50-day average. High: a broad rally. Low: a few big names carry the index.'],
    ar: ['الأسهم في اتجاه صاعد', 'نسبة أسهم البورصة فوق متوسط 50 يومًا. مرتفعة: صعود واسع. منخفضة: عدد قليل من الأسهم الكبيرة يحمل المؤشر.'],
  },
  rsi: {
    en: ['RSI (14)', 'How fast the price moved lately, from 0 to 100. Above 70: it ran up fast (overbought). Below 30: it fell fast.'],
    ar: ['مؤشر القوة النسبية RSI', 'سرعة حركة السعر مؤخرًا من 0 إلى 100. فوق 70: صعد بسرعة (تشبع شرائي). تحت 30: هبط بسرعة.'],
  },
  adx: {
    en: ['ADX', 'How strong the trend is, not its direction. Above 20–25 means a real trend.'],
    ar: ['مؤشر ADX', 'قوة الاتجاه وليس اتجاهه. فوق 20–25 يعني اتجاهًا حقيقيًا.'],
  },
  atr: {
    en: ['Daily range (ATR)', "The stock's average move in a day. Stops and targets are set as multiples of it."],
    ar: ['المدى اليومي ATR', 'متوسط حركة السهم في اليوم. يُحدد وقف الخسارة والهدف كمضاعفات له.'],
  },
  exdiv: {
    en: ['Ex-dividend', 'The first day a buyer no longer gets the dividend. The price drops by it that morning; holders get it in cash.'],
    ar: ['تاريخ استحقاق الكوبون', 'أول يوم لا يحصل فيه المشتري على التوزيع. ينخفض السعر بقيمته صباح ذلك اليوم ويحصل عليه المساهمون نقدًا.'],
  },
  results: {
    en: ['Results', "The company's quarterly or yearly financial results. The price can move a lot on the day they come out."],
    ar: ['نتائج الأعمال', 'النتائج المالية الربع سنوية أو السنوية للشركة. قد يتحرك السعر بقوة يوم إعلانها.'],
  },
  egx33: {
    en: ['EGX33', "The exchange's Shariah index: 33 companies that pass its Islamic screening."],
    ar: ['EGX33', 'مؤشر الشريعة في البورصة المصرية: 33 شركة تجتاز فحصه الشرعي.'],
  },
  kashif: {
    en: ['Kashif', "kasheif.com's Shariah check of each company, from its financial statements."],
    ar: ['كاشف', 'فحص موقع كاشف الشرعي لكل شركة بناءً على قوائمها المالية.'],
  },
  paper: {
    en: ['Paper account', 'Pretend money that follows the signals by itself, to see how they do without risking anything.'],
    ar: ['الحساب التجريبي', 'أموال افتراضية تتبع الإشارات تلقائيًا لترى نتائجها دون أي مخاطرة.'],
  },
  watchlist: {
    en: ['Close to a BUY', 'Liquid stocks in strong uptrends that have not broken out yet. A close above the breakout level on strong volume can make them a BUY.'],
    ar: ['قريبة من الشراء', 'أسهم سائلة في اتجاه صاعد قوي لم تخترق بعد. إغلاق فوق مستوى الاختراق بحجم تداول قوي قد يجعلها إشارة شراء.'],
  },
  breakout: {
    en: ['Breakout', 'A close above the highest price of the last 20 sessions, on stronger volume than usual.'],
    ar: ['الاختراق', 'إغلاق فوق أعلى سعر في آخر 20 جلسة بحجم تداول أقوى من المعتاد.'],
  },
  model: {
    en: ['Prediction model', 'Learned from 10 years of EGX prices. It ranks stocks by the chance of reaching the target before the stop within 2 weeks.'],
    ar: ['نموذج التوقع', 'تعلّم من أسعار 10 سنوات في البورصة المصرية. يرتب الأسهم حسب فرصة الوصول للهدف قبل وقف الخسارة خلال أسبوعين.'],
  },
  rr: {
    en: ['Reward / risk', 'How much the trade could gain for each pound it risks: from the buy price up to the target, and down to the stop. The agent wants at least 1.5 to 1.'],
    ar: ['العائد / المخاطرة', 'كم قد تربح الصفقة مقابل كل جنيه تخاطر به: من سعر الشراء صعودًا إلى الهدف وهبوطًا إلى الوقف. يريد الوكيل 1.5 إلى 1 على الأقل.'],
  },
  liquid: {
    en: ['Liquid', 'Trades enough money a day to buy and sell without moving the price much.'],
    ar: ['سائل', 'يُتداول بمبالغ كافية يوميًا للشراء والبيع دون تحريك السعر كثيرًا.'],
  },
};

export const term = key => GLOSSARY[key] && GLOSSARY[key][isAr() ? 'ar' : 'en'];
