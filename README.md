# [ theqairubook ]

A student homage to **2004 thefacebook.com**, rebuilt for **Qazaq AI Research University (QAIRU)** in Astana — with a little bit of Reddit mixed in.

Not affiliated with Meta / Facebook. A college directory with profiles, friends, pokes, walls, private chat, **Reddit-style discussion boards**, and **rep** you earn from upvotes, replies and bringing classmates in with your personal invite link.

**Live:** https://theqairubook-app-production.up.railway.app

<p align="center">
  <img src="docs/screenshots/04-discussions.png" width="720" alt="Discussions — Reddit-style boards with votes">
</p>

## Features

- **Invite links that actually work** — every member gets one permanent link (`/r/aigerim-3f9a1`). It never expires, works for any number of people, lets invited friends register with any email, auto-friends you both, and pays **+25 rep** per join
- **Rep** — Reddit-style karma: upvotes/downvotes on your wall posts, wall replies, discussion posts and comments move your rep; getting replies earns rep too. Leaderboard + a full "how you earned it" history
- **Discussions** — boards like `q/general`, `q/courses`, `q/housing`, `q/events`, `q/memes`; posts with optional links, **hot / new / top** sorting, threaded comments with **best / new** sorting, OP tags, soft delete. 50 rep unlocks starting your own board
- **The Wall, threaded** — reply to any wall post (nested), vote on posts and replies, wall owner can delete
- **Messages as chat** — conversation list with unread badges, chat bubbles, live updates without reloading, Enter to send
- **Friends** — find people by name or email and add them in one click, confirm/ignore requests, cancel sent requests, unfriend, "people you may know"; add-friend buttons on search, social net and profiles
- **Profiles** — picture, account/basic/contact info, courses, interests, rep, discussion stats
- **Poke**, **The Board** activity feed (joins, referrals, friendships, wall posts, new discussions), **Search**, **Course match**, **Social net**, **Privacy** (network / friends-of-friends / friends)

## Screenshots

| Discussions thread | Profile with threaded wall |
|---|---|
| ![Thread](docs/screenshots/05-thread.png) | ![Profile](docs/screenshots/06-profile.png) |

| Invite & earn rep | Join through an invite link |
|---|---|
| ![Invite](docs/screenshots/09-invite.png) | ![Join](docs/screenshots/02-join.png) |

| Chat | Conversations |
|---|---|
| ![Chat](docs/screenshots/08-chat.png) | ![Inbox](docs/screenshots/07-inbox.png) |

| Rep & leaderboard | The Board |
|---|---|
| ![Rep](docs/screenshots/10-rep.png) | ![Board](docs/screenshots/03-board.png) |

| Add friends | Search |
|---|---|
| ![Friends](docs/screenshots/11-friends.png) | ![Search](docs/screenshots/12-search.png) |

| Welcome |
|---|
| ![Welcome](docs/screenshots/01-welcome.png) |

## How rep works

| Rep | When |
|---|---|
| **+25** | Someone joins through your invite link (max 10 payouts per 24h) |
| **+1 / −1** | Someone upvotes / downvotes your wall post, wall reply, discussion post or comment |
| **+1** | Someone replies to your post or comment (once per person per post) |
| **50** | Rep needed to start your own discussion board |

You can't vote on your own content. Every change is recorded in a `rep_events` ledger, so each user's rep always equals the sum of their history.

## Stack

- [Hono](https://hono.dev) + JSX — server-rendered HTML, one tiny progressive-enhancement script (`src/static/app.js`); every form still works with JS off
- Postgres + [Drizzle ORM](https://orm.drizzle.team)
- scrypt password hashes + signed session cookie (no auth-as-a-service)
- Vintage table layout, `#3B5998` chrome

## Quick start

```bash
git clone https://github.com/tairqaldy/theqairubook.git
cd theqairubook
npm install
npm run db:up          # starts Postgres in Docker on localhost:5433
npm run db:seed        # creates tables + 8 fake QAIRU people, discussions, votes, chats
npm run dev            # http://localhost:8787
```

The server creates/updates its own tables on startup (`src/db/migrate.ts`), so `npm run db:push` is optional.

### Seed logins

All seed accounts use password `qairu123`.

| Email | Name |
|---|---|
| `aigerim.nurlanova@qairu.edu.kz` | Aigerim Nurlanova |
| `dias.bekmuratov@qairu.edu.kz` | Dias Bekmuratov |
| `madina.satpayeva@qairu.edu.kz` | Madina Satpayeva |
| … | (see [`src/db/seed.ts`](src/db/seed.ts)) |

Register your own account with any `*@qairu.edu.kz` address, or open a member's **invite link** from their `invite` tab — that works with any email.

## Config

Copy `.env.example` → `.env` for local dev:

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://qairu:qairu@localhost:5433/theqairubook` | Railway injects this in production |
| `SESSION_SECRET` | — | **Must** be a long random string in production |
| `ALLOWED_EMAIL_DOMAINS` | `qairu.edu.kz` | Comma-separated; only applies to open `/register`, not invite links |
| `PUBLIC_URL` | auto | Origin used in invite links. Auto-detected from `X-Forwarded-*` headers / `RAILWAY_PUBLIC_DOMAIN`; set it when you add a custom domain |
| `APP_TIMEZONE` | `Asia/Almaty` | Timezone for displayed dates and chat times (Astana, UTC+5) |
| `PORT` | `8787` | Railway overrides this automatically |
| `UPLOAD_DIR` | `./uploads` | Profile photo storage (`/data/uploads` on Railway) |

## Main routes

| Route | What |
|---|---|
| `/r/:code` | Join via someone's permanent invite link (legacy `/join/:token` links still work) |
| `/d`, `/d/:board`, `/d/:board/:postId` | Discussions front page, board, post + comments |
| `/messages`, `/messages/with/:userId` | Conversations, chat thread |
| `/friends?find=` | Friends, requests, find & add |
| `/rep` | Your rep, rules, leaderboard, history |
| `/invite` | Your invite link and referrals |
| `/healthz` | Health check |

## Deployment

Single Node/Hono server + Postgres on **Railway**. Push to `main` / `railway up`; the schema migrates itself on boot. See [DEPLOY.md](DEPLOY.md).

## Design notes

- Fixed **700px** centered table layout
- Header / borders `#3B5998`, box titles `#6D84B4` / `#D8DFEA`
- Wordmark `[ theqairubook ]`, boards are `q/something`
- Footer: `a QAIRU student production`
