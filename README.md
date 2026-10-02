# EGX Trading Agent

A personal decision-support tool for swing trades on the Egyptian Exchange: **hold 2 weeks, 1 month at most**.
It scans every EGX stock after the close, tells you what to buy, how many shares, where to put your stop and
target, and when to get out. You place every order yourself at your broker. It never trades for you, and it
is **not investment advice**.

## Start it

Double-click **`Start Trading Agent.command`** in this folder.

- The first time, it sets itself up (about a minute) and downloads 5 years of prices (about 5 minutes).
- Your browser opens the dashboard at `http://localhost:8501`. Only this Mac can open it.
- Keep the Terminal window open while you use it. To stop it, press Ctrl+C in that window, or double-click
  **`Stop Trading Agent.command`**, which works however the dashboard was started.
- While it runs, it scans by itself once new closing prices are out, so you can leave the page open all day.
  To scan even when it's closed, and get the results on your phone, see [Alerts](#alerts-on-your-phone).

If macOS says the file can't be opened, right-click it → **Open** → **Open**.

## Daily routine (Sunday–Thursday)

1. **After 3:30 pm Cairo time**, open the dashboard. It scans automatically when new closing prices are available,
   or press **Run scan** (top right). The progress shows in the top bar and you can keep using the pages meanwhile.
2. **Today** page:
   - **Orders for tomorrow** lists everything to do at your broker, most urgent first: sells, stops to move up,
     bonus-share updates and buys. Tick each one off as you place it, or press Copy.
   - The market banner says if EGX30 is healthy. When it is below its 50-day average the agent makes **no new BUY
     calls**. That is deliberate: in the backtest this was the single most helpful rule.
   - **BUY cards** show the stock, *Buy up to* price, stop-loss, target, number of shares and the maximum
     loss in EGP (about 1.5% of your capital). Next morning, don't pay more than *Buy up to*.
   - **Your open positions** show one of: 🔴 EXIT, 🟠 REVIEW, 🔵 TIGHTEN STOP (move your stop order up) or 🟢 HOLD.
3. After you buy or sell at your broker, record it on **My Portfolio** so the agent can track it.

## The pages

The site has four sections, along the top on a computer and in a bar at the bottom of a phone. Each section has tabs.
The ⚙ button (**More** on a phone) holds Settings, Admin, the language and the light/dark theme.

| Section → tab | What it's for |
|---|---|
| **Today → Summary** | "Today in one minute" (the market, the signals and your positions in a few plain sentences), a badge saying whether the session is open and the numbers are final, the orders checklist for the next session, your open positions as cards (what to do in plain words, the price and profit/loss, live during the session, and where the price sits between your stop and your target), and the market with a 6-month EGX30 chart |
| **Today → Signals** | The BUY signals (each with its rating and the model's reason in one line, the company's results in brief (profit and sales growth over a year, or that it lost money, and its P/E next to its sector's), **Log buy**, **Size it**, **Why this signal** and what BUYs with a score like it did in the 10-year test), the stocks close to a BUY (best rated first, with the same reason and company line), and the **track record**: every BUY the agent published, followed with the same exit rules from the next open (fees included), set against the test, with a warning when 10 points fewer of its signals win than in the test (after 30 ended; also in Telegram) |
| **Today → News** | The last month's headlines about EGX stocks and the market (Mubasher, Reuters, Zawya, Al Borsa News, Daily News Egypt), filtered by your stocks, source, topic and tone, with the dividends, bonus shares and rights issues coming up and announced this month |
| **Market → Overview** | Breadth: how many stocks are above their 50-day average, up/down counts, 1-year highs/lows, the biggest movers (day, week, month), a sector table and the market switch for the model's picks. The 1-year breadth chart and the 20-/200-day counts open on a tap. Context only: it doesn't change the BUY rules |
| **Market → Heatmap** | The whole market in one picture: a tile for every stock that traded at the last close, grouped by sector, sized by the company's market value (or the money traded in it), green or red by its move over the last session, week or month. Tap a tile for the stock |
| **Market → Predictions** | Three numbers on how good the model is, its live check and how its daily top 10 did lately, then today's ranking: each actively traded stock's chance of reaching its target before its stop within 2 weeks, what trades rated like it made on average, its chart stop/target and ▲▼ for its move in rank. *How it was tested* (the BUY rules with and without it, and the model's details) opens on a tap. Information only |
| **Market → Dividends & results** | Every EGX company's cash dividends from TradingView (coming up, highest yields), the companies whose results are expected in the next 6 weeks, and the bonus shares, rights issues and splits announced on Mubasher. Recent dividends and last year's bonus shares open on a tap |
| **Stocks → Stock** | One summary card on top: the verdict (Buy / Hold / Sell / Wait / Avoid, and why) and the stock's **rating** out of 100 with its reason in one line (see below); the live price next to the close during the session; four key numbers (3-month change, 1-year low–high, money traded a day, P/E). Then the agent's chart (always first) or TradingView's live chart. The agent's chart has daily, 4-hour and 1-hour candles, the support and resistance zones shaded, Fibonacci levels on a tap, averages, volume, RSI, MACD, your levels and your buys/sells marked; a *Stop-loss & target* card gives every stock's stop and target from the chart with the support and resistance behind them; your position as the same card as on Today; why a stock isn't a BUY yet (on a tap); the company's numbers (P/E, growth, margins, debt) next to its sector's; news and anything to know now; dividends and Shariah details open on a tap |
| **Stocks → Screener** | Every stock in one table, best rated first: rating, trend (above its 20/50/200-day averages), RSI, 1- and 3-month returns, the model's top picks, dividend yield, P/E, next ex-dividend date and signal. Ready-made lists in one tap (Best rated, Shariah and close to a BUY, Ex-dividend in the next 30 days, At a 1-year high, Cheapest on P/E, Uptrend with volume, High dividend yield), the main filters, and **More filters**, remembered on the device |
| **Stocks → Watchlist** | The stocks you starred (☆ on a stock's page or in the Screener) with their numbers. Kept with your portfolio (on the site: in your browser and its backups). In Telegram, the website's bot answers `/watch COMI` (a BUY signal), `/watch COMI 45` (a close past 45), `/watch COMI levels` (a close near a strong support, or at resistance), `/unwatch COMI` (`/unwatch all`) and `/list`, checked after each close; it also answers `/stock COMI` (or just `COMI`), `/why COMI` (its rating and what stocks rated like it did, the BUY rule's checks passed or not, and the chart's levels), `/top`, `/top 20` and `/buys` from the website's data. *Connect Telegram* in Settings also links your portfolio (or send `/link` and type its code there): your browser then sends the bot a copy whenever it changes, so `/portfolio` and `/watchlist` answer there too and each close's message says what to do with your positions (`/unlink` deletes the copy). The bot reads messages every few hours, or at once after a one-time double-click on **Set up instant Telegram replies.command** (a free Cloudflare Worker, `worker/bot.js`) |
| **Portfolio → My portfolio** | Account value, open and closed profit/loss (live during the session) and the loss if every stop were hit, then three tabs. **My stocks**: each position as a card (what to do, price, profit/loss after fees and dividends, stop to target, days held of 20); *Sell or edit* opens the sale form, a cash dividend, its transactions, or deleting it if it was logged by mistake. Buying more of a stock you hold joins it at the average price. **Checkup**: a checkup against your own limits (one stock over 25% of the account, over 40% in one sector, too many stocks, too much at risk, stocks that move together, cash below zero), each with what to do; your account against EGX30 and a bank deposit (the interbank rate, added daily) since your first buy, **in pounds, dollars or grams of gold**; money by sector, what you'd lose if every stop were hit, and how closely your stocks move together. On the website, **Add from a screenshot** fills in your holdings from a picture of your broker's portfolio screen (Thndr or another): the bot reads it with Cloudflare's free AI, you check every row, then each is logged like a buy (the picture isn't kept; 20 a day). **Past trades**: win rate, average win and loss, profit factor, results by signal setup, exit reason and month, and your profit after Egypt's inflation |
| **Portfolio → Practice** | A virtual 100k account the agent trades by itself. Watch it for 3–4 weeks before using real money |
| **Portfolio → Calculator** | **Position size**: how many shares to buy with your own risk rules (the same sizing as the BUY signals): amount, fees, loss at the stop, gain at the target, and a check against your portfolio limits. Full or half size. **Zakat**: 2.5% of your shares at market value plus your cash and savings, less debts due, when it's over the nisab (85 g of 21-carat gold, as Dar al-Ifta counts it; 24-carat on a tap), from today's gold price. **Bank certificate**: what the same money earns a month or at the end over 1 or 3 years, after inflation, and the return your trades need to beat it |
| **Portfolio → Rules test** | Replays the exact rules on 1–4 years of history and compares with EGX30. The last result is kept |
| **⚙ → Settings** | Telegram alerts and the daily scan, then every number the agent uses: capital, risk, fees, filters, Shariah filter, exits. Plus the data status and refresh buttons |

Old links (from Telegram or bookmarks) still open the same page. Handy: press **/** to search any stock by symbol or
Arabic name. On the chart, use the 3M…All buttons to zoom and drag to move.

**Look.** Graphite and gold: dark by default, with a light theme in the ⚙ menu. Gold marks what you can press and
where you are; green and red only mean up and down. Each page shows the main thing first; details, caveats and
history open on a tap.

**Arabic.** العربية in the ⚙ menu switches the whole site to Arabic, right to left (English switches
back); each device remembers its choice. Menus, titles, labels, buttons and explanations are translated
(`app/static/js/i18n.js`), and so are the agent's own notes (a signal's reasons, an order's details, the exit rules'
notes, sizing notes, sector names), by their patterns (`tn()`); anything new it doesn't know yet shows in English.
The password screen has its own English/العربية button.

**Market words explained.** Words with a dotted underline (stop-loss, target, 50-day average, breadth, RSI, ADX,
risk-off, ex-dividend, results…) show a two-line explanation when you tap them. Longer fine print sits under
*Details* links you can open.

**Live prices** come from TradingView, about 15 minutes late. Your position cards and a stock's page ask TradingView's
screener for the latest price once a minute during the session (on the website through its bot, `worker/bot.js`
`/quotes`; on the Mac through the dashboard), and show the profit/loss at that price, with a warning when it has
already crossed your stop or reached your target. The signals, stops and targets still come from the last close,
because the rules were tested on closing prices. The live chart on a stock's page is TradingView's own box, sealed
off from the page.

## Alerts on your phone

In **Settings → Alerts**:

1. **Telegram.** In Telegram, open @BotFather, send `/newbot` and answer its two questions. Paste the token it
   gives you into Settings, open your new bot, press **Start**, then press **Connect**. After each scan you get
   the orders for the next session. Switch on *Only message me on days with something to do* for fewer messages.
   The token stays in `config.yaml` on this Mac and is only sent to Telegram.
2. **Daily scan.** Turn it on to scan by itself Sunday–Thursday at 15:45, even when the dashboard is closed. It
   tries again at 18:00 and 21:00 if prices were late. Your Mac needs to be on; if it's asleep, the scan runs as
   soon as it wakes. Each run is logged in `data/daily.log`. Turning it off removes it completely.
3. **Alarms.** With Telegram connected, you also get a message when something breaks, and another when it's fixed
   (`app/health.py`): a scan that crashed, no new closing prices for 2 sessions in a row (a long holiday looks the
   same, so the message says so), a data source (prices, Egypt data, dividends, a news site, Kashif) failing on
   every try for a whole day, the prediction model not retrained for 40 days, or its live picks no better than the
   average stock. One bad run doesn't count.
4. **Weekly summary.** After Thursday's close (or on Friday if Thursday's scan came late): the week's EGX30 move,
   the market switch, the week's BUY signals, how the month before's signals are doing, your positions, the paper
   account and whether the prediction model is on track.

## Bonus shares, splits and dividends

When a company gives bonus shares (or splits its shares), TradingView divides all its past prices by the ratio.
The agent notices, and any position you bought before that date shows **UPDATE SHARES**, first in the orders
list. Open it on My Portfolio, check your new share count at your broker and press *Update position*. Your average
price, stop and target move by the same ratio, and what you paid in total doesn't change. If your shares didn't
change, choose *My shares didn't change*. Paper trades are updated by themselves.

Record cash dividends from the position on My Portfolio (*Record a cash dividend*). They count in that position's
P&L and in your realized P&L.

**Cash dividends and your stop.** On the ex-date the price opens lower by the dividend, which you receive in cash,
so the agent moves that position's stop and target down by the same amount that day. The evening before, the orders
list says *Lower your … stop to … before the open*, so the drop alone doesn't sell you. Paper trades are paid their
dividends automatically, and the backtest counts them too. The whole dividend history comes from TradingView:
its chart "adjusted for dividends" parts from the normal one by exactly each dividend on its ex-date
(`egx_agent/data/dividends.py`; a few stocks each run, every stock again each month). Tested 2016–2026, counting
dividends took the rules' backtest from 13.6% to 14.4% a year, and moving the stop for them to 14.8%.

## Shariah badges

Every stock shows two small boxes:

- **EGX33 ✓ / ✗**: membership of the EGX33 Shariah index, read from Kashif's index list. Kashif currently lists
  29 of the 33 members. If you know a missing one, add it under *Settings → Extra EGX33 members*.
- **Kashif 🟢 / 🔴 / 🕐 / 🚫**: the status on [kasheif.com](https://kasheif.com). Hover for purity grade, purification %
  and statements date. Click to open the stock on Kashif.

By default this is information only. To only get BUY signals for compliant stocks, choose a filter in
*Settings → Shariah filter*. Kashif data refreshes weekly.

## The rules in one minute

- **Stocks:** all EGX stocks with at least 5M EGP traded per day, price ≥ 1 EGP, one year of history. The list is
  Kashif's, plus (weekly) the stocks on TradingView's EGX list that Kashif leaves out, several of them big banks
  (Housing & Development, QNB, Suez Canal Bank…). Those have no Shariah status, so a Shariah filter skips them.
- **Order:** when there are more BUYs than money or slots, the prediction model's rank decides who goes first.
- **Model picks:** the model's top 3 stocks of the day that pass the same liquidity and uptrend checks are BUYs too,
  with the usual stop, target and sizing (none while EGX30 is under its 50-day average, or while the model's live
  results show no edge). *Settings → Prediction model's own BUYs a day* (0 turns it off).
- **Entry (breakout):** price above its 20- and 50-day averages, closes above its 20-day high on at least
  1.5× normal volume, ADX above 20. Stocks are scored 0–100 (trend, strength vs other stocks, volume,
  room to run) and need 70+.
- **Size:** shares = 1.5% of your account ÷ (entry − stop), capped at 25% of the account per stock, 5 positions,
  2 per sector, 6% total risk.
- **Stop and target from the chart:** the agent marks support and resistance from swing lows/highs of the last
  year, Fibonacci retracements (23.6–78.6%) and extensions (127.2%, 161.8%) of the latest big rise, the 20- and
  50-day averages, monthly pivot points, the most-traded price of 6 months and the 1-year high. Levels close
  together make one zone; the more tools agree, the stronger it is. The **stop** goes just under the nearest solid
  support (at least a normal day's move away, at most 12%); the **target** just under the first resistance that pays
  at least 1.5× the risk (at most 3×). With nothing usable on the chart it falls back to the old rule (stop 2× the
  daily range, kept 4–12%; target 2× the risk). Every stock's page shows its levels. Settings → Exits switches back
  to the fixed rule. Tested on 2016–2026 years the prediction model never saw: the BUY rules made 13.4% a year with
  chart levels vs 7.8% with the fixed rule, worst drop −20% vs −22%; with the model's own picks 24.4% vs 27.7%
  (the fixed rule's lead is all in the 2021–26 boom; 2016–21: 13.4% vs 9.2%), worst drop −22% vs −26%.
- **Exits:** each evening the stop rises to just under the nearest solid support below the price (never down); it
  also moves to the buy price plus 1.5% after +1× risk (enough to cover both fees, so a trade that comes back still
  ends a small win), then trails 2× the daily range under the highest close. The target stays
  where it was set. Exit on a close below the 50-day average; **review at day 10 (2 weeks), hard exit at day 20
  (1 month)**. The rising stop, tested on 2016–2026 years the model never saw, with its picks: 31.8% a year against
  22.3% for the stop that waited for +1× risk (worst drop −25.2% against −22.7%); the rules alone 20.4% against 13.4%.
  The +1.5% floor (Oct 2026, 4 seeds): 48.0% of trades won against 44.9% with the stop at the buy price, higher in
  every seed, the same 33.7% a year, worst drop −17.9% against −18.3%.
  A logged buy takes the chart's stop and target for its buy date, however late you log it. Your stock page shows one
  stop and one target, each with where it comes from, and the next resistance above the target.

## Backtest results (Sep 2022 – Sep 2026, default settings)

| | Oldest 2 years | Latest 2 years | All 4 years |
|---|---|---|---|
| Agent | +38% | +31% | +91% |
| EGX30 buy & hold | +212% | +74% | +443% |
| Profit factor | 1.21 | 1.20 | 1.24 |
| Worst drop | −21% | −17% | −21% |

Be honest with yourself about these numbers:

- **The agent made money in both halves, but far less than simply holding EGX30.** Much of EGX30's rise is the
  pound's devaluation, which a strategy that is often in cash doesn't capture.
- **Fees matter a lot.** Around 100 trades a year at 0.25% per side cost roughly half the gross profit. Set
  your broker's real fee in Settings.
- Only today's listed stocks are tested (survivorship bias), so real results would likely be somewhat worse.
- Pullback and MACD entries lost money in testing, so they're off by default (you can enable them in Settings).

## The prediction model (Predict page)

**What it predicts.** After each close, for every liquid stock: if you bought at the next open with the agent's usual
plan (the stop and target from that day's chart: just under the nearest solid support and resistance, as on the
stock page; with *Settings → Exits → Stop & target from* set to the ATR rule, stop 2× the average daily range below
and target 2× the risk above), what is the chance the **target is reached before the stop** within 10 sessions
(~2 weeks) and within 20 sessions (~1 month)? If both are touched on the same day it counts as a loss. Trained on the
chart's trades, the rules-plus-its-picks backtest made 26.5% a year against 24.4% when it learnt the ATR ones.
*Expected* on the Predict page is what trades it scored like this averaged in its tests, after fees.

**How it learns.** Press *Train the model* on the Predict page once. The first time it downloads 10 years of prices
(about 4 minutes); then it trains for about 2 minutes. One gradient-boosting model per horizon learns from every
liquid EGX stock since about 2013 (≈250,000 past examples) using 47 measures: trend, momentum, volume,
volatility, the stock against its sector, and the whole market's breadth. "Liquid" is judged in the money of its
time, so 2017's stocks aren't measured against today's 5M EGP rule.

**How it's tested.** Walk-forward: each year from 2017 on is predicted by a version trained only on the years
before it, with a gap so no test trade overlaps a training trade. The page shows those results, not results on data
the model has seen. The chances are calibrated on those results, so "22%" means about 22 in 100 did.

**Results when it was built (Sep 2026, your data):**

| 10 sessions, 2017–2026, never-seen years | Target first | Average result |
|---|---|---|
| The model's top 10% each day | 21% | +0.94% |
| The average liquid stock | 13% | +0.27% |
| The bottom half | 11% | +0.02% |
| Rule BUYs the model also liked | 29% | +2.07% |
| Rule BUYs it didn't | 23% | +0.85% |

The top 10% beat the average stock in all 10 years (AUC 0.59, graded *Useful*). The 20-session model is weaker
(*Small edge*). Even its best picks usually don't reach the target, so always use the stop.

**Egypt data.** Each scan also downloads USD/EGP, the interbank interest rate, inflation and
EGX70 from TradingView (`egx_agent/data/macro.py`); each is used only from the day it was published. It also downloads
the gold price for your account in gold and the zakat nisab; the model doesn't use it. In the
Sep 2026 tests it lifted the 20-session model's top 10% from +1.03% to +1.18% a trade (and it beat the average stock
in every year). The 10-session model did no better with it alone, but did with the dividend events below, so since
Sep 2026 both use it. Also tested and **not** used: a
model that ranks the day's stocks against each other, one that predicts the return, other stop/target plans, and
weighting recent years more; none beat the model above. Days a stock couldn't really be bought (no trading, or stuck
at one price all day) are left out of the tested and live results.

**Dividends, bonus shares and rights issues (both models).** Each scan also reads Mubasher's list of corporate
actions, taken from the exchange's filings: every EGX company's cash dividends, bonus shares, rights issues and
buybacks since 2005, with the day each was announced and its ex-date (`egx_agent/data/news.py`). The model sees how
many days until the next announced ex-date and since the last announcement, each only from the day after it was
announced. In the Sep 2026 tests (several random seeds) it lifted the 20-session model's top 10% from +1.21% to
+1.41% a trade (better than the average stock in 10 of 11 years, from 8), and the 10-session model's, now with the
Egypt data and the same LightGBM model, from +0.90% to +1.04% (10 of 11 years, from 9). Rule BUYs with an ex-date
inside the month reach the target less often (the price drops by the dividend), but counting the dividend itself
they did better than the others (+2.9% against +1.7% a trade, 38 trades), so they aren't skipped: the stop moves down
for the dividend instead, and the signal says so.

**Company results (both models, since Oct 2026).** The same TradingView request as the dividends brings every EGX
company's last 32 quarters and about 20 years of results (`egx_agent/data/fundamentals.py`). The model sees each
company as it was known on each day: profit, sales and free cash for its price, its dividend yield, profit and sales
growth over a year, the last quarter against the same quarter a year before, the profit margin, return on assets,
debt against assets, whether it made a profit, and how cheap, fast-growing and profitable it is against the other
stocks that day. A quarter counts only 120 days after it ends (150 for the fiscal year's last one), later than most
companies publish, so the tests never use numbers that weren't out yet. In the Oct 2026 tests (4 random seeds, the
rules plus the model's picks replayed day by day on 2016–2026): **33.8% a year against 30.8%, the worst drop −18%
against −26%**, better in both halves. Counting quarters as known after 75 days did worse in the second half, and only
a few of the numbers (value and growth) did worse than all of them. The 20-session model neither gains nor loses.

**What was tested for the BUY rules (Oct 2026) and left as it is.** Skipping companies that lost money or whose
profit shrank, or the dearest 30% for their profit, made the drops smaller but cut the return more (breakouts in
companies that lost money did *better* over two weeks: 32% reached the target against 22%). A lower or higher score
bar (60 or 80 instead of 70), 2 or 5 model picks instead of 3, and adding the pullback and MACD setups did no better.
Taking only the rule BUYs the model ranks in its top 30–40% helped the old model, but not the one with company
results. So the company results change the BUYs through the model: its rank orders them and picks 3 more.

**Judged on winning trades (Oct 2026).** From then on a change is kept only if more trades win *and* the yearly
profit doesn't fall (4 seeds, 2016–2026). With today's rules 44.9% of trades win, 33.7% a year. The count of model
picks (1–5), skipping rule BUYs the model ranks low, comparing a company's numbers with its own sector's, a closer
target (1–1.25× the risk, also with the model retrained for it) and a shorter or longer hold all moved the winners by
under a point or cost profit: the closer target won 48% but made 31% a year. Only the +1.5% floor under the stop
passed (Exits above). Each BUY card and Close to a BUY row shows the model's reason in one line: what lifted its
rating most from the chart and from the company's results, and what lowered it. The track record warns (on the site
and in Telegram on days with BUYs) once 30 signals have ended and 10 points fewer of them won than in the test.

**News.** Headlines from Mubasher (each stock's page, Arabic and English, and the latest Egypt news), Reuters and
Zawya (through TradingView, tagged to the stock), Al Borsa News and Daily News Egypt. Only headlines, dates and links
are kept. Each gets topics and a good/bad tone from keyword rules. Bad news this week shows as a caution on signals,
positions and the stock page. The tone isn't in the model yet: there's only about a year of history, too little to
test fairly, so it's being recorded to test later. Mubasher asks for 5 seconds between pages, so each run reads the
day's signals and your stocks first, then the others in turn (every stock every few days).

**Market switch.** From breadth (the share of stocks above their 50-day average): below 40% *no new buys*, 40–50%
*half size*, otherwise *full size*. It's for the model's picks: tested 2016–2026 on its top 5 every two weeks, it
took them from 27% to 34% a year and cut the worst drop from −62% to −22% (every cut-off from 30% to 50% did about as
well). It barely changed the BUY rules' backtest, so they keep their own EGX30 rule. Shown on Today, Market, Predict
and in Telegram.

**After that** it updates its numbers after every scan and retrains by itself once a month (or after you change
the stop or target settings, or the model's design changes). It gives a chance only for its top 10% each day: its
test results are about those. *Since it went live* shows how this version's predictions turned out, next to its
test results. That's the real test.

**How the BUYs use it (since Sep 2026).** Its 10-session rank decides which BUYs get money first, and its top 3 picks
that pass the liquidity and uptrend checks are BUYs too. Each retraining replays the rules day by day on the years
it was tested on, with only the scores it gave before seeing each year, and shows the result on the Predict page. When
it was built (2016–2026, dividends counted): the rules alone 15.3% a year, in the model's order 19.8%, plus its top 3
26.9% with the same worst drop (−20%), better in each half: to Aug 2021 (7.5% → 11.0%) and after (25.0% → 46.9%). Several versions were tried, so the best one flatters itself
a little: the live record is what counts.

**The live check.** After every scan it compares the last 60 decided sessions of its live top picks with the
average stock (`predict.health`). *On track*, *weaker* or *not working*: when it's not working (its picks no better
than the average), it adds no BUYs of its own, you get an alarm, and it goes back to normal by itself once it works
again.

**Why it likes a stock.** Each stock's strongest reasons up (green) and down (red), from the model's own trees (like
SHAP), on the Today cards, the Predict table and the stock page. Whole-market measures are left out: they move every
stock alike.

**The rating (1–100).** Where the 10-session model's score puts a stock among that day's liquid stocks: 100 is its
first, and 91–100 is its top 10%. It's on each stock page (with the reasons), in the Screener (its default order) and
in the bot's `/why`, next to how stocks rated in the same band did on the years the model never saw. When it was built:
91–100 reached the target first 21% of the time (+0.9% a trade after fees), 71–90 17% (+0.5%), 51–70 14% (+0.3%),
1–50 10% (+0.0%); the average stock 13%. The rules' own BUY score isn't used for it: it barely changed the odds in the
10-year test. Since Oct 2026 it mixes the chart and the company's results (the model sees both). Illiquid stocks get
no rating.

**Honest numbers.** The Predict page also shows its top 5 as a test portfolio (every 10 or 20 sessions, sized by the
market switch), the same with 0.5% more cost per trade, and whether its chance numbers beat simply giving every stock
the average chance (checked year by year). For 20 sessions they don't: use its rank, not the %.

**5-day experiment (paper only).** A third model picks 5 stocks to buy at the next open and sell 5 sessions later.
Its tests look strong (with the market switch, +65% a year even with 0.5% more cost), but it trades every week and
has no stop, so it's only tracked on the Predict page. It won't become signals unless its live results match its
tests for a few months.

**Tested and not used (Sep 2026):** other exits (trailing sooner or later, wider or tighter, no trend exit, partial
profits, other time limits; none was better in both halves), Bollinger/volume/company-size measures (no gain),
ChatGPT's 3-group 5-day target (worse than the agent's own), and companies that left the exchange (TradingView has no
prices for them, so the tests still see only today's companies).

## The website for friends (GitHub Pages)

The agent also runs as a free, private website on GitHub Pages, so friends can use it for their own portfolios
without a server and without your Mac being on.

- **Every trading day** GitHub runs the scan by itself after the close (`.github/workflows/site.yml` →
  `app/site_daily.py`): new prices, signals and the prediction model (monthly), then it publishes the site.
  Nothing to do on your side. The run's page on GitHub shows a one-line summary (counts only).
  A scan during trading hours is redone after the close; Telegram waits for that one.
  The site has no Paper Trading or Backtest pages: those stay in the Mac app.
- **On time.** GitHub starts its timed runs late, or skips them, when it's busy (on 29 Sep 2026 nothing ran between
  16:16 and 21:18 Cairo time). So the Telegram bot (`worker/bot.js`, a Cloudflare timer every 10 minutes) checks
  after each close whether that close's scan has arrived and, if not, starts it on GitHub at 15:40, 16:10, 16:40,
  17:40, 19:10 and 21:10 Cairo time until it has. It needs a GitHub key that can only start this repository's runs:
  double-click **Set up on-time scans.command** once. A run that finds no new prices tries again 25 minutes later
  (the Mac still waits 2 hours).
- **One group password.** Everything the scan publishes is encrypted with it (AES-256, key from the password with
  600,000 PBKDF2 rounds), so the link alone shows nothing. Friends type it once per device. To remove someone,
  change the `SITE_PASSWORD` secret and give the new one to the others.
- **Each friend's portfolio stays in their own browser**: buys, sells, dividends, bonus-share updates and
  their own numbers (capital, risk, Shariah filter). Nobody else sees it, not even you. Once they connect Telegram
  (below), the bot keeps a copy for their chat only, and each of their devices they connect brings the newest one
  (the latest change wins; *Bring my portfolio from Telegram* in Settings does it by hand). Without Telegram,
  *Settings → Download a backup* / *Restore from a backup* moves it. On iPhone, use the site from its Home Screen
  icon (Safari can delete a website's data after 7 days without a visit).
- **Opens at once, even offline.** The site keeps an offline copy of its code and the last close's data on the
  device (`app/sw.js`), so the Home Screen app opens straight away and shows the last close with no signal. After an
  update, a page still holding the old front page reloads itself once instead of showing a blank screen.
- **Same rules as the Mac.** The browser runs a copy of the exit and sizing rules
  (`app/static/js/local/`), and `tests/test_static_site.py` checks it gives exactly the same answers.
- **Telegram, to each friend:** with the `TELEGRAM_TOKEN` secret set (your bot's token), each friend presses
  *Settings → Connect Telegram* on the site, then Start. The bot answers "Connected" at once (with the Cloudflare
  Worker; otherwise the job checks for new people every 3 hours), and from then on sends each of them the day's
  signals after every close (without share counts: each person sizes them on the site). The same tap links that
  browser's portfolio: after each close the job checks their positions with the exit rules and adds **their own
  orders** to the message (sell at the open, move a stop up, decide on day 10, lower a stop for a dividend). `/stop`
  stops them. The link comes from the password, so only people who can open the site have it, and changing the
  password disconnects everyone until they press the new link. After Thursday's close each friend also gets the
  week's summary (`/weekly off` stops it); `/quiet` sends the close's message only on days with a BUY or something to
  do with their positions. At **9:30 on a session morning** the bot reminds each friend what to do at the open (their own
  orders, then the BUYs), only on days with something to do (`/morning off` stops it). Replies and messages are in Arabic for people whose Telegram is in Arabic (`/lang` to
  switch). The bot answers a stock's symbol or part of its Arabic name (and suggests the closest for a typo), has
  buttons under its answers (an alert, the stock's page), and sets its own command menu in both languages.
  **Open the app** (a button under its messages) opens the website inside Telegram: Telegram vouches for a
  connected friend, so there's no password to type there, and their portfolio comes with them.
- **Alarms, to you only:** add the `OWNER_TELEGRAM` secret with your Telegram @username and press *Connect
  Telegram* on the site like a friend. You then get the same alarms as on the Mac (a failed run, prices stuck
  for 2 sessions, a source down for a day, the model not retrained), once when they start and once when they're
  fixed. Friends never get them. Without it, GitHub's own e-mail about a failed run is the only alarm.
- **Backups.** The site's data (prices, signals, the model's live record, who connected on Telegram) lives in
  GitHub's cache between runs. Once a day it's also saved as a locked file kept for 30 days (`app/backup.py`,
  the `state-backup` file on a run's page). It opens only with the site password *and* the bot token, so friends
  can't open it. If the cache is ever lost, the next run brings back the latest backup by itself.
- **GitHub's machine is pinned to Ubuntu 24.04**, so GitHub moving "latest" to a new Ubuntu can't break a run
  overnight. Move it on purpose, after a test run, before 24.04's support ends.
- **The strategy** is yours: change it in Settings on the Mac, then double-click **Publish website.command**. It
  sends only the code and the rules (`site/strategy.yaml`); your portfolio, `config.yaml` and the Telegram token
  stay on the Mac (see `.gitignore`), and it refuses to publish if the token would be included.
- **Keep it small and private.** Sharing signals publicly can need an FRA licence, and the free TradingView data
  isn't meant for public websites.

The multi-user server version (logins, invites; `app/auth.py`, `app/accounts.py`, `python -m app.server
--server`) is still in the code if you ever want a real server.

## Results dates

The same TradingView request that brings the dividends also brings each company's last results date and
TradingView's **expected** date for the next ones (`earnings` table, `egx_agent/data/dividends.py`). They're
estimates from when the company reported before; EGX companies often publish a few days earlier or later.
Companies whose last results on TradingView are more than 13 months old get no expected date. A stock with results
expected before a trade would end shows a *Results* note (on Today, the watchlist, the stock page and your
positions) and the Market page lists the ones coming in the next 6 weeks. It's information only: the rules don't
skip or resize for results, because the tests didn't cover them.

## Data sources

- **Prices:** TradingView via the free, unofficial `tvdatafeed` library. It sometimes drops connections, so the
  agent retries. Some renamed companies use a different code on TradingView than on Kashif (e.g. AIHC → AIH,
  ANFI → TYCN); these are translated automatically, and you can add more under *Settings → TradingView code overrides*.
  Each scan also downloads about 8 months of hourly bars per stock for the 1-hour and 4-hour charts (the 4-hour
  bars are made from them, 10:00–14:00 and 14:00 to the close, as on TradingView); only the charts use them.
- **Stocks with no prices anywhere** (listed in *Settings → Data*):
  - **Listed but never traded:** ACFR, ANCC, DCCC, EFAC, GEOS, KNGC, NMIN, POCO, SIEG. They show only a par-value quote
    with zero volume, so no website has a price history for them. The agent re-checks weekly and adds them once
    they trade (they need about a year of trading before they can get BUY signals).
  - **Suspended:** SIMO (trading halted on EGX since December 2018).
- **Shariah, sectors and index membership:** kasheif.com public search pages, read once a week, slowly.

If the free price source stops working, the code is ready for a paid provider (EODHD / Twelve Data) in
`egx_agent/data/prices.py`.

## Files

- `config.yaml`: your settings (created when you first save Settings)
- `data/egx.db`: prices, Shariah data, scans and your trades. **Back this up.**
- `data/last_backtest.json`: the last backtest result
- `data/daily.log`: what the daily scan did each time it ran
- `data/models/`: the trained prediction model and its test results
- `app/static_site.py` builds the GitHub Pages site, `app/site_daily.py` is its daily job, `app/static/js/local/` runs your portfolio in the browser, `app/sw.js` is its offline copy, `site/strategy.yaml` is the strategy it uses
- `worker/bot.js`: the Telegram bot on Cloudflare (instant replies, on-time scans, the 9:30 reminder, the portfolio link, the mini app, reading a broker screenshot with Cloudflare's free AI); `node worker/bot.test.mjs` tests it
- `app/health.py`: the alarms (what counts as broken, sent once when it starts and once when it's fixed) · `app/backup.py`: the site's locked daily backup
- `deploy/` (kept on this Mac only): the older Oracle server plan; `app/auth.py` and `app/accounts.py` are its logins
- `egx_agent/`: the analysis code (`levels.py`: the chart's stop and target; `record.py`: the signals' track record
  and their odds by score, a 10-year replay once a week) · `tests/`: automated checks (`.venv/bin/python -m pytest`)
- `app/`: the dashboard. `server.py` is a small local web server (FastAPI) that sends data to the page in `app/static/`
  (Preact, with TradingView's Lightweight Charts saved in `app/static/vendor/`, so it needs no build step).
  `alerts.py` sends the Telegram messages, and `daily.py` is the daily scan that `schedule.py` sets up with macOS
