# Deploy runbook — Railway (+ optional Cloudflare in front)

theqairubook is a plain Node/Hono server + Postgres. It deploys to Railway
as-is — no code split, no edge runtime rewrite. Cloudflare sits in front of
the Railway domain purely for DNS/CDN/SSL once you point a real domain at it;
it is not required to go live.

## 1. Railway project

```bash
railway login
railway init                 # create/select the theqairubook project
railway add --database postgres   # provisions a Postgres plugin
```

Railway injects `DATABASE_URL` for the Postgres plugin automatically into
every service in the project — the app just needs to read it.

## 2. App service env vars

Set these on the app service (`railway variables --set KEY=VALUE`, or in the
dashboard):

| Variable | Value |
|---|---|
| `SESSION_SECRET` | a long random string (`openssl rand -hex 32`) — **never** reuse the local dev default |
| `ALLOWED_EMAIL_DOMAINS` | `qairu.edu.kz` |
| `UPLOAD_DIR` | `/data/uploads` (see volume below) |
| `PUBLIC_URL` | optional — e.g. `https://theqairubook.kz` once you add a custom domain. Without it, invite links use the `X-Forwarded-Host`/`X-Forwarded-Proto` Railway sends (always `https://…`) |
| `APP_TIMEZONE` | optional — defaults to `Asia/Almaty` (Astana time) |

`PORT`, `DATABASE_URL` and `RAILWAY_PUBLIC_DOMAIN` are provided by Railway automatically.

## 3. Persistent volume for profile photos

Uploaded photos are written to local disk, which is wiped on every redeploy
without a volume:

```bash
railway volume add -m /data
```

Mount it at `/data` and keep `UPLOAD_DIR=/data/uploads` so photos survive
deploys. (Swap this for Cloudflare R2 or Railway's own object storage later
if photo volume grows — not needed to launch.)

## 4. Schema

Nothing to run. On every boot the server applies `src/db/migrate.ts`, which
creates missing tables/columns/indexes with `IF NOT EXISTS`, backfills invite
codes for existing users and creates the default discussion boards. It is
safe to run repeatedly and never drops data.

Don't run `db:seed` against production: it creates demo accounts whose
password (`qairu123`) is public in this repo.

## 5. Deploy

```bash
railway up
```

Railway builds with Nixpacks (detects Node from `package.json`, runs
`npm install` then `npm run start`) and gives you a `*.up.railway.app`
domain immediately. Point a health check at `/healthz` if you want one.

Smoke test after a deploy: open `/invite`, copy your link, open it in a
private window — you should see "<you> invited you" and be able to register
with any email.

## 6. Custom domain + Cloudflare (optional)

1. `railway domain` → add your custom domain to the Railway service.
2. In Cloudflare DNS, add a `CNAME` for that hostname pointing at the
   Railway-provided target, proxied (orange cloud) for CDN/SSL/DDoS
   protection.
3. Cloudflare handles TLS termination and caching at the edge; Railway keeps
   serving the app and Postgres behind it. No Workers, Hyperdrive, or R2
   needed for this path.

## Rollback

```bash
railway down          # remove the most recent deployment
```

Postgres data is untouched by app rollbacks — only the app service redeploys.
