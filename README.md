# [ theqairubook ]

**A calm, 2004-thefacebook-style student network for Qazaq AI Research University (QAIRU).**
Discussions, study materials, homework help, profiles, friends and private chat. No feed, no algorithm, no ads.

**Live:** https://the.qairuhub.com · a [QairuHub](https://qairuhub.com) passion project by **Tair Kaldybayev**

<p align="center">
  <img src="docs/screenshots/03-discussions.png" width="720" alt="Discussions — boards, flairs, pinned announcement, solved questions">
</p>

> Not affiliated with Meta/Facebook, and not an official QAIRU service. Screenshots use fake demo data.

## Why

Student group chats are loud and forgetful. theqairubook is the opposite: one quiet, internal place where QAIRU students can ask for help, share what they know, and find each other. Everything stays saved and searchable, and nothing is built to keep you scrolling.

## What's inside

- **Closed network.** Only students on the official QAIRU list can join. Every student's account is **pre-created** ("not joined yet"). You activate yours by registering with your `@qairu.edu.kz` email and a password.
- **Friends before they join.** Send friend requests to classmates who haven't joined yet, and copy a **personal invite link** for them (it pre-fills their email). You get +25 rep when they activate.
- **Discussions.** Boards for Homework Help, Coding & Dev, Study Materials, Courses, Projects & Hackathons, Internships & Career, Events, Ask Anything, Housing, Marketplace and Memes. Posts get a flair: **Question** (the author marks the accepted answer), **Material** or **Discussion**. There are also Reddit-style votes, threaded comments, **saved posts**, search, and pinned admin announcements. Anyone with 50 rep can start a new board.
- **Attachments.** Images (JPG/PNG/GIF/WEBP) and PDFs on posts and comments, with strict per-person limits.
- **Profiles you can decorate.** Photo, headline, "looking for" (study partners, hackathon team…), clubs & projects, Telegram/GitHub/Instagram/LinkedIn, courses, interests, plus a threaded wall.
- **Private chat** with live updates, **pokes**, **friends-of-friends**, course rosters, people search (Latin or Cyrillic names).
- **Rep:** a quiet signal of who helps others (table below), with a leaderboard and history.
- **Onboarding.** A landing page, a full [How it works](https://the.qairuhub.com/guide) guide, FAQ, and a getting-started checklist for new members.
- **Admin tools:** activation stats, student list import, reset an activation (impersonation reports), manage admins, recent content.

## Screenshots

| Landing | Join through an invite |
|---|---|
| ![Landing](docs/screenshots/01-landing.png) | ![Join](docs/screenshots/02-join.png) |

| Question with accepted answer | Study material with a PDF |
|---|---|
| ![Question](docs/screenshots/04-question.png) | ![Material](docs/screenshots/05-material.png) |

| Home & getting started | Profile |
|---|---|
| ![Home](docs/screenshots/06-home.png) | ![Profile](docs/screenshots/07-profile.png) |

| Classmate who hasn't joined yet | Invite classmates |
|---|---|
| ![Not joined yet](docs/screenshots/08-not-joined.png) | ![Invite](docs/screenshots/09-invite.png) |

| Chat | How it works |
|---|---|
| ![Chat](docs/screenshots/10-chat.png) | ![Guide](docs/screenshots/11-guide.png) |

| Edit profile | Admin |
|---|---|
| ![Edit profile](docs/screenshots/13-edit-profile.png) | ![Admin](docs/screenshots/12-admin.png) |

## Rep

| Rep | When |
|---|---|
| **+25** | A classmate activates their account through your invite link (max 10 per 24h) |
| **+1 / −1** | Someone upvotes / downvotes your wall post, reply, discussion post or comment |
| **+1** | Someone new replies to your post or comment (once per person) |
| **+5** | Your comment is marked as the answer to a question |
| **50** | Rep needed to start your own board |

You can't vote on your own content. Every change is written to a `rep_events` ledger, so a user's rep always equals the sum of their history.

## Limits & safety

| | |
|---|---|
| Images | up to 5 MB each |
| PDFs | up to 10 MB each |
| Files per post / comment | 4 / 2 |
| Storage per person | 50 MB |
| Uploads per person | 20 per 24 hours |
| Total upload storage | 3 GB cap |

- **Mailbox proof:** when email is configured, activating an account (and resetting a password) needs a 6-digit code sent to the student's `@qairu.edu.kz` inbox. Codes are single-use, expire in 15 minutes and allow 5 tries.
- **Impersonation reports:** an admin can reset & lock an account and send the real student a one-time personal activation link. Admins can also suspend accounts and remove posts, comments and wall posts.
- Cloudflare **Turnstile** plus a honeypot and a signed timing check on register and login.
- Rate limits on login, registration, posting, commenting, messaging, friend requests and uploads.
- scrypt password hashes. Signed session cookies carry a **session version**, so changing your password or an admin reset logs out every other session.
- Uploads are identified by their **magic bytes** (never by extension), served members-only with `nosniff`, and sandboxed.
- Profile photos and attachments are visible only to logged-in members. Security headers (`X-Frame-Options`, `Referrer-Policy`, HSTS…) are on everywhere.
- The student list is personal data. It is **never committed**: it's loaded through a private launch file or the admin import page.

## Stack

- [Hono](https://hono.dev) + JSX: server-rendered HTML with one small progressive-enhancement script. Every form works without JS.
- Postgres + [Drizzle ORM](https://orm.drizzle.team); schema migrates itself on boot (`src/db/migrate.ts`)
- Deployed on [Railway](https://railway.com); DNS on Cloudflare
- Vintage 700px table layout, `#3B5998` chrome

## Run it locally

```bash
git clone https://github.com/tairqaldy/theqairubook.git
cd theqairubook
npm install
npm run db:up      # Postgres in Docker on localhost:5433
npm run db:seed    # fake students, discussions, votes, attachments, chats
npm run dev        # http://localhost:8787
```

Demo login (fake data only): `aigerim.nurlanova@qairu.edu.kz` / `qairu123` (admin). The seed also creates classmates who haven't joined yet, so you can try activating one at `/register`.

## Config

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://qairu:qairu@localhost:5433/theqairubook` | |
| `SESSION_SECRET` | dev default | **required** in production |
| `ALLOWED_EMAIL_DOMAINS` | `qairu.edu.kz` | |
| `PUBLIC_URL` | auto | origin for invite links, e.g. `https://the.qairuhub.com` |
| `REDIRECT_TO_PUBLIC_URL` | off | `1` = 301 other hostnames to `PUBLIC_URL` |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | unset | anti-bot widget is enabled when both are set |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_EMAIL_API_TOKEN` | unset | Cloudflare Email Service; turns on email codes for activation & password reset |
| `RESEND_API_KEY` | unset | alternative email provider |
| `EMAIL_FROM` | `theqairubook <no-reply@qairuhub.com>` | sender address |
| `EMAIL_DEV_LOG` | off | `1` prints emails to the server log (local dev only) |
| `TRUST_CF_CONNECTING_IP` | off | `1` only if the hostname is proxied through Cloudflare |
| `APP_TIMEZONE` | `Asia/Almaty` | displayed times |
| `UPLOAD_DIR` | `./uploads` | photos + attachments (`/data/uploads` on Railway) |
| `MEDIA_MAX_IMAGE_MB` / `MEDIA_MAX_PDF_MB` / `MEDIA_USER_QUOTA_MB` / `MEDIA_DAILY_UPLOADS` / `MEDIA_GLOBAL_CAP_MB` | 5 / 10 / 50 / 20 / 3000 | upload limits |
| `LAUNCH_FILE` | `./private/launch.json` | one-time launch bootstrap (see [DEPLOY.md](DEPLOY.md)) |

## Deploy

See [DEPLOY.md](DEPLOY.md) for the Railway service, the custom domain on Cloudflare, Turnstile, and loading the student list.

## Credits

Made by **Tair Kaldybayev** as a [QairuHub](https://qairuhub.com) passion project, for the students of QAIRU. Inspired by the 2004 original.
