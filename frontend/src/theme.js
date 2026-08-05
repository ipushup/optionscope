/**
 * theme.js — OptionScope 深／淺色主題
 *
 * 全部頁面嘅顏色都經 c() 查表。深色 = 原本嘅值（identity），
 * 淺色 = 逐個對應嘅淺底版本。
 *
 * LIGHT 係 module-level flag，由 App.jsx 喺 render 之前 setLight()，
 * 所以下面所有子組件同步跟住轉，唔使逐層傳 prop。
 */
const MAP = {
  "#00b894": "#00795c",
  "#00d4aa": "#00875a",
  "#030910": "#e0ecf9",
  "#040b14": "#f4f7fb",
  "#050c18": "#ffffff",
  "#060e1a": "#f0f4f9",
  "#071510": "#f0fdf4",
  "#080f1c": "#eef3f9",
  "#08141e": "#d9e8f5",
  "#0a1520": "#f7f9fc",
  "#0a1826": "#d5e0ec",
  "#0a1828": "#ffffff",
  "#0a1f3d": "#c4d9f5",
  "#0a2e20": "#cef4e6",
  "#0a3d2e": "#c4f5e7",
  "#0c1e34": "#cbddf3",
  "#0d1f35": "#cbdcf2",
  "#0d3060": "#dbeafe",
  "#0d4080": "#0652b2",
  "#0e1c28": "#dbe4ee",
  "#0e2e1e": "#dcfce7",
  "#14222e": "#d2dfeb",
  "#162030": "#e2e9f1",
  "#1a0a0a": "#fef2f2",
  "#1a2a3a": "#cbd9e8",
  "#1a2e40": "#d5e0ec",
  "#1a3020": "#d2e6d7",
  "#1a3555": "#cfe3fa",
  "#2a1a06": "#f8e6cf",
  "#2e0e0e": "#fee2e2",
  "#2e1a0a": "#f4dfce",
  "#2e2a0a": "#f4f0ce",
  "#2e4055": "#3c597b",
  "#334455": "#415c76",
  "#3a5060": "#7b93aa",
  "#3b9eff": "#0b6bcb",
  "#3d0a0a": "#f5c4c4",
  "#445566": "#5b7186",
  "#4a6070": "#465f71",
  "#556677": "#4a5c6d",
  "#5a7a90": "#4a6480",
  "#667788": "#5b7186",
  "#6a8898": "#4a6480",
  "#7a9ab8": "#33506e",
  "#88bbee": "#0b2e50",
  "#8aaabb": "#4a6480",
  "#a8bece": "#21303b",
  "#aaccee": "#23364a",
  "#cc77ff": "#39005c",
  "#ccddee": "#1e2b3a",
  "#cdd7e3": "#212d3b",
  "#ddeeff": "#0e1c2c",
  "#f5a623": "#a55a00",
  "#ff5c5c": "#c81e3f",
  "#ff8c42": "#b8460f"
};

export const THEME_KEY = "osTheme";

export function initLight() {
  try { return localStorage.getItem(THEME_KEY) === "light"; } catch { return false; }
}

let LIGHT = initLight();

export function setLight(v) {
  LIGHT = v;
  try { localStorage.setItem(THEME_KEY, v ? "light" : "dark"); } catch { /* 私隱模式 */ }
}

export function isLight() { return LIGHT; }

/** 查表。搵唔到就原色照出 —— 唔會因為漏咗一個色而爆。 */
export function c(hex) {
  return LIGHT ? (MAP[String(hex).toLowerCase()] || hex) : hex;
}
