import { decode } from "./base64url";
import type { ReminderWindow } from "./schedule";
import type { PushTarget } from "./webpush";

export type Lang = "en" | "ar";

const DAY = 24 * 3_600_000;
const MAX_WINDOWS = 64;

/**
 * Push services we deliver to. The Worker POSTs to the subscription endpoint, so an open
 * endpoint would let anyone use it to send requests to arbitrary hosts.
 */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, // Chrome, Edge, Samsung Internet, other Chromium browsers
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^web\.push\.apple\.com$/, // Safari (macOS, iOS)
  /\.notify\.windows\.com$/, // Edge on Windows (legacy WNS endpoints)
];

export class BadRequest extends Error {}

function fail(message: string): never {
  throw new BadRequest(message);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseTarget(value: unknown): PushTarget {
  if (!isObject(value) || !isObject(value.keys)) fail("subscription must be a PushSubscription JSON object");
  const { endpoint } = value;
  const { p256dh, auth } = value.keys;
  if (typeof endpoint !== "string" || endpoint.length > 2048) fail("subscription.endpoint is invalid");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    fail("subscription.endpoint is not a URL");
  }
  if (url.protocol !== "https:" || !PUSH_HOSTS.some((host) => host.test(url.hostname))) {
    fail("subscription.endpoint is not a supported push service");
  }
  if (typeof p256dh !== "string" || decodedLength(p256dh) !== 65) fail("subscription.keys.p256dh is invalid");
  if (typeof auth !== "string" || decodedLength(auth) !== 16) fail("subscription.keys.auth is invalid");
  return { endpoint, p256dh, auth };
}

function decodedLength(text: string): number {
  try {
    return decode(text).length;
  } catch {
    return -1;
  }
}

export function parseLang(value: unknown): Lang {
  if (value !== "en" && value !== "ar") fail('lang must be "en" or "ar"');
  return value;
}

/** Windows must be well-formed and roughly current: from a day ago to two weeks ahead. */
export function parseWindows(value: unknown, now: number): ReminderWindow[] {
  if (!Array.isArray(value) || value.length > MAX_WINDOWS) fail(`windows must be an array of at most ${MAX_WINDOWS}`);
  return value.map((w, i) => {
    if (!isObject(w)) fail(`windows[${i}] must be an object`);
    const { key, session, start, end } = w;
    if (typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}:(morning|evening)$/.test(key)) fail(`windows[${i}].key is invalid`);
    if (session !== "morning" && session !== "evening") fail(`windows[${i}].session is invalid`);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) >= (end as number)) {
      fail(`windows[${i}] needs integer start < end`);
    }
    if ((end as number) < now - DAY || (start as number) > now + 15 * DAY) fail(`windows[${i}] is out of range`);
    return { key, session, start: start as number, end: end as number };
  });
}

export function parseKey(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}:(morning|evening)$/.test(value)) fail("key is invalid");
  return value;
}
