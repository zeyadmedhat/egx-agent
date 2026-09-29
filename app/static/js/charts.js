// Charts drawn with TradingView's Lightweight Charts (vendored in /static/vendor).
import { html, useEffect, useRef, useStore, cssVar, fmt } from './lib.js';
import { t as tr } from './i18n.js';

const LWC = window.LightweightCharts;

function palette() {
  const v = n => cssVar(n);
  return {
    text: v('--text-2'), text3: v('--text-3'), grid: v('--grid'), border: v('--border'), panel: v('--panel'),
    up: v('--up'), down: v('--down'), accent: v('--accent'), warn: v('--warn'), violet: v('--violet'),
  };
}

export function alpha(color, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function baseOptions(t, extra = {}) {
  return {
    autoSize: true,
    layout: {
      background: { type: 'solid', color: t.panel }, textColor: t.text, fontSize: 11,
      fontFamily: getComputedStyle(document.body).fontFamily, attributionLogo: true,
      panes: { separatorColor: t.border, separatorHoverColor: t.border, enableResize: true },
    },
    grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
    rightPriceScale: { borderColor: t.border },
    timeScale: { borderColor: t.border, rightOffset: 3 },
    // The mouse wheel scrolls the page; zoom with the range buttons or by dragging the axes.
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
    crosshair: {
      mode: LWC.CrosshairMode.Normal,
      vertLine: { color: t.text3, labelBackgroundColor: t.text3 },
      horzLine: { color: t.text3, labelBackgroundColor: t.text3 },
    },
    localization: { locale: 'en-US' },
    ...extra,
  };
}

const points = (time, values) => time.map((t, i) => (values[i] == null ? { time: t } : { time: t, value: values[i] }));
const showRange = (chart, n, bars) => chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - bars), to: n + 2 });

// Shaded price bands across the whole chart, behind the candles: support and resistance zones.
// bands: [{ low, high, color }]
class Bands {
  constructor(bands) { this.bands = bands; this.series = null; }
  attached({ series }) { this.series = series; }
  detached() { this.series = null; }
  updateAllViews() {}
  paneViews() {
    const self = this;
    const draw = target => target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, verticalPixelRatio: vr }) => {
      if (!self.series) return;
      for (const b of self.bands) {
        const pad = b.high === b.low ? b.low * 0.002 : 0;      // a zone from one level: a thin band around it
        const y1 = self.series.priceToCoordinate(b.high + pad), y2 = self.series.priceToCoordinate(b.low - pad);
        if (y1 == null || y2 == null) continue;
        const top = Math.round(Math.min(y1, y2) * vr);
        ctx.fillStyle = b.color;
        ctx.fillRect(0, top, bitmapSize.width, Math.max(Math.round(Math.abs(y2 - y1) * vr), Math.round(2 * vr)));
      }
    });
    return [{ zOrder: () => 'bottom', renderer: () => ({ draw() {}, drawBackground: draw }) }];
  }
}

// A bar's time for the legend: a date for daily bars, a date and the hour for the 1-hour and 4-hour charts (their
// times are Cairo's clock written as UTC seconds).
function barTime(time) {
  if (typeof time !== 'number') return fmt.date(time);
  const iso = new Date(time * 1000).toISOString();
  return `${fmt.date(iso.slice(0, 10))} ${iso.slice(11, 16)}`;
}

// ------------------------------------------------------------------ price chart (candles, averages, volume, RSI, MACD)
// chart: the stock's support/resistance plan (levels.py): its zones are shaded when show.zones, its Fibonacci
// levels drawn when show.fib.
export function PriceChart({ series, levels = [], fills = [], bars = 250, show, chart: plan = null }) {
  const box = useRef();
  const legend = useRef();
  const chartRef = useRef();
  const theme = useStore(s => s.theme);

  useEffect(() => {
    const t = palette();
    const T = series.time;
    const n = T.length;
    const intraday = typeof T[0] === 'number';
    const chart = LWC.createChart(box.current, baseOptions(t, intraday
      ? { timeScale: { borderColor: t.border, rightOffset: 3, timeVisible: true, secondsVisible: false } } : {}));
    chartRef.current = chart;

    const candles = chart.addSeries(LWC.CandlestickSeries, {
      upColor: t.up, downColor: t.down, borderUpColor: t.up, borderDownColor: t.down, wickUpColor: t.up,
      wickDownColor: t.down, priceLineStyle: LWC.LineStyle.Dotted,
    });
    candles.setData(T.map((time, i) => (series.close[i] == null ? { time } : {
      time, open: series.open[i], high: series.high[i], low: series.low[i], close: series.close[i],
    })));
    const line = (values, color, pane = 0, opts = {}) => {
      const s = chart.addSeries(LWC.LineSeries, {
        color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...opts,
      }, pane);
      s.setData(points(T, values));
      return s;
    };
    if (show.ema) {
      line(series.ema20, t.accent);
      line(series.ema50, t.warn);
    }
    const levelColor = { entry: t.accent, stop: t.down, target: t.up };
    for (const l of levels) {
      if (l.price) candles.createPriceLine({
        price: l.price, color: levelColor[l.kind] || t.text3, lineWidth: 1, lineStyle: LWC.LineStyle.Dashed,
        axisLabelVisible: true, title: l.label,
      });
    }
    if (plan && show.zones) {
      const shade = (z, color) => ({ low: z.low ?? z.price, high: z.high ?? z.price,
        color: alpha(color, Math.min(0.05 + z.strength * 0.02, 0.2)) });
      candles.attachPrimitive(new Bands([...(plan.supports || []).map(z => shade(z, t.up)),
        ...(plan.resistances || []).map(z => shade(z, t.down))]));
    }
    if (plan && plan.fib && show.fib) {
      for (const f of plan.fib.levels) candles.createPriceLine({
        price: f.price, color: t.violet, lineWidth: 1, lineStyle: LWC.LineStyle.Dashed,
        axisLabelVisible: true, title: `Fib ${(f.r * 100).toFixed(1)}%`,
      });
    }
    if (fills.length && !intraday) {
      LWC.createSeriesMarkers(candles, [...fills].sort((a, b) => (a.date < b.date ? -1 : 1)).map(f => ({
        time: f.date, position: f.side === 'buy' ? 'belowBar' : 'aboveBar', color: f.side === 'buy' ? t.up : t.down,
        shape: f.side === 'buy' ? 'arrowUp' : 'arrowDown', text: `${f.side === 'buy' ? 'Buy' : 'Sell'} ${fmt.int(f.shares)}`,
      })));
    }

    let pane = 1;
    const stretch = [3.2];
    if (show.volume) {
      const vol = chart.addSeries(LWC.HistogramSeries, {
        priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false,
      }, pane++);
      vol.setData(T.map((time, i) => ({
        time, value: series.volume[i] || 0,
        color: series.close[i] >= series.open[i] ? alpha(t.up, 0.45) : alpha(t.down, 0.45),
      })));
      stretch.push(0.7);
    }
    if (show.rsi) {
      const rsi = line(series.rsi14, t.violet, pane++, { lineWidth: 1.3, lastValueVisible: true,
        priceFormat: { type: 'price', precision: 0, minMove: 1 } });
      for (const y of [70, 30]) rsi.createPriceLine({ price: y, color: t.text3, lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: false });
      stretch.push(0.7);
    }
    if (show.macd) {
      const p = pane++;
      const hist = chart.addSeries(LWC.HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, p);
      hist.setData(T.map((time, i) => (series.macd_hist[i] == null ? { time } : {
        time, value: series.macd_hist[i], color: series.macd_hist[i] >= 0 ? alpha(t.up, 0.5) : alpha(t.down, 0.5),
      })));
      line(series.macd, t.accent, p, { lineWidth: 1.3 });
      line(series.macd_signal, t.warn, p, { lineWidth: 1.3 });
      stretch.push(0.7);
    }
    chart.panes().forEach((pn, i) => pn.setStretchFactor(stretch[i] ?? 1));

    const writeLegend = i => {
      if (!legend.current || i < 0 || i >= n || series.close[i] == null) return;
      const prev = i > 0 ? series.close[i - 1] : null;
      const chg = prev ? series.close[i] / prev - 1 : null;
      const c = chg == null ? '' : chg >= 0 ? 'up' : 'down';
      const parts = [
        `<span>${barTime(T[i])}</span>`,
        `<span>O <b>${fmt.price(series.open[i])}</b></span>`, `<span>H <b>${fmt.price(series.high[i])}</b></span>`,
        `<span>L <b>${fmt.price(series.low[i])}</b></span>`,
        `<span>C <b>${fmt.price(series.close[i])}</b> <span class="${c}">${fmt.pct(chg, 2)}</span></span>`,
      ];
      if (show.ema) parts.push(
        `<span style="color:${t.accent}">EMA20 ${fmt.price(series.ema20[i])}</span>`,
        `<span style="color:${t.warn}">EMA50 ${fmt.price(series.ema50[i])}</span>`);
      parts.push(`<span>Vol <b>${fmt.short(series.volume[i])}</b></span>`);
      if (show.rsi) parts.push(`<span style="color:${t.violet}">RSI ${fmt.num(series.rsi14[i], 0)}</span>`);
      legend.current.innerHTML = parts.join('');
    };
    writeLegend(n - 1);
    chart.subscribeCrosshairMove(p => writeLegend(p.logical == null ? n - 1 : Math.round(p.logical)));
    showRange(chart, n, bars);
    return () => { chart.remove(); chartRef.current = null; };
  }, [series, levels, fills, plan, show.ema, show.volume, show.rsi, show.macd, show.zones, show.fib, theme]);

  useEffect(() => { if (chartRef.current) showRange(chartRef.current, series.time.length, bars); }, [bars]);

  return html`<div class="chart-box"><div class="chart-legend" ref=${legend}></div>
    <div ref=${box} style="position:absolute;inset:0"></div></div>`;
}

// ------------------------------------------------------------------ line comparison (equity vs EGX30, drawdown)
// lines: [{ data: [{time, value}], color: '--accent', title, dashed, area }]
export function LineChart({ lines, height = 320, format = 'egp' }) {
  const box = useRef();
  const legend = useRef();
  const theme = useStore(s => s.theme);
  useEffect(() => {
    const t = palette();
    const f = format === 'pct' ? v => fmt.pct(v, 1) : v => fmt.short(v);
    const chart = LWC.createChart(box.current, baseOptions(t, {
      localization: { locale: 'en-US', priceFormatter: f },
      timeScale: { borderColor: t.border, fixLeftEdge: true, fixRightEdge: true },
    }));
    const made = lines.map(l => {
      const color = cssVar(l.color || '--accent');
      const opts = { lineWidth: l.width || 2, color, priceLineVisible: false, lastValueVisible: true,
        lineStyle: l.dashed ? LWC.LineStyle.Dashed : LWC.LineStyle.Solid };
      const s = l.area
        ? chart.addSeries(LWC.AreaSeries, { ...opts, lineColor: color, topColor: alpha(color, 0.05), bottomColor: alpha(color, 0.35),
          invertFilledArea: true })
        : chart.addSeries(LWC.LineSeries, opts);
      s.setData(l.data);
      return { s, l, color };
    });
    const writeLegend = param => {
      if (!legend.current) return;
      legend.current.innerHTML = made.map(({ s, l, color }) => {
        const d = param && param.seriesData ? param.seriesData.get(s) : null;
        const v = d ? d.value : l.data.length ? l.data[l.data.length - 1].value : null;
        return `<span><span class="legend-dot" style="background:${color}"></span>${l.title} <b>${v == null ? '–' : f(v)}</b></span>`;
      }).join('');
    };
    writeLegend(null);
    chart.subscribeCrosshairMove(p => writeLegend(p.time ? p : null));
    const fit = () => chart.timeScale().fitContent();
    fit();
    const frame = requestAnimationFrame(fit);  // again once the chart knows its real width
    return () => { cancelAnimationFrame(frame); chart.remove(); };
  }, [lines, theme, format]);
  return html`<div class="chart-box" style=${`height:${height}px`}><div class="chart-legend" ref=${legend}></div>
    <div ref=${box} style="position:absolute;inset:0"></div></div>`;
}

// ------------------------------------------------------------------ small EGX30 chart on the Today page
export function Sparkline({ spark }) {
  const box = useRef();
  const theme = useStore(s => s.theme);
  useEffect(() => {
    if (!spark) return;
    const t = palette();
    const chart = LWC.createChart(box.current, baseOptions(t, {
      handleScroll: false, handleScale: false,
      grid: { vertLines: { visible: false }, horzLines: { color: t.grid } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.2, bottom: 0.08 } },
      timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
      localization: { locale: 'en-US', priceFormatter: v => fmt.int(v) },
    }));
    const last = spark.close[spark.close.length - 1], ema = spark.ema50[spark.ema50.length - 1];
    const color = last >= ema ? t.up : t.down;
    const area = chart.addSeries(LWC.AreaSeries, {
      lineColor: color, topColor: alpha(color, 0.28), bottomColor: alpha(color, 0.0), lineWidth: 2,
      priceLineVisible: false, lastValueVisible: true,
    });
    area.setData(points(spark.time, spark.close));
    const e = chart.addSeries(LWC.LineSeries, {
      color: t.warn, lineWidth: 1.5, lineStyle: LWC.LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    e.setData(points(spark.time, spark.ema50));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [spark, theme]);
  return html`<div ref=${box} style="position:absolute;inset:0"></div>`;
}

// ------------------------------------------------------------------ breadth: EGX30 on top, % of stocks above their averages below
export function BreadthChart({ h, height = 440 }) {
  const box = useRef();
  const legend = useRef();
  const theme = useStore(s => s.theme);
  useEffect(() => {
    const t = palette();
    const T = h.time;
    const n = T.length;
    const chart = LWC.createChart(box.current, baseOptions(t, {
      timeScale: { borderColor: t.border, fixLeftEdge: true, fixRightEdge: true },
    }));
    const pct = { type: 'custom', formatter: v => `${Math.round(v)}%`, minMove: 1 };
    const fixed = () => ({ priceRange: { minValue: 0, maxValue: 100 } });
    const index = chart.addSeries(LWC.AreaSeries, {
      lineColor: t.accent, topColor: alpha(t.accent, 0.2), bottomColor: alpha(t.accent, 0), lineWidth: 2,
      priceLineVisible: false, priceFormat: { type: 'custom', formatter: v => fmt.int(v), minMove: 1 },
    }, 0);
    index.setData(points(T, h.index));
    const toPct = xs => xs.map(v => (v == null ? null : v * 100));
    const a50 = chart.addSeries(LWC.AreaSeries, {
      lineColor: t.up, topColor: alpha(t.up, 0.28), bottomColor: alpha(t.up, 0.02), lineWidth: 2,
      priceLineVisible: false, priceFormat: pct, autoscaleInfoProvider: fixed,
    }, 1);
    a50.setData(points(T, toPct(h.above50)));
    a50.createPriceLine({ price: 50, color: t.text3, lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: '50%' });
    const a20 = chart.addSeries(LWC.LineSeries, {
      color: t.violet, lineWidth: 1.2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      priceFormat: pct, autoscaleInfoProvider: fixed,
    }, 1);
    a20.setData(points(T, toPct(h.above20)));
    a50.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.04 } });
    chart.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? 1.2 : 1));

    const writeLegend = i => {
      if (!legend.current || i < 0 || i >= n) return;
      legend.current.innerHTML = [
        `<span>${fmt.date(T[i])}</span>`,
        `<span><span class="legend-dot" style="background:${t.accent}"></span>EGX30 <b>${fmt.int(h.index[i])}</b></span>`,
        `<span><span class="legend-dot" style="background:${t.up}"></span>${tr('Above 50-day avg')} <b>${fmt.pct(h.above50[i], 0, false)}</b></span>`,
        `<span><span class="legend-dot" style="background:${t.violet}"></span>${tr('Above 20-day avg')} <b>${fmt.pct(h.above20[i], 0, false)}</b></span>`,
      ].join('');
    };
    writeLegend(n - 1);
    chart.subscribeCrosshairMove(p => writeLegend(p.logical == null ? n - 1 : Math.round(p.logical)));
    const fit = () => chart.timeScale().fitContent();
    fit();
    const frame = requestAnimationFrame(fit);
    return () => { cancelAnimationFrame(frame); chart.remove(); };
  }, [h, theme]);
  return html`<div class="chart-box" style=${`height:${height}px`}><div class="chart-legend" ref=${legend}></div>
    <div ref=${box} style="position:absolute;inset:0"></div></div>`;
}
