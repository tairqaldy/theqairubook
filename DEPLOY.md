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

`PORT` and `DATABASE_URL` are provided by Railway automatically.

## 3. Persistent volume for profile photos

Uploaded photos are written to local disk, which is wiped on every redeploy
without a volume:

```bash
railway volume add -m /data
```

Mount it at `/data` and keep `UPLOAD_DIR=/data/uploads` so photos survive
deploys. (Swap this for Cloudflare R2 or Railway's own object storage later
if photo volume grows — not needed to launch.)

## 4. Push schema + seed

Once the Postgres plugin exists, run the same scripts against it from your
machine using Railway's env:

```bash
railway run npm run db:push
railway run npm run db:seed   # optional — creates the 8 demo QAIRU accounts
```

## 5. Deploy

```bash
railway up
```

Railway builds with Nixpacks (detects Node from `package.json`, runs
`npm install` then `npm run start`) and gives you a `*.up.railway.app`
domain immediately.

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
