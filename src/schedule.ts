/**
 * When to send reminders. The app computes its prayer-time windows on the device and
 * uploads only their start and end times, so the server never knows the user's location.
 */

export type Session = "morning" | "evening";

/** One Azkar window, keyed like the app's progress ("2026-10-05:morning"). */
export interface ReminderWindow {
  key: string;
  session: Session;
  start: number;
  end: number;
}

/** Minutes between reminders while a session is incomplete, as in the browser extension. */
export const NAG_INTERVAL_MS = 30 * 60_000;

/** The window containing `now`, if any. */
export function activeWindow(windows: ReminderWindow[], now: number): ReminderWindow | undefined {
  return windows.find((w) => w.start <= now && now < w.end);
}

/**
 * Epoch ms of the next reminder, or null when there is nothing left to remind about.
 * A window's first reminder is at its start, then every NAG_INTERVAL_MS until it ends,
 * unless it is marked done. A due time at or before `now` means "send now".
 */
export function nextDue(windows: ReminderWindow[], done: ReadonlySet<string>, lastSent: number | null, now: number): number | null {
  const ordered = [...windows].sort((a, b) => a.start - b.start);
  for (const w of ordered) {
    if (done.has(w.key) || w.end <= now) continue;
    if (w.start > now) return w.start;
    const sentInWindow = lastSent !== null && lastSent >= w.start;
    const due = sentInWindow ? lastSent + NAG_INTERVAL_MS : w.start;
    if (due < w.end) return due;
  }
  return null;
}

/** Push "Topic" header for a window: replaces an older undelivered reminder for the same window. */
export function topicFor(window: ReminderWindow): string {
  return window.key.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 32);
}
