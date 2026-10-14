/** Formats seconds as m:ss.mmm or h:mm:ss.mmm. */
export function formatTime(sec: number, decimals = 3): string {
  const scale = 10 ** decimals;
  const total = Math.round(Math.max(0, sec) * scale) / scale;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = (total % 60).toFixed(decimals).padStart(decimals ? decimals + 3 : 2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Parses "90", "1:30", "1:30.25" or "1:02:03.5" into seconds; null if invalid. */
export function parseTime(text: string): number | null {
  const parts = text.trim().split(":");
  if (!text.trim() || parts.length > 3) return null;
  let total = 0;
  for (const [i, raw] of parts.entries()) {
    const part = raw.trim();
    if (!/^\d*\.?\d*$/.test(part) || part === "" || part === ".") return null;
    const v = Number(part);
    if (i > 0 && v >= 60) return null;
    total = total * 60 + v;
  }
  return total;
}
