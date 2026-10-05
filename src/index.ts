import { activeWindow, nextDue, topicFor, type ReminderWindow } from "./schedule";
import { BadRequest, parseKey, parseLang, parseTarget, parseWindows } from "./validate";
import { loadVapid, send, vapidToken, type Vapid } from "./webpush";

export interface Env {
  DB: D1Database;
  /** PKCS#8 PEM of the VAPID P-256 key (secret). */
  VAPID_PRIVATE_KEY: string;
  /** VAPID contact, a mailto: or https: URL. */
  VAPID_SUBJECT: string;
  /** Comma-separated origins allowed to call the API (the web app). */
  ALLOWED_ORIGINS: string;
}

/**
 * Reminders sent per cron run. The Free plan allows 10 ms of CPU and 50 subrequests per
 * invocation; each push costs one subrequest and some crypto, so stay well under both.
 */
const BATCH = 20;
/** Push services drop a reminder that couldn't be delivered within this many seconds. */
const TTL_SECONDS = 30 * 60;
/** Retry delay after a push service asked us to slow down or failed. */
const RETRY_MS = 5 * 60_000;

interface Row {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  lang: "en" | "ar";
  windows: string;
  done: string;
  last_sent: number | null;
}

let vapidCache: Promise<Vapid> | undefined;
const getVapid = (env: Env) => (vapidCache ??= loadVapid(env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT));

// ---------------------------------------------------------------- HTTP API

function cors(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const json = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...headers, ...(body === null ? {} : { "Content-Type": "application/json" }) },
  });

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => undefined);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequest("body must be a JSON object");
  return body as Record<string, unknown>;
}

const parseList = (text: string): string[] => JSON.parse(text) as string[];

async function handle(request: Request, env: Env): Promise<Response> {
  const headers = cors(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  const url = new URL(request.url);
  const now = Date.now();
  const parts = url.pathname.split("/").filter(Boolean); // ["v1", "subscriptions", id?, "done"?]
  if (parts[0] !== "v1") return json({ error: "not found" }, 404, headers);

  // GET /v1/vapid-public-key: the app's applicationServerKey.
  if (parts[1] === "vapid-public-key" && parts.length === 2 && request.method === "GET") {
    return json({ key: (await getVapid(env)).publicKey }, 200, headers);
  }
  if (parts[1] !== "subscriptions") return json({ error: "not found" }, 404, headers);

  // POST /v1/subscriptions: register (or re-register) a browser, with its upcoming windows.
  if (parts.length === 2 && request.method === "POST") {
    const body = await readJson(request);
    const target = parseTarget(body.subscription);
    const lang = parseLang(body.lang);
    const windows = parseWindows(body.windows, now);
    const due = nextDue(windows, new Set(), null, now);
    // Re-registering the same endpoint keeps its id, so the app can recover a lost id.
    const row = await env.DB.prepare(
      `INSERT INTO subscriptions (id, endpoint, p256dh, auth, lang, windows, done, last_sent, next_due, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[]', NULL, ?7, ?8, ?8)
       ON CONFLICT (endpoint) DO UPDATE SET
         p256dh = excluded.p256dh, auth = excluded.auth, lang = excluded.lang, windows = excluded.windows,
         done = '[]', last_sent = NULL, next_due = excluded.next_due, updated_at = excluded.updated_at
       RETURNING id`,
    )
      .bind(crypto.randomUUID(), target.endpoint, target.p256dh, target.auth, lang, JSON.stringify(windows), due, now)
      .first<{ id: string }>();
    return json({ id: row!.id }, 201, headers);
  }

  const id = parts[2];
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return json({ error: "not found" }, 404, headers);
  const existing = await env.DB.prepare("SELECT done, last_sent FROM subscriptions WHERE id = ?1")
    .bind(id)
    .first<Pick<Row, "done" | "last_sent">>();
  if (!existing) return json({ error: "not found" }, 404, headers);

  // PUT /v1/subscriptions/:id: refresh the upcoming windows (the app does this when opened).
  if (parts.length === 3 && request.method === "PUT") {
    const body = await readJson(request);
    const lang = parseLang(body.lang);
    const windows = parseWindows(body.windows, now);
    const keys = new Set(windows.map((w) => w.key));
    const done = parseList(existing.done).filter((k) => keys.has(k));
    const due = nextDue(windows, new Set(done), existing.last_sent, now);
    await env.DB.prepare("UPDATE subscriptions SET lang = ?2, windows = ?3, done = ?4, next_due = ?5, updated_at = ?6 WHERE id = ?1")
      .bind(id, lang, JSON.stringify(windows), JSON.stringify(done), due, now)
      .run();
    return json(null, 204, headers);
  }

  // POST /v1/subscriptions/:id/done: the session was completed, stop reminding about it.
  if (parts.length === 4 && parts[3] === "done" && request.method === "POST") {
    const key = parseKey((await readJson(request)).key);
    const row = await env.DB.prepare("SELECT windows FROM subscriptions WHERE id = ?1").bind(id).first<Pick<Row, "windows">>();
    const windows = JSON.parse(row!.windows) as ReminderWindow[];
    const done = [...new Set([...parseList(existing.done), key])];
    const due = nextDue(windows, new Set(done), existing.last_sent, now);
    await env.DB.prepare("UPDATE subscriptions SET done = ?2, next_due = ?3, updated_at = ?4 WHERE id = ?1")
      .bind(id, JSON.stringify(done), due, now)
      .run();
    return json(null, 204, headers);
  }

  // DELETE /v1/subscriptions/:id: reminders turned off in the app.
  if (parts.length === 3 && request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM subscriptions WHERE id = ?1").bind(id).run();
    return json(null, 204, headers);
  }

  return json({ error: "not found" }, 404, headers);
}

// ---------------------------------------------------------------- Cron

/** Send the reminders that are due. Runs every minute. */
async function sendDue(env: Env, now: number): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id, endpoint, p256dh, auth, lang, windows, done, last_sent FROM subscriptions
     WHERE next_due IS NOT NULL AND next_due <= ?1 ORDER BY next_due LIMIT ?2`,
  )
    .bind(now, BATCH)
    .all<Row>();
  if (results.length === 0) return;

  const vapid = await getVapid(env);
  // One VAPID token per push service origin per run.
  const tokens = new Map<string, Promise<string>>();
  const tokenFor = (endpoint: string) => {
    const origin = new URL(endpoint).origin;
    if (!tokens.has(origin)) tokens.set(origin, vapidToken(vapid, origin, now));
    return tokens.get(origin)!;
  };

  const updates: D1PreparedStatement[] = [];
  for (const row of results) {
    const windows = JSON.parse(row.windows) as ReminderWindow[];
    const done = new Set(parseList(row.done));
    const window = activeWindow(windows, now);

    if (!window || done.has(window.key)) {
      // Nothing to send right now (e.g. the window was marked done since): just reschedule.
      updates.push(env.DB.prepare("UPDATE subscriptions SET next_due = ?2 WHERE id = ?1").bind(row.id, nextDue(windows, done, row.last_sent, now)));
      continue;
    }

    let status: number;
    try {
      status = await send(row, { session: window.session, key: window.key, lang: row.lang }, vapid, await tokenFor(row.endpoint), {
        ttl: TTL_SECONDS,
        topic: topicFor(window),
      });
    } catch (err) {
      console.error("push failed", row.id, err);
      status = 503;
    }

    if (status === 404 || status === 410) {
      // The browser unsubscribed or the subscription expired.
      updates.push(env.DB.prepare("DELETE FROM subscriptions WHERE id = ?1").bind(row.id));
    } else if (status === 429 || status >= 500) {
      updates.push(env.DB.prepare("UPDATE subscriptions SET next_due = ?2 WHERE id = ?1").bind(row.id, now + RETRY_MS));
    } else {
      // Sent, or rejected for a reason a retry won't fix: either way, move on to the next slot.
      if (status >= 300) console.warn("push rejected", row.id, status);
      updates.push(
        env.DB.prepare("UPDATE subscriptions SET last_sent = ?2, next_due = ?3 WHERE id = ?1").bind(row.id, now, nextDue(windows, done, now, now)),
      );
    }
  }
  await env.DB.batch(updates);
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (err) {
      if (err instanceof BadRequest) return json({ error: err.message }, 400, cors(request, env));
      console.error(err);
      return json({ error: "internal error" }, 500, cors(request, env));
    }
  },

  async scheduled(controller, env): Promise<void> {
    await sendDue(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
