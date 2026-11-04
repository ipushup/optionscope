// generated from scanner/watchlist_parents.txt: ETF -> parent stock
export const PARENTS = {"NVDY": "NVDA", "NVDL": "NVDA", "ARMG": "ARM", "SMCX": "SMCI", "SMCY": "SMCI", "INTW": "INTC", "CBRG": "CBRS", "SNXX": "SNDK", "WDCX": "WDC", "MUU": "MU", "MULL": "MU", "AAOX": "AAOI", "AAOG": "AAOI", "AXTX": "AXTI", "ORCU": "ORCL", "NBIL": "NBIS", "CRWG": "CRWV", "IRE": "IREN", "APLX": "APLD", "VRTL": "VRT", "IONX": "IONQ", "RGTX": "RGTI", "QBTX": "QBTS", "RKLX": "RKLB", "ASTX": "ASTS", "PTIR": "PLTR", "PLTW": "PLTR", "PLTY": "PLTR", "TSLY": "TSLA", "CONY": "COIN", "AMDY": "AMD", "AMDW": "AMD", "TTDU": "TTD", "CRCG": "CRCL", "HOOG": "HOOD", "HOOY": "HOOD", "HOOW": "HOOD", "VSTL": "VST", "CEGX": "CEG", "OKLL": "OKLO", "BEX": "BE", "BEZ": "BE", "DLLL": "DELL", "METW": "META", "METU": "META", "METQ": "META", "MSTX": "MSTR", "MSTZ": "MSTR", "MSTY": "MSTR", "AMAU": "AMAT", "UGL": "GLD", "AGQ": "SLV", "UVIX": "VIX", "SKHX": "SKHY", "7709": "000660", "SPCH": "SPCX", "SSPC": "SPCX"};

// Keep a parent stock and its ETFs together: groups ordered by first appearance, parent first, then its ETFs.
export function groupRows(rows, key = (r) => r.symbol) {
  if (!rows) return rows;
  const groups = new Map();
  for (const r of rows) {
    const s = key(r), g = PARENTS[s] || s;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const out = [];
  for (const [g, list] of groups) {
    out.push(...list.filter((r) => key(r) === g), ...list.filter((r) => key(r) !== g));
  }
  return out;
}
