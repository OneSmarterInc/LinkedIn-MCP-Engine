/** Post-date helpers shared by the job readers (Google Jobs, Monster through Apify). */

/** "3 days ago", "Posted today", "2 hours ago", "30+ days ago" -> YYYY-MM-DD; undefined when unreadable. */
export function dateFromRecency(text: string | null | undefined, now = new Date()): string | undefined {
  const t = (text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  const d = new Date(now);
  if (/\b(today|just now|moments? ago|hours? ago|minutes? ago|an hour ago)\b/.test(t)) return iso(d);
  if (/\byesterday\b/.test(t)) { d.setDate(d.getDate() - 1); return iso(d); }
  const m = /(\d+)\+?\s*(day|week|month)s?\s*ago/.exec(t);
  if (m) {
    const n = Number(m[1]) * (m[2] === "week" ? 7 : m[2] === "month" ? 30 : 1);
    d.setDate(d.getDate() - n);
    return iso(d);
  }
  const abs = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  return abs ? abs[0] : undefined;
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** True when the post date is within `hoursOld` of now (a date-only post counts from the start of its day). Unknown dates pass. */
export function withinHours(datePosted: string | undefined, hoursOld: number, now = new Date()): boolean {
  if (!datePosted) return true;
  const t = Date.parse(datePosted.length === 10 ? `${datePosted}T00:00:00` : datePosted);
  if (Number.isNaN(t)) return true;
  return now.getTime() - t <= hoursOld * 3_600_000 + 86_400_000; // a full extra day, since most posts carry a date without a time
}
