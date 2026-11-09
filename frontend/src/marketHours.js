// 美股／港股全部休市（紐約時間 週五 20:00 → 週日 20:00）：唔使自動拉報價，狀態燈轉灰
export const marketsClosed = () => {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(x => [x.type, x.value]));
    const h = parseInt(p.hour, 10);
    return p.weekday === "Sat" || (p.weekday === "Sun" && h < 20) || (p.weekday === "Fri" && h >= 20);
  } catch { return false; }
};

// 港股收市（香港時間 週末，或平日 16:10 後／09:30 前）：唔使每 15 秒拉報價
export const hkClosed = () => {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Hong_Kong", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(x => [x.type, x.value]));
    const t = parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10);
    return p.weekday === "Sat" || p.weekday === "Sun" || t < 9 * 60 + 15 || t >= 16 * 60 + 10;
  } catch { return false; }
};
