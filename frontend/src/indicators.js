// 前端計 EMA / UT Bot（同 scanner/indicator_scan.py 嘅 chart_series 一致）
// bars = [[o,h,l,c], ...]（舊→新），n = 圖上顯示棒數
const rp = (x) => (Math.abs(x) >= 10 ? Math.round(x * 100) / 100 : Math.round(x * 1e4) / 1e4);

function emaSeries(close, span) {
  const a = 2 / (span + 1), out = new Array(close.length);
  let e = close[0];
  for (let i = 0; i < close.length; i++) { e = i === 0 ? close[0] : a * close[i] + (1 - a) * e; out[i] = e; }
  return out;
}

// UT Bot：key_value 2、ATR 週期 1（= True Range）；返回每棒轉向（1 轉多 / -1 轉空 / 0）
function utFlips(bars, key = 2) {
  const n = bars.length;
  if (n < 7) return null;
  const c = bars.map((b) => b[3]);
  const stop = new Array(n).fill(0), pos = new Array(n).fill(0), flips = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const tr = Math.max(bars[i][1] - bars[i][2], Math.abs(bars[i][1] - c[i - 1]), Math.abs(bars[i][2] - c[i - 1]));
    const nl = key * tr, ps = stop[i - 1];
    if (c[i] > ps && c[i - 1] > ps) stop[i] = Math.max(ps, c[i] - nl);
    else if (c[i] < ps && c[i - 1] < ps) stop[i] = Math.min(ps, c[i] + nl);
    else if (c[i] > ps) stop[i] = c[i] - nl;
    else stop[i] = c[i] + nl;
    if (c[i - 1] < ps && c[i] > ps) pos[i] = 1;
    else if (c[i - 1] > ps && c[i] < ps) pos[i] = -1;
    else pos[i] = pos[i - 1];
    flips[i] = pos[i] !== 0 && pos[i] !== pos[i - 1] ? pos[i] : 0;
  }
  return flips;
}

// Heavy 買(+1)／賣(−1)：同掃描器 signal_mtf.hv_flags 一樣（窗口 100+1 棒，要 >101 棒同有成交量）
function hvFlags(bars, n = 100) {
  const N = bars.length, delta = new Array(N), sp = new Array(N + 1).fill(0), fl = new Array(N).fill(0);
  for (let i = 0; i < N; i++) {
    const [, h, l, c, v = 0] = bars[i], rng = h - l;
    const vb = rng > 0 ? (v * (c - l)) / rng : v * 0.5, vs = rng > 0 ? (v * (h - c)) / rng : v * 0.5;
    delta[i] = vb - vs; sp[i + 1] = sp[i] + delta[i];
  }
  for (let j = n + 1; j < N; j++) {
    let mn = Infinity, mx = -Infinity;
    for (let k = Math.max(0, j - n); k <= j; k++) { if (sp[k] < mn) mn = sp[k]; if (sp[k] > mx) mx = sp[k]; }
    if (delta[j] > 0 && sp[j] <= mn) fl[j] = 1;
    else if (delta[j] < 0 && sp[j] >= mx) fl[j] = -1;
  }
  return fl;
}

export function chartSeries(bars, n) {
  const close = bars.map((b) => b[3]), out = { bars: bars.slice(-n).map((b) => b.slice(0, 4).map(rp)) };
  if (bars.length > 101 && bars.every((b) => b.length > 4 && b[4] > 0)) out.hvf = hvFlags(bars).slice(-n);
  const fl = utFlips(bars);
  if (fl) out.utf = fl.slice(-n);
  out.emas = {};
  [10, 20, 50, 89, 250].forEach((p) => { if (close.length >= p) out.emas[String(p)] = emaSeries(close, p).slice(-n).map(rp); });
  return out;
}
