/**
 * Receipts print wall-clock time at the store with no zone. FoodFlow wants an
 * instant, so the store's IANA zone is applied here rather than whatever zone
 * the machine running the import happens to be in.
 */

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second?: number;
}

function offsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Wall-clock time in `timeZone` to an ISO instant ("…Z"). */
export function wallTimeToIso(t: WallTime, timeZone: string): string {
  const naive = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second ?? 0);
  // Two passes: the offset at the naive guess can differ from the offset at
  // the real instant when the guess lands across a DST change.
  let instant = naive - offsetMs(naive, timeZone);
  instant = naive - offsetMs(instant, timeZone);
  return new Date(instant).toISOString();
}

/** "2026-06-12T16:38:00" (no zone) to wall time. Null when it doesn't parse. */
export function parseLocalIso(value: unknown): WallTime | null {
  const m = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4] ?? 0),
    minute: Number(m[5] ?? 0),
    second: Number(m[6] ?? 0),
  };
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
