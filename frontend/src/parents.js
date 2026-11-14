import { useEffect, useState } from "react";

// ETF -> parent stock。呢度係後備（build 時嘅 scanner/watchlist_parents.txt）；
// 頁面載入後會經 /api/gh-file?name=parents 讀最新版，覆蓋喺同一個物件度（Data 頁 Edit 改完即刻生效）。
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

// ── 動態同步 ──
const subs = new Set();
export function parseParents(text) {   // "CRWG CRWV  # 註解" → {CRWG: "CRWV"}
  const m = {};
  for (const raw of String(text || "").split("\n")) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const [c, p] = line.split(/[\s,]+/).filter(Boolean);
    if (c && p) m[c.toUpperCase()] = p.toUpperCase();
  }
  return m;
}
export function setParents(map) {      // 原地替換 PARENTS 內容，再通知所有用緊嘅畫面 re-render
  const same = JSON.stringify(Object.entries(map).sort()) === JSON.stringify(Object.entries(PARENTS).sort());
  if (same) return;
  for (const k of Object.keys(PARENTS)) delete PARENTS[k];
  Object.assign(PARENTS, map);
  subs.forEach((f) => f());
}
export const etfsOf = (parent) => Object.keys(PARENTS).filter((e) => PARENTS[e] === parent);
let lastSync = 0;
export async function syncParents(force) {
  if (!force && Date.now() - lastSync < 60000) return;
  lastSync = Date.now();
  try {
    const r = await fetch(`/api/gh-file?name=parents&t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return;
    const j = await r.json();
    const m = parseParents(j.content);
    if (Object.keys(m).length) setParents(m);
  } catch { /* 後備用 build 時嘅對照表 */ }
}
export function useParents() {         // 畫面用：載入時同步一次，之後從屬關係有變就 re-render
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set((v) => v + 1);
    subs.add(f); syncParents();
    return () => { subs.delete(f); };
  }, []);
}
