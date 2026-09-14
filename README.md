# [ theqairubook ]

A student homage to **2004 thefacebook.com**, rebuilt for **Qazaq AI Research University (QAIRU)** in Astana.

Not affiliated with Meta / Facebook. A local-first college directory: profiles, friends, poke, private messages, wall posts, search, course match, and **The Board** — plus real invite links so you can actually get your friends onto it.

<p align="center">
  <img src="docs/screenshots/03-board.png" width="700" alt="The Board — activity feed">
</p>

## Features

- **Welcome / register / login** — QAIRU email only for open registration
- **Invite links** — generate a personal `theqairubook.app/join/<token>` link; anyone who opens it can register directly, no `@qairu.edu.kz` email required, and they're auto-friended with you the moment they join
- **Profiles** — picture, account/basic/contact info, courses, interests, music, books
- **Friends** — request, confirm, ignore, friends-of-friends
- **Poke** + poke inbox
- **Private messages** — inbox, sent, compose, reply, unread badges
- **The Wall** on every profile
- **The Board** — home feed of joins, friendships, pokes, wall posts
- **Search** by name / class year / residence / course / status
- **Course match** roster pages
- **Social net** — your connections + random QAIRU people to discover
- **Privacy** — network / friends-of-friends / friends-only visibility

## Screenshots

| Welcome | Register |
|---|---|
| ![Welcome](docs/screenshots/01-welcome.png) | ![Register](docs/screenshots/02-register.png) |

| Profile | Invite a friend |
|---|---|
| ![Profile](docs/screenshots/04-profile.png) | ![Invite](docs/screenshots/08-invite.png) |

| Join via invite link | Messages |
|---|---|
| ![Join](docs/screenshots/09-join.png) | ![Messages](docs/screenshots/07-messages.png) |

| Friends | Search |
|---|---|
| ![Friends](docs/screenshots/05-friends.png) | ![Search](docs/screenshots/06-search.png) |

## Stack

- [Hono](https://hono.dev) + JSX (server-rendered HTML, no client JS framework)
- Postgres + [Drizzle ORM](https://orm.drizzle.team)
- scrypt password hashes + signed session cookie (no auth-as-a-service)
- Vintage table layout, `#3B5998` chrome — pixel-accurate to the 2004 original

## Quick start

```bash
git clone https://github.com/tairqaldy/theqairubook.git
cd theqairubook
npm install
npm run db:up          # starts Postgres in Docker on localhost:5433
npm run db:push        # create tables
npm run db:seed        # 8 fake QAIRU people
npm run dev            # http://localhost:8787
```

### Seed logins

All seed accounts use password `qairu123`.

| Email | Name |
|---|---|
| `aigerim.nurlanova@qairu.edu.kz` | Aigerim Nurlanova |
| `dias.bekmuratov@qairu.edu.kz` | Dias Bekmuratov |
| `madina.satpayeva@qairu.edu.kz` | Madina Satpayeva |
| … | (see [`src/db/seed.ts`](src/db/seed.ts)) |

Register your own account with any `*@qairu.edu.kz` address (enforced in code), or ask an existing member for an **invite link** from the `invite` tab — that bypasses the email restriction entirely.

## Config

Copy `.env.example` → `.env` for local dev:

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://qairu:qairu@localhost:5433/theqairubook` | Points at Railway Postgres in production |
| `SESSION_SECRET` | — | **Must** be a long random string in production |
| `ALLOWED_EMAIL_DOMAINS` | `qairu.edu.kz` | Comma-separated; only applies to open `/register`, not invite links |
| `PORT` | `8787` | Railway overrides this automatically |
| `UPLOAD_DIR` | `./uploads` | Profile photo storage |

## Deployment

The app is a single Node/Hono server + Postgres — it deploys as-is to **Railway** (app + database in one project). See [DEPLOY.md](DEPLOY.md) for the full runbook, including attaching Cloudflare in front of the Railway domain for DNS/CDN/SSL once you point a custom domain at it.

```bash
railway login
railway init
railway up
```

## Design notes

- Fixed **700px** centered table layout
- Header / borders `#3B5998`, box titles `#6D84B4` / `#D8DFEA`
- Wordmark `[ theqairubook ]`
- Footer: `a QAIRU student production`
