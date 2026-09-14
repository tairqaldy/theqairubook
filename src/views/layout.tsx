import type { FC, Child } from "hono/jsx";
import type { User } from "../db/schema.js";
import { navCounts, type FriendStatus } from "../lib/social.js";
import type { VoteTarget } from "../lib/rep.js";

// One count query per request, shared by the top menu and the left nav.
const countsCache = new WeakMap<User, ReturnType<typeof navCounts>>();
function countsFor(user: User) {
  let p = countsCache.get(user);
  if (!p) {
    p = navCounts(user.id);
    countsCache.set(user, p);
  }
  return p;
}

const Badge: FC<{ n: number }> = ({ n }) =>
  n > 0 ? <span class="badge">{n}</span> : null;

async function TopMenu({ user }: { user: User }) {
  const counts = await countsFor(user);
  return (
    <>
      <a href="/home">home</a>
      <a href="/search">search</a>
      <a href="/d">discuss</a>
      <a href="/messages">
        messages
        <Badge n={counts.unread} />
      </a>
      <a href="/friends">
        friends
        <Badge n={counts.requests} />
      </a>
      <a href="/invite">invite</a>
      <a href="/rep">rep</a>
      <a href="/logout">logout</a>
    </>
  );
}

export function Layout(props: {
  title: string;
  user: User | null;
  banner?: string;
  children: Child;
}) {
  const { title, user, banner, children } = props;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title} | theqairubook</title>
        <link rel="stylesheet" href="/static/style.css" />
        <script src="/static/app.js" defer></script>
      </head>
      <body>
        <div class="page-wrap">
          <div class="topbar">
            <div class="logo-row">
              <div class="logo">
                <a href={user ? "/home" : "/"}>[ theqairubook ]</a>
              </div>
            </div>
            <div class="menu-row">
              {user ? (
                <TopMenu user={user} />
              ) : (
                <>
                  <a href="/login">login</a>
                  <a href="/register">register</a>
                  <a href="/about">about</a>
                  <a href="/faq">faq</a>
                </>
              )}
            </div>
          </div>
          {banner ? <div class="welcome-banner">{banner}</div> : null}
          <div class="content">{children}</div>
          <div class="footer">
            a QAIRU student production ·{" "}
            <a href="/about">about</a> · <a href="/faq">faq</a> ·{" "}
            <a href="/terms">terms</a>
            <br />
            Qazaq AI Research University · пр. Мәңгілік Ел 55/1, Astana
          </div>
        </div>
      </body>
    </html>
  );
}

export async function LeftNav({ user }: { user: User }) {
  const counts = await countsFor(user);
  return (
    <div class="left-nav">
      <div class="box" style="margin-bottom:10px">
        <div class="box-title-alt">[ {user.name.split(" ")[0]} ]</div>
        <div class="box-body">
          <div class="rep-line">
            <a href="/rep">
              <b>{user.rep}</b> rep
            </a>
          </div>
          <a href={`/profile/${user.id}`}>My Profile</a>
          <a href="/edit-profile">Edit My Profile</a>
          <a href="/friends">
            My Friends
            <Badge n={counts.requests} />
          </a>
          <a href="/messages">
            My Messages
            <Badge n={counts.unread} />
          </a>
          <a href="/pokes">
            Pokes
            <Badge n={counts.pokes} />
          </a>
          <a href="/d">Discussions</a>
          <a href="/invite">Invite &amp; Earn Rep</a>
          <a href="/account">My Account</a>
          <a href="/privacy">Privacy</a>
        </div>
      </div>
    </div>
  );
}

export const Box: FC<{ title: string; alt?: boolean; children: Child }> = ({
  title,
  alt,
  children,
}) => (
  <div class="box">
    <div class={alt ? "box-title-alt" : "box-title"}>{title}</div>
    <div class="box-body">{children}</div>
  </div>
);

/** Reddit-style ▲ score ▼. Works as a plain form; app.js upgrades it to fetch. */
export const VoteBox: FC<{
  type: VoteTarget;
  id: number;
  score: number;
  myVote?: number;
  own?: boolean;
  inline?: boolean;
}> = ({ type, id, score, myVote = 0, own, inline }) => (
  <form
    method="post"
    action="/vote"
    class={`vote${inline ? " vote-inline" : ""}`}
    data-vote={myVote}
  >
    <input type="hidden" name="type" value={type} />
    <input type="hidden" name="id" value={String(id)} />
    <button
      type="submit"
      name="dir"
      value="up"
      class={`vote-up${myVote === 1 ? " on" : ""}`}
      title={own ? "You can't vote on your own post" : "Upvote"}
      disabled={own}
    >
      ▲
    </button>
    <span class="vote-score">{score}</span>
    <button
      type="submit"
      name="dir"
      value="down"
      class={`vote-down${myVote === -1 ? " on" : ""}`}
      title={own ? "You can't vote on your own post" : "Downvote"}
      disabled={own}
    >
      ▼
    </button>
  </form>
);

/** Plain text with http(s) URLs turned into links. Everything else is escaped. */
export const Linkified: FC<{ text: string }> = ({ text }) => {
  const parts = text.split(/(https?:\/\/[^\s<>"]+)/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <a href={part} target="_blank" rel="nofollow noopener">
            {part}
          </a>
        ) : (
          part
        )
      )}
    </>
  );
};

export const UserLink: FC<{ user: Pick<User, "id" | "name" | "rep"> }> = ({
  user,
}) => (
  <>
    <a href={`/profile/${user.id}`}>
      <b>{user.name}</b>
    </a>
    <span class="rep-chip" title="rep">
      {user.rep}
    </span>
  </>
);

export const FriendButton: FC<{ userId: number; status: FriendStatus }> = ({
  userId,
  status,
}) => {
  if (status === "friends") return <span class="meta">✓ friends</span>;
  if (status === "pending_out")
    return (
      <form method="post" action={`/friends/remove/${userId}`} class="inline-form">
        <span class="meta">request sent</span>{" "}
        <button class="btn-link" type="submit">
          cancel
        </button>
      </form>
    );
  if (status === "pending_in")
    return (
      <form method="post" action={`/friends/accept/${userId}`} class="inline-form">
        <button class="btn btn-small" type="submit">
          Confirm Friend
        </button>
      </form>
    );
  return (
    <form method="post" action={`/friends/request/${userId}`} class="inline-form">
      <button class="btn btn-small" type="submit">
        + Add Friend
      </button>
    </form>
  );
};

// Timestamps are stored in UTC; show them in campus time.
export const DISPLAY_TZ = process.env.APP_TIMEZONE || "Asia/Almaty";

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: DISPLAY_TZ,
  });
}

/** Calendar-day key in campus time, for grouping. */
export function dayKey(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: DISPLAY_TZ });
}

export function timeAgo(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  const s = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (s < 60) return "just now";
  const units: [number, string][] = [
    [60 * 60 * 24 * 365, "year"],
    [60 * 60 * 24 * 30, "month"],
    [60 * 60 * 24, "day"],
    [60 * 60, "hour"],
    [60, "minute"],
  ];
  for (const [secs, name] of units) {
    if (s >= secs) {
      const n = Math.floor(s / secs);
      return `${n} ${name}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function defaultPhoto(user: User): string {
  return user.photoPath ? `/uploads/${user.photoPath}` : "";
}
