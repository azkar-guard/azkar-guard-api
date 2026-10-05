import { describe, expect, it } from "vitest";
import { activeWindow, NAG_INTERVAL_MS, nextDue, topicFor, type ReminderWindow } from "./schedule";

const H = 3_600_000;
const morning: ReminderWindow = { key: "2026-10-05:morning", session: "morning", start: 5 * H, end: 18 * H };
const evening: ReminderWindow = { key: "2026-10-05:evening", session: "evening", start: 18 * H, end: 29 * H };
const windows = [evening, morning]; // deliberately unsorted

describe("reminder schedule", () => {
  it("is due at the start of the next window", () => {
    expect(nextDue(windows, new Set(), null, 2 * H)).toBe(morning.start);
  });

  it("is due immediately in an active window that got no reminder yet", () => {
    expect(nextDue(windows, new Set(), null, 9 * H)).toBe(morning.start);
  });

  it("repeats every 30 minutes after the last reminder in the window", () => {
    expect(nextDue(windows, new Set(), 9 * H, 9 * H + 60_000)).toBe(9 * H + NAG_INTERVAL_MS);
  });

  it("ignores a reminder sent in an earlier window", () => {
    expect(nextDue(windows, new Set(), 17 * H, 18 * H + 60_000)).toBe(evening.start);
  });

  it("skips to the next window once the current one is done", () => {
    expect(nextDue(windows, new Set([morning.key]), 9 * H, 10 * H)).toBe(evening.start);
  });

  it("does not schedule a reminder past the end of the window", () => {
    expect(nextDue(windows, new Set(), 17.75 * H, 17.8 * H)).toBe(evening.start);
  });

  it("returns null when every window is over or done", () => {
    expect(nextDue(windows, new Set([evening.key]), null, 20 * H)).toBeNull();
    expect(nextDue(windows, new Set(), null, 30 * H)).toBeNull();
    expect(nextDue([], new Set(), null, 0)).toBeNull();
  });

  it("finds the active window", () => {
    expect(activeWindow(windows, 6 * H)).toBe(morning);
    expect(activeWindow(windows, 18 * H)).toBe(evening);
    expect(activeWindow(windows, 30 * H)).toBeUndefined();
  });

  it("makes a valid push topic from a window key", () => {
    expect(topicFor(morning)).toBe("2026-10-05-morning");
  });
});
