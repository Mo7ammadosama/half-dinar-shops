/**
 * Human-friendly relative time for order timestamps. A shopkeeper cares far more
 * about "8 min ago" than an absolute clock time when triaging a queue of orders.
 * Falls back to a full local date/time for anything older than a day.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleString();
}

/** Whole minutes elapsed since `iso` — used to flag orders left waiting too long. */
export function minutesSince(iso: string, now: number = Date.now()): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((now - then) / 60000));
}
