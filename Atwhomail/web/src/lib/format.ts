/** 顯示用格式化（Yahoo Mail 風格的時間呈現：今天只顯示時刻、昨天、月日…） */

export function relativeTime(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  if (Number.isNaN(d.getTime())) return "";
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(n) - startOfDay(d)) / 86_400_000);
  if (dayDiff <= 0) {
    return d.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  if (dayDiff === 1) return "昨天";
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function formatFullDate(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-TW", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "王小明 <a@b.com>" → { name, address }；純地址亦可 */
export function parseAddress(raw: string): { name: string; address: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(raw ?? "");
  if (m) {
    return { name: (m[1] ?? "").replace(/^"(.*)"$/, "$1"), address: (m[2] ?? "").trim() };
  }
  return { name: "", address: (raw ?? "").trim() };
}

export function displaySender(from: string): string {
  const p = parseAddress(from);
  return p.name || p.address || "(未知寄件者)";
}

/** 頭像文字（Yahoo 風格圓形頭像） */
export function avatarText(from: string): string {
  const s = displaySender(from).trim();
  return s.charAt(0).toUpperCase() || "?";
}

/** 由字串產生穩定色相（頭像底色） */
export function avatarHue(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) % 360;
  return h;
}
