import type { FC, Child } from "hono/jsx";
import type { Media, User } from "../db/schema.js";
import { navCounts, type FriendStatus } from "../lib/social.js";
import type { VoteTarget } from "../lib/rep.js";
import {
  FORM_TS_FIELD,
  HONEYPOT_FIELD,
  issueFormTimestamp,
  turnstileEnabled,
  turnstileSiteKey,
} from "../lib/security.js";
import { MEDIA_ACCEPT, MEDIA_LIMITS, formatBytes, mediaUrl } from "../lib/media.js";

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
      {user.role === "admin" ? <a href="/admin">admin</a> : null}
      <a href="/logout">logout</a>
    </>
  );
}

// Feature stylesheets, one per area so they can evolve independently.
const STYLESHEETS = [
  "/static/style.css",
  "/static/css/auth.css",
  "/static/css/discuss.css",
  "/static/css/people.css",
  "/static/css/directory.css",
  "/static/css/public.css",
  "/static/css/admin.css",
];

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
        <meta
          name="description"
          content="theqairubook — the calm, 2004-style student network for QAIRU: discussions, study materials, profiles and chat."
        />
        {STYLESHEETS.map((href) => (
          <link rel="stylesheet" href={href} />
        ))}
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
                  <a href="/guide">how it works</a>
                  <a href="/about">about</a>
                  <a href="/faq">faq</a>
                </>
              )}
            </div>
          </div>
          {banner ? <div class="welcome-banner">{banner}</div> : null}
          <div class="content">{children}</div>
          <div class="footer">
            a <a href="https://qairuhub.com">QairuHub</a> passion project by
            Tair Kaldybayev · <a href="/guide">how it works</a> ·{" "}
            <a href="/about">about</a> · <a href="/faq">faq</a> ·{" "}
            <a href="/terms">terms</a>
            <br />
            for students of Qazaq AI Research University · Astana · not an
            official university service
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
          <a href="/d/saved">Saved Posts</a>
          <a href="/invite">Invite &amp; Earn Rep</a>
          <a href="/account">My Account</a>
          <a href="/privacy">Privacy</a>
          <a href="/guide">How It Works</a>
          {user.role === "admin" ? <a href="/admin">Admin</a> : null}
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

export const UserLink: FC<{
  user: Pick<User, "id" | "name" | "rep"> & { claimedAt?: Date | null };
}> = ({ user }) => (
  <>
    <a href={`/profile/${user.id}`}>
      <b>{user.name}</b>
    </a>
    {user.claimedAt === null ? (
      <NotJoined />
    ) : (
      <span class="rep-chip" title="rep">
        {user.rep}
      </span>
    )}
  </>
);

/** Marks a pre-created account from the student list that hasn't signed up. */
export const NotJoined: FC = () => (
  <span class="not-joined" title="On the QAIRU student list, hasn't joined theqairubook yet">
    not joined yet
  </span>
);

/** Honeypot + signed render time. Put inside every public form (register, login, join). */
export const FormGuard: FC = () => (
  <>
    <input type="hidden" name={FORM_TS_FIELD} value={issueFormTimestamp()} />
    <div class="hp-field" aria-hidden="true">
      <label>
        Leave this empty
        <input type="text" name={HONEYPOT_FIELD} tabindex={-1} autocomplete="off" value="" />
      </label>
    </div>
  </>
);

/** Cloudflare Turnstile challenge; renders nothing when keys aren't configured. */
export const TurnstileWidget: FC = () => {
  const siteKey = turnstileSiteKey();
  if (!siteKey || !turnstileEnabled()) return null;
  return (
    <>
      <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
      <div class="cf-turnstile" data-sitekey={siteKey} data-theme="light" data-size="flexible"></div>
    </>
  );
};

export const FLAIRS = {
  discussion: "Discussion",
  question: "Question",
  material: "Material",
  announcement: "Announcement",
} as const;
export type Flair = keyof typeof FLAIRS;

export function isFlair(value: unknown): value is Flair {
  return typeof value === "string" && Object.hasOwn(FLAIRS, value);
}

export const FlairTag: FC<{ flair: string; solved?: boolean }> = ({ flair, solved }) => {
  const known: Flair = isFlair(flair) ? flair : "discussion";
  return (
    <>
      <span class={`flair flair-${known}`}>{FLAIRS[known]}</span>
      {solved ? <span class="flair flair-solved">✓ solved</span> : null}
    </>
  );
};

/** Image thumbnails + PDF links for a post or comment. */
export const Attachments: FC<{ items: Media[] | undefined; compact?: boolean }> = ({
  items,
  compact,
}) => {
  if (!items?.length) return null;
  const images = items.filter((m) => m.kind === "image");
  const files = items.filter((m) => m.kind !== "image");
  return (
    <div class={compact ? "attachments compact" : "attachments"}>
      {images.length ? (
        <div class="attach-images">
          {images.map((m) => (
            <a href={mediaUrl(m)} target="_blank" rel="noopener" title={m.originalName}>
              <img src={mediaUrl(m)} alt={m.originalName} loading="lazy" />
            </a>
          ))}
        </div>
      ) : null}
      {files.map((m) => (
        <div class="attach-file">
          <span class="attach-icon">PDF</span>{" "}
          <a href={mediaUrl(m)} target="_blank" rel="noopener">
            {m.originalName}
          </a>{" "}
          <span class="meta">
            {formatBytes(m.sizeBytes)} · <a href={`${mediaUrl(m)}?download=1`}>download</a>
          </span>
        </div>
      ))}
    </div>
  );
};

/** File input with the limits spelled out. Form needs enctype="multipart/form-data". */
export const UploadField: FC<{ max: number; usedBytes?: number }> = ({ max, usedBytes }) => (
  <div class="upload-field">
    <input type="file" name="files" multiple={max > 1} accept={MEDIA_ACCEPT} data-max-files={max} />
    <div class="meta">
      Up to {max} file{max === 1 ? "" : "s"}: images (JPG, PNG, GIF, WEBP) up to{" "}
      {formatBytes(MEDIA_LIMITS.imageBytes)}, PDFs up to {formatBytes(MEDIA_LIMITS.pdfBytes)}.
      {usedBytes !== undefined
        ? ` You've used ${formatBytes(usedBytes)} of ${formatBytes(MEDIA_LIMITS.userQuotaBytes)}.`
        : ""}
    </div>
  </div>
);

/** Copyable invite link + ready-to-send message. */
export const InviteCopy: FC<{ id: string; link: string; message?: string }> = ({
  id,
  link,
  message,
}) => (
  <div class="invite-copy">
    <div class="invite-link-row">
      <input type="text" readonly id={id} class="invite-link" value={link} data-select-on-click />
      <button class="btn" type="button" data-copy={`#${id}`}>
        Copy link
      </button>
    </div>
    {message ? (
      <div class="invite-link-row">
        <textarea readonly id={`${id}-msg`} rows={2} class="invite-msg" data-select-on-click>
          {message}
        </textarea>
        <button class="btn btn-gray" type="button" data-copy={`#${id}-msg`}>
          Copy message
        </button>
      </div>
    ) : null}
  </div>
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
