import { useEffect, useRef, useState } from "react";

/**
 * AppHeader.jsx — xMarket 統一頂欄（Home / Signal Board / Triple Band / Watchlist / Radar … 全部共用）
 *
 *   第一行：☰ 選單 · xMarket · 深淺色 · Log out
 *   第二行：主要分頁（橫掃，active 底線）
 * ☰ 展開全部頁面（包括未開放／暫停嘅）。
 */
const F = "'Inter',-apple-system,BlinkMacSystemFont,system-ui,sans-serif";   // 頂欄自己載字體，唔靠頁面（Home 冇載 Syne，其他頁有 → 之前 xMarket 字體唔同）
const M = "-apple-system,BlinkMacSystemFont,'SF Pro Display','Inter','Roboto','Segoe UI',system-ui,sans-serif";   // 數字/標籤字體：iOS 系統字 (SF Pro)，同 Longbridge app 一致；配 tabular-nums

const TH = {
  dark: { bg: "#0f1112", line: "#26292c", soft: "#1d1f21", card: "#151718", txt: "#e3e4e5", sub: "#b9babd", mute: "#75777a", acc: "#3b9eff" },
  light: { bg: "#ffffff", line: "#d9dde2", soft: "#e8ebef", card: "#ffffff", txt: "#1b1f24", sub: "#3c444d", mute: "#6b7580", acc: "#0b6bcb" },
};

// tab = 顯示喺第二行；其餘只喺 ☰ 選單
export const PAGES = [
  { id: "home", label: "Home", tab: true },
  { id: "signals", label: "Signal Board", tab: true },
  { id: "daily", label: "Daily Table", tab: true },
  { id: "band", label: "Triple Band", tab: true },
  { id: "watchlist", label: "Watchlist", tab: true },
  { id: "radar", label: "Radar", tab: true },
  { id: "brief", label: "Daily brief", note: "soon", off: true },
  { id: "premium", label: "Premium", note: "paused" },
  { id: "compass", label: "Compass", note: "paused", off: true },
];

async function logout() {
  try { await fetch("/api/logout", { method: "POST" }); } catch { /* 離線都照 reload */ }
  window.location.reload();
}

export default function AppHeader({ view, onNavigate, light, onToggleLight }) {
  const T = light ? TH.light : TH.dark;
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const go = (id) => { setOpen(false); if (id !== view) onNavigate(id); };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc); document.addEventListener("touchstart", onDoc); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("touchstart", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const iconBtn = { width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, border: "none", background: "transparent", color: T.txt, cursor: "pointer", flexShrink: 0, padding: 0 };

  return (
    <header ref={box} style={{ position: "sticky", top: 0, zIndex: 50, background: T.bg, borderBottom: `1px solid ${T.line}`, paddingTop: "env(safe-area-inset-top, 0px)", fontFamily: F, width: "100%", boxSizing: "border-box" }}>
      <style>{"@import url('https://fonts.googleapis.com/css2?family=Inter:wght@500;600;700;800&display=swap'); body{font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}"}</style>
      <div style={{ display: "flex", alignItems: "center", gap: 6, height: 56, padding: "0 12px" }}>
        <button type="button" onClick={() => setOpen(v => !v)} aria-label="選單" aria-expanded={open} style={iconBtn}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>
        <div style={{ fontWeight: 800, fontSize: 22, letterSpacing: "-0.5px", color: T.txt, flex: 1, minWidth: 0, marginLeft: 6 }}>xMarket</div>
        <button type="button" onClick={() => window.location.reload()} aria-label="重新整理頁面" title="Refresh" style={{ ...iconBtn, color: T.sub }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.6-5.9" /><path d="M20 4v4.5h-4.5" /></svg>
        </button>
        <button type="button" onClick={onToggleLight} aria-label="切換深／淺色" style={{ ...iconBtn, color: T.sub }}>
          {light
            ? <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
            : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" /></svg>}
        </button>
        <button type="button" onClick={logout} style={{ height: 40, padding: "0 6px", border: "none", background: "transparent", color: T.txt, fontFamily: F, fontSize: 14, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>Log out</button>
      </div>

      <nav aria-label="Primary" style={{ display: "flex", gap: 2, overflowX: "auto", padding: "0 12px", scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}>
        {PAGES.filter(p => p.tab).map(p => {
          const on = p.id === view;
          return (
            <button key={p.id} type="button" onClick={() => go(p.id)} aria-current={on ? "page" : undefined}
              style={{ flex: "0 0 auto", whiteSpace: "nowrap", padding: "10px 10px 11px", border: "none", background: "transparent", cursor: "pointer",
                fontFamily: F, fontSize: 14, fontWeight: on ? 700 : 500, color: on ? T.txt : T.mute,
                borderBottom: `2px solid ${on ? T.txt : "transparent"}`, marginBottom: -1 }}>{p.label}</button>
          );
        })}
      </nav>

      {open && (
        <div role="menu" style={{ position: "absolute", left: 8, top: "calc(env(safe-area-inset-top, 0px) + 52px)", width: 232, background: T.card, border: `1px solid ${T.line}`, borderRadius: 12, padding: 6, boxShadow: "0 12px 32px rgba(0,0,0,.35)" }}>
          {PAGES.map(p => (
            <button key={p.id} role="menuitem" type="button" disabled={!!p.off} onClick={() => go(p.id)}
              style={{ display: "flex", alignItems: "center", width: "100%", minHeight: 42, padding: "0 12px", border: "none", borderRadius: 8, textAlign: "left",
                background: p.id === view ? T.soft : "transparent", color: p.off ? T.mute : T.txt, fontFamily: F, fontSize: 14, fontWeight: 600,
                cursor: p.off ? "not-allowed" : "pointer" }}>
              <span style={{ flex: 1 }}>{p.label}</span>
              {p.note && <span style={{ fontFamily: M, fontSize: 10, color: T.mute }}>{p.note}</span>}
            </button>
          ))}
        </div>
      )}
    </header>
  );
}
