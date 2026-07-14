// ─── IST TIME HELPERS ─────────────────────────────────────────────────────────
// All market logic runs on IST (UTC+5:30) regardless of the machine's zone.

export const IST_SHIFT_MS = 330 * 60000;

export function nowIST() {
  const n = new Date();
  return new Date(n.getTime() + (n.getTimezoneOffset() + 330) * 60000);
}

export function istDayKey(ts) {
  const n = new Date(ts);
  return new Date(n.getTime() + (n.getTimezoneOffset() + 330) * 60000).toDateString();
}

// Indian cash market hours: Mon–Fri 09:15–15:30 IST.
export function isIndianMarketOpen() {
  const now = new Date();
  // Convert to IST (UTC+5:30) regardless of the machine's local zone.
  const ist = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000);
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;       // Sun/Sat
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= (9 * 60 + 15) && mins <= (15 * 60 + 30);  // 555..930
}
