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

export function chartSeries(bars, n) {
  const close = bars.map((b) => b[3]), out = { bars: bars.slice(-n).map((b) => b.map(rp)) };
  const fl = utFlips(bars);
  if (fl) out.utf = fl.slice(-n);
  out.emas = {};
  [10, 20, 50, 89, 250].forEach((p) => { if (close.length >= p) out.emas[String(p)] = emaSeries(close, p).slice(-n).map(rp); });
  return out;
}
