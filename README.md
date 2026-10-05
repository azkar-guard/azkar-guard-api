# Azkar Guard: push reminders API

Phase 3 of Azkar Guard. A Cloudflare Worker that sends the [web app](https://github.com/azkar-guard/azkar-guard-website)'s reminders as web push notifications: when the morning or evening window opens, then every 30 minutes until the app reports the session done.

Browsers can't schedule a notification on their own, so a server has to send them. This one is deliberately small and knows as little as possible.

## How it works

1. **The app computes the windows.** It works out the next week of morning and evening windows on the device, from prayer times.
2. **The app registers.** With the user's permission, it subscribes to push and sends this API the subscription, the interface language and those windows. That is only start and end times: no location, no account.
3. **A cron sends the reminders.** Every minute, it sends each due reminder: at the start of a window, then every 30 minutes, until the window ends or the app reports it done. A reminder still undelivered when the next one is sent is replaced (`Topic` header), so a phone that was offline gets one, not a pile.
4. **The app keeps it current.** It re-sends the windows whenever it opens, so they move with the calendar and with location changes.

Web push is implemented with WebCrypto only (`src/webpush.ts`):
- payload encryption: RFC 8291 + RFC 8188 `aes128gcm`, tested byte for byte against the RFC 8291 example;
- sender identity: VAPID (RFC 8292), an ES256 JWT.

## API

All bodies are JSON. Allowed browser origins are set in `ALLOWED_ORIGINS` (`wrangler.toml`).

| Method and path | Body | Result |
|---|---|---|
| `GET /v1/vapid-public-key` | | `{ key }`, the `applicationServerKey` for `pushManager.subscribe` |
| `POST /v1/subscriptions` | `{ subscription, lang, windows }` | `201 { id }`. Re-registering the same endpoint returns the same id. |
| `PUT /v1/subscriptions/:id` | `{ lang, windows }` | `204`, replaces the windows |
| `POST /v1/subscriptions/:id/done` | `{ key }` | `204`, stops reminders for that window |
| `DELETE /v1/subscriptions/:id` | | `204`, reminders off |

- `subscription` is `PushSubscription.toJSON()`. Endpoints must belong to a known push service (Google, Mozilla, Apple, Microsoft), so the Worker can't be used to send requests elsewhere.
- `windows` is `[{ key: "2026-10-05:morning", session, start, end }]`, epoch ms, at most 64, from a day ago to 15 days ahead.
- The `id` is a random UUID. Knowing it is what authorizes changes, so the app keeps it private.

The push payload is `{ session, key, lang }`. The app's service worker turns it into the notification text.

## Limits (Workers Free plan)

| Limit | Free plan | What it means here |
|---|---|---|
| CPU time | 10 ms per invocation | The cron sends at most 20 reminders per minute (`BATCH` in `src/index.ts`). |
| Subrequests | 50 per invocation | 20 pushes per run stays well under it. |
| Requests | 100,000 per day | Plenty for app traffic. |

Twenty reminders a minute is 600 per 30-minute cycle, so roughly 600 people inside the same window. Past that, reminders arrive late rather than being lost. The next step up is the Workers Paid plan (higher CPU limit, Queues).

## Local setup

Requirements: Node 22.12+ (`.nvmrc` pins 24 LTS).

```bash
npm install
npm test                       # crypto (RFC 8291 vector, VAPID) and schedule logic
npx wrangler d1 migrations apply azkar-guard --local
npm run dev                    # http://localhost:8787
```

`npm run dev` needs a VAPID key in `.dev.vars` (gitignored):

```bash
node -e 'const {generateKeyPairSync}=require("crypto");const k=generateKeyPairSync("ec",{namedCurve:"P-256"}).privateKey.export({type:"pkcs8",format:"pem"});require("fs").writeFileSync(".dev.vars","VAPID_PRIVATE_KEY=\""+k.replace(/\n/g,"\\n")+"\"\n")'
```

Run `npm run dev -- --test-scheduled`, then open `http://localhost:8787/__scheduled?cron=*+*+*+*+*` to trigger the cron once.

## Deploy

GitHub Actions (`.github/workflows/deploy.yml`) tests every PR. On `main` it applies D1 migrations, deploys the Worker and sets the VAPID secret.

[azkar-guard-infra](https://github.com/azkar-guard/azkar-guard-infra) manages:
- the D1 database (its id goes in `wrangler.toml`);
- the VAPID key;
- this repo's `CLOUDFLARE_ACCOUNT_ID` variable and its `CLOUDFLARE_API_TOKEN` and `VAPID_PRIVATE_KEY` secrets.

## License and privacy

- **Code:** MIT, see [LICENSE](LICENSE).
- **Privacy:** see [PRIVACY.md](PRIVACY.md).
