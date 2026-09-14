# Deploy runbook — Railway + Cloudflare DNS

Production: **https://the.qairuhub.com** — one Node/Hono service plus Postgres on
Railway, with DNS for `qairuhub.com` on Cloudflare.

## 1. Railway project

```bash
railway login
railway init                      # create/select the theqairubook project
railway add --database postgres   # Postgres; DATABASE_URL is injected automatically
railway volume add -m /data       # uploads survive redeploys
```

## 2. Service variables

Set with `railway variables --set KEY=VALUE` or in the dashboard.

| Variable | Value |
|---|---|
| `SESSION_SECRET` | long random string (`openssl rand -hex 32`). **Required** — the app refuses to boot on Railway without it |
| `ALLOWED_EMAIL_DOMAINS` | `qairu.edu.kz` |
| `UPLOAD_DIR` | `/data/uploads` |
| `PUBLIC_URL` | `https://the.qairuhub.com` — used in invite links |
| `REDIRECT_TO_PUBLIC_URL` | `1` once the custom domain works — 301s the `*.up.railway.app` domain to it |
| `TURNSTILE_SITE_KEY` | Cloudflare Turnstile site key (public) |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile secret key. The anti-bot widget turns on only when both keys are set |
| `APP_TIMEZONE` | optional, default `Asia/Almaty` |
| `MEDIA_MAX_IMAGE_MB`, `MEDIA_MAX_PDF_MB`, `MEDIA_USER_QUOTA_MB`, `MEDIA_DAILY_UPLOADS`, `MEDIA_GLOBAL_CAP_MB` | optional upload limits (defaults 5 / 10 / 50 / 20 / 3000) |

`PORT`, `DATABASE_URL`, `RAILWAY_PUBLIC_DOMAIN` come from Railway.

| `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL_API_TOKEN` | Cloudflare Email Service (or `RESEND_API_KEY`). Turns on email codes for activation and password reset |
| `EMAIL_FROM` | e.g. `theqairubook <no-reply@qairuhub.com>` (a domain enabled for Email Sending) |

### Turnstile

1. Cloudflare dashboard → **Turnstile** → *Add widget*, hostname `the.qairuhub.com`, mode *Managed*.
2. Copy the **site key** and **secret key** into the two variables above (the secret only ever lives in Railway).

### Email verification (strongly recommended)

Without it, anyone who knows a classmate's `first.last@qairu.edu.kz` address could
activate that account first. With it, activation requires a code from that inbox.

1. Cloudflare dashboard → **Email Service → Email Sending**: make sure `qairuhub.com` is enabled for sending.
2. **Manage account → Account API tokens → Create token** with the *Email Sending: Send* permission for this account.
3. In Railway set `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_EMAIL_API_TOKEN` and `EMAIL_FROM=theqairubook <no-reply@qairuhub.com>`.
4. `/admin` → *Configuration* shows "Email verification: ON".

Until then, impersonation reports are handled in `/admin/students`: **Reset & lock** the
account, then send the real student a personal **activation link**.

## 3. Schema

Nothing to run. Every boot applies `src/db/migrate.ts` (idempotent `IF NOT EXISTS`
DDL + default boards). It never drops data.

Never run `db:seed` against production — it creates demo accounts with a public password.

## 4. Student list & launch bootstrap

Registration is limited to students on the official list. The list is **personal
data and is never committed** (`private/` is gitignored). Two ways to load it:

- **Launch bootstrap (first deploy of a clean platform).** Put
  `private/launch.json` in a deploy-only copy of the repo and deploy that copy:

  ```bash
  rm -rf /tmp/qb-deploy && mkdir -p /tmp/qb-deploy
  git archive HEAD | tar -x -C /tmp/qb-deploy
  mkdir -p /tmp/qb-deploy/private && cp launch.json /tmp/qb-deploy/private/
  railway up /tmp/qb-deploy --detach
  ```

  `launch.json`:

  ```json
  {
    "launchId": "2026-09-the-qairuhub",
    "archiveExisting": true,
    "students": [{ "email": "first.last@qairu.edu.kz", "name": "First Last", "nativeName": "Имя Фамилия" }],
    "admins": ["admin.email@qairu.edu.kz"],
    "displayNames": { "admin.email@qairu.edu.kz": "Preferred Name" },
    "announcement": { "authorEmail": "admin.email@qairu.edu.kz", "board": "general" }
  }
  ```

  On boot `src/db/launch.ts` moves any existing tables into an
  `archive_<launchId>` schema (nothing is deleted), recreates empty tables,
  creates a pre-created (not yet activated) account for every student, sets
  admins, posts the pinned launch announcement and records
  `app_meta.launch:<launchId>` so it never runs twice. Logs contain counts only.

- **Later additions.** Admins use **/admin/import** (paste CSV `email,name,nativeName`
  or JSON). Activated accounts are never modified.

## 5. Deploy

```bash
railway up --detach           # regular deploys, straight from the repo
railway deployment list       # watch status
railway logs --deployment     # boot logs
```

Smoke test: `/healthz` → `ok`; `/` shows "N of M students have joined";
open `/register` in a private window and try a non-listed email (must be refused).

## 6. Custom domain (the.qairuhub.com)

```bash
railway domain the.qairuhub.com --port 8080
```

Railway prints two records; add both in Cloudflare DNS for `qairuhub.com`:

| Type | Name | Value | Proxy |
|---|---|---|---|
| CNAME | `the` | `<id>.up.railway.app` | DNS only |
| TXT | `_railway-verify.the` | `railway-verify=…` | DNS only |

Keep the CNAME **DNS only** (grey cloud): Railway issues the TLS certificate
itself and nothing else in the zone changes. `railway domain status <id>` shows
verification/certificate progress. Once `https://the.qairuhub.com` serves the
app, set `PUBLIC_URL` and `REDIRECT_TO_PUBLIC_URL=1`.

(Proxying through Cloudflare later is possible, but requires SSL/TLS mode
*Full* for that hostname — use a Configuration Rule rather than changing the
whole zone.)

## Rollback

```bash
railway down    # remove the latest deployment
```

App rollbacks don't touch Postgres. A launch bootstrap can be undone by hand:
the pre-launch tables are intact in the `archive_<launchId>` schema.
