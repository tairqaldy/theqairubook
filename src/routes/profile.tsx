import { Hono } from "hono";
import type { Child } from "hono/jsx";
import { eq, desc, and, isNull, isNotNull, count } from "drizzle-orm";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppEnv } from "../middleware/auth.js";
import { isAdmin, needLogin } from "../middleware/auth.js";
import {
  Layout,
  LeftNav,
  Box,
  VoteBox,
  UserLink,
  NotJoined,
  FriendButton,
  InviteCopy,
  formatDate,
  timeAgo,
  defaultPhoto,
} from "../views/layout.js";
import { db } from "../db/index.js";
import {
  users,
  wallPosts,
  discussionPosts,
  discussionComments,
  type User,
  type WallPost,
} from "../db/schema.js";
import {
  friendshipStatus,
  friendIds,
  mutualFriends,
  canViewProfile,
  areFriends,
  addBoardEvent,
  parseCourses,
  buildTree,
  type TreeNode,
} from "../lib/social.js";
import { REP, awardReply, myVotes } from "../lib/rep.js";
import { safeHref } from "../lib/url.js";
import { withinLimit } from "../lib/security.js";
import { inviteLink, inviteMessage } from "../lib/invite.js";
import {
  MEDIA_LIMITS,
  formatBytes,
  mediaForUser,
  mediaUrl,
  mediaUsage,
  sniff,
} from "../lib/media.js";
import { ensureReferralCode } from "../lib/social.js";

export const profileRoutes = new Hono<AppEnv>();

export const LOOKING_FOR = [
  "Study partners",
  "Hackathon team",
  "Project collaborators",
  "Friends",
  "Mentorship",
  "Internship tips",
] as const;

const STATUSES = ["Student", "Faculty", "Staff", "Alumnus/Alumna"];
const PHOTO_ACCEPT = "image/jpeg,image/png,image/gif,image/webp";

// Server-side caps for every editable text field.
const MAX = {
  name: 60,
  headline: 120,
  clubs: 500,
  handle: 40,
  linkedin: 300,
  classYear: 20,
  residence: 100,
  birthday: 60,
  hometown: 100,
  highSchool: 100,
  screenname: 60,
  mobile: 40,
  website: 300,
  courses: 1000,
  interests: 1000,
  music: 1000,
  books: 1000,
  aboutMe: 2000,
};

const WALL_ERRORS: Record<string, string> = {
  wall_limit: "You're posting on walls a lot right now. Take a breather and try again later.",
  not_joined: "This person hasn't joined yet, so their wall is closed.",
  friends_only: "Only friends can start a post on this wall.",
  suspended: "This account is suspended, so its wall is closed.",
};

/** Small marker admins see next to a suspended person's name. */
const SuspendedBadge = () => <span class="suspended-badge">suspended</span>;

// Set by /friends/request when the sender hits the rate limit.
const FRIEND_ERRORS: Record<string, string> = {
  friend_limit: "You've sent a lot of friend requests recently. Try again in a little while.",
  suspended: "That account is suspended, so you can't add it as a friend right now.",
};

const firstName = (name: string) => name.split(" ")[0];

/** "@user", "t.me/user", "https://github.com/user/" → "user". */
export function cleanHandle(raw: string): string {
  let s = raw.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(s)) s = s.slice(s.indexOf("/") + 1);
  s = (s.split(/[/?#]/)[0] ?? "").replace(/^@+/, "");
  return s.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, MAX.handle);
}

function cleanName(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/\p{Cc}/gu, "")
    .trim();
}

function parseLookingFor(value: string): string[] {
  const allowed = new Set<string>(LOOKING_FOR);
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => allowed.has(v));
}

type WallRow = WallPost & {
  author: Pick<User, "id" | "name" | "rep" | "claimedAt">;
};

function WallThread(props: {
  node: TreeNode<WallRow>;
  viewer: User;
  profile: User;
  votes: Map<number, number>;
  canReply: boolean;
  depth: number;
}) {
  const { node, viewer, profile, votes, canReply, depth } = props;
  const canDelete =
    node.authorUserId === viewer.id || profile.id === viewer.id || isAdmin(viewer);
  return (
    <div class={depth === 0 ? "wall-post" : "wall-reply"} id={`wall-${node.id}`}>
      <div class="thing">
        <VoteBox
          type="wall"
          id={node.id}
          score={node.score}
          myVote={votes.get(node.id)}
          own={node.authorUserId === viewer.id}
        />
        <div class="thing-body">
          <UserLink user={node.author} />{" "}
          <span class="meta">
            {depth === 0 ? "wrote" : "replied"} · {timeAgo(node.createdAt)}
          </span>
          <div class="post-text">{node.body}</div>
          <div class="thing-actions">
            {canReply ? (
              <details class="reply-box">
                <summary>reply</summary>
                <form method="post" action={`/wall/${profile.id}`}>
                  <input type="hidden" name="parentId" value={String(node.id)} />
                  <textarea name="body" rows={2} required maxlength={2000} />
                  <button class="btn btn-small" type="submit">
                    Reply
                  </button>
                </form>
              </details>
            ) : null}
            {canDelete ? (
              <form
                method="post"
                action={`/wall/delete/${node.id}`}
                class="inline-form"
                data-confirm="Delete this post and its replies?"
              >
                <button class="btn-link" type="submit">
                  delete
                </button>
              </form>
            ) : null}
          </div>
        </div>
      </div>
      {node.children.length ? (
        <div class={depth < 4 ? "children" : "children flat"}>
          {node.children.map((child) => (
            <WallThread {...props} node={child} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

profileRoutes.get("/profile/:id", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  let viewer = gate.user;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.notFound();
  const [profile] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!profile) return c.notFound();

  if (!(await canViewProfile(viewer, profile))) {
    return c.html(
      <Layout title="Profile" user={viewer} banner="Profile">
        <table class="layout-table">
          <tr>
            <td class="sidebar">
              <LeftNav user={viewer} />
            </td>
            <td class="maincol">
              <Box title="[ Restricted ]">
                <p>This person's privacy settings prevent you from viewing their profile.</p>
              </Box>
            </td>
          </tr>
        </table>
      </Layout>
    );
  }

  const status = await friendshipStatus(viewer.id, profile.id);
  const first = firstName(profile.name);
  const friendError = FRIEND_ERRORS[c.req.query("error") ?? ""];
  const admin = isAdmin(viewer);
  const suspended = profile.suspendedAt !== null;
  // Non-admins get a closed profile: no wall form, pokes, messages or requests.
  const closed = suspended && !admin;
  const suspendedNote = <p class="suspended-note">This account is suspended.</p>;

  // On the student list but not activated: a placeholder page with an invite.
  if (profile.claimedAt === null) {
    viewer = await ensureReferralCode(viewer);
    const link = inviteLink(c, viewer, profile);
    return c.html(
      <Layout title={profile.name} user={viewer} banner={profile.name}>
        <table class="layout-table">
          <tr>
            <td class="sidebar">
              <LeftNav user={viewer} />
              <div class="box">
                <div class="box-title">Picture</div>
                <div class="box-body photo-frame">
                  <div class="no-photo">not joined yet</div>
                </div>
              </div>
              {closed ? null : (
                <div class="profile-actions">
                  <div class="friend-action">
                    <FriendButton userId={profile.id} status={status} />
                  </div>
                  {status === "pending_out" ? (
                    <p class="meta">
                      Your request will be waiting for {first} when they join.
                    </p>
                  ) : null}
                </div>
              )}
            </td>
            <td class="maincol">
              {friendError ? <p class="error">{friendError}</p> : null}
              {closed ? suspendedNote : null}
              <div class="profile-head unclaimed-profile">
                <div class="profile-name">
                  {profile.name} <NotJoined />
                  {suspended && admin ? <SuspendedBadge /> : null}
                </div>
                {profile.nativeName && profile.nativeName !== profile.name ? (
                  <div class="native-name">{profile.nativeName}</div>
                ) : null}
                <p>
                  {first} is on the QAIRU student list but hasn't joined
                  theqairubook yet.
                </p>
              </div>

              {closed ? null : (
                <div id="invite">
                  <Box title={`[ Invite ${first} ]`} alt>
                    <p>
                      Send {first} this personal invite link. They'll need their
                      @qairu.edu.kz email to activate their account, and you get{" "}
                      <b>+{REP.referral} rep</b> when they do (you'll become
                      friends automatically).
                    </p>
                    <InviteCopy
                      id="invite-target"
                      link={link}
                      message={inviteMessage(viewer.name, link, profile.name)}
                    />
                  </Box>
                </div>
              )}

              <div class="box" style="margin-top:12px">
                <div class="box-title">The Wall</div>
                <div class="box-body">
                  <p class="meta">{first}'s wall opens when they join.</p>
                </div>
              </div>
            </td>
          </tr>
        </table>
      </Layout>
    );
  }

  const mutual = await mutualFriends(viewer.id, profile.id);

  const authorCols = {
    id: users.id,
    name: users.name,
    rep: users.rep,
    claimedAt: users.claimedAt,
  };
  const topLevel = await db
    .select({ post: wallPosts, author: authorCols })
    .from(wallPosts)
    .innerJoin(users, eq(wallPosts.authorUserId, users.id))
    .where(and(eq(wallPosts.profileUserId, profile.id), isNull(wallPosts.parentId)))
    .orderBy(desc(wallPosts.createdAt))
    .limit(30);
  const replies = topLevel.length
    ? await db
        .select({ post: wallPosts, author: authorCols })
        .from(wallPosts)
        .innerJoin(users, eq(wallPosts.authorUserId, users.id))
        .where(and(eq(wallPosts.profileUserId, profile.id), isNotNull(wallPosts.parentId)))
        .orderBy(desc(wallPosts.createdAt))
        .limit(500)
    : [];
  const wallRows: WallRow[] = [...topLevel, ...replies].map((r) => ({
    ...r.post,
    author: r.author,
  }));
  const topIds = new Set(topLevel.map((r) => r.post.id));
  const wallTree = buildTree(wallRows, (a, b) =>
    topIds.has(a.id) && topIds.has(b.id)
      ? b.createdAt.getTime() - a.createdAt.getTime()
      : a.createdAt.getTime() - b.createdAt.getTime()
  ).filter((n) => topIds.has(n.id));
  const wallVotes = await myVotes(
    viewer.id,
    "wall",
    wallRows.map((r) => r.id)
  );

  const [{ posts: postCount }] = await db
    .select({ posts: count() })
    .from(discussionPosts)
    .where(and(eq(discussionPosts.authorUserId, profile.id), eq(discussionPosts.deleted, false)));
  const [{ comments: commentCount }] = await db
    .select({ comments: count() })
    .from(discussionComments)
    .where(
      and(eq(discussionComments.authorUserId, profile.id), eq(discussionComments.deleted, false))
    );

  const canWall =
    !closed && (viewer.id === profile.id || (await areFriends(viewer.id, profile.id)));
  const photo = defaultPhoto(profile);
  const isYou = viewer.id === profile.id;
  const website = safeHref(profile.website);
  const wallError = WALL_ERRORS[c.req.query("error") ?? ""];

  const lookingFor = parseLookingFor(profile.lookingFor);
  const telegram = cleanHandle(profile.telegram);
  const github = cleanHandle(profile.github);
  const instagram = cleanHandle(profile.instagram);
  const linkedin = safeHref(profile.linkedin);
  const links = [
    telegram ? { label: "Telegram", href: `https://t.me/${telegram}`, text: `@${telegram}` } : null,
    github ? { label: "GitHub", href: `https://github.com/${github}`, text: github } : null,
    instagram
      ? { label: "Instagram", href: `https://instagram.com/${instagram}`, text: `@${instagram}` }
      : null,
    linkedin ? { label: "LinkedIn", href: linkedin, text: "profile" } : null,
  ].filter((l): l is { label: string; href: string; text: string } => l !== null);

  return c.html(
    <Layout
      title={profile.name}
      user={viewer}
      banner={isYou ? `Welcome ${first}!` : profile.name}
    >
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={viewer} />
            <div class="box">
              <div class="box-title">Picture</div>
              <div class="box-body photo-frame">
                {photo ? (
                  <img src={photo} alt={profile.name} />
                ) : (
                  <div class="no-photo">no photo</div>
                )}
              </div>
            </div>
            {!isYou ? (
              <div class="profile-actions">
                {closed ? null : (
                  <>
                    <a class="btn btn-block" href={`/messages/with/${profile.id}`}>
                      Message {first}
                    </a>
                    <form method="post" action={`/poke/${profile.id}`}>
                      <button class="btn btn-block btn-gray" type="submit">
                        Poke {profile.sex === "Female" ? "Her" : profile.sex === "Male" ? "Him" : "Them"}!
                      </button>
                    </form>
                  </>
                )}
                <div class="friend-action">
                  {closed && status !== "friends" && status !== "pending_out" ? null : (
                    <FriendButton userId={profile.id} status={status} />
                  )}
                  {status === "friends" ? (
                    <form
                      method="post"
                      action={`/friends/remove/${profile.id}`}
                      class="inline-form"
                      data-confirm={`Remove ${profile.name} from your friends?`}
                    >
                      {" · "}
                      <button class="btn-link" type="submit">
                        unfriend
                      </button>
                    </form>
                  ) : null}
                </div>
              </div>
            ) : (
              <p>
                <a href="/edit-profile">[ edit ]</a>
              </p>
            )}
            {!isYou ? (
              <div class="box" style="margin-top:10px">
                <div class="box-title">Connection</div>
                <div class="box-body">
                  {status === "friends" ? (
                    <p>You are friends with {first}.</p>
                  ) : (
                    <p>You are in the same network as {first}.</p>
                  )}
                  {mutual.length ? (
                    <p>
                      <b>{mutual.length}</b> mutual friend
                      {mutual.length === 1 ? "" : "s"}:
                      <br />
                      {mutual.map((m, i) => (
                        <>
                          {i > 0 ? ", " : ""}
                          <a href={`/profile/${m.id}`}>{m.name}</a>
                        </>
                      ))}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </td>
          <td class="maincol">
            {friendError ? <p class="error">{friendError}</p> : null}
            {closed ? suspendedNote : null}
            <div class="profile-head">
              <div class="profile-name">
                {profile.name}
                {suspended && admin ? <SuspendedBadge /> : null}
              </div>
              {profile.nativeName && profile.nativeName !== profile.name ? (
                <div class="native-name">{profile.nativeName}</div>
              ) : null}
              {profile.headline ? (
                <div class="profile-headline">{profile.headline}</div>
              ) : isYou ? (
                <div class="meta">
                  No headline yet — <a href="/edit-profile">write one</a>.
                </div>
              ) : null}
            </div>

            <div class="box">
              <div class="box-title">
                Information{isYou ? " (This is you)" : ""}
              </div>
              <div class="box-body">
                <div class="section-label">Account Info:</div>
                <table>
                  <tr>
                    <td class="field-label">Name:</td>
                    <td>{profile.name}</td>
                  </tr>
                  <tr>
                    <td class="field-label">Rep:</td>
                    <td>
                      <b>{profile.rep}</b>
                      <span class="meta">
                        {" "}
                        · {postCount} discussion post{postCount === 1 ? "" : "s"} ·{" "}
                        {commentCount} comment{commentCount === 1 ? "" : "s"} ·{" "}
                        <a href="/rep">leaderboard</a>
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Member Since:</td>
                    <td>{formatDate(profile.claimedAt ?? profile.memberSince)}</td>
                  </tr>
                  <tr>
                    <td class="field-label">Last Update:</td>
                    <td>{formatDate(profile.lastUpdate)}</td>
                  </tr>
                </table>

                <div class="section-label">Basic Info:</div>
                <table>
                  <tr>
                    <td class="field-label">School:</td>
                    <td>{profile.school}</td>
                  </tr>
                  <tr>
                    <td class="field-label">Status:</td>
                    <td>{profile.status}</td>
                  </tr>
                  {profile.sex ? (
                    <tr>
                      <td class="field-label">Sex:</td>
                      <td>{profile.sex}</td>
                    </tr>
                  ) : null}
                  {profile.residence ? (
                    <tr>
                      <td class="field-label">Residence:</td>
                      <td>{profile.residence}</td>
                    </tr>
                  ) : null}
                  {profile.birthday ? (
                    <tr>
                      <td class="field-label">Birthday:</td>
                      <td>{profile.birthday}</td>
                    </tr>
                  ) : null}
                  {profile.hometown ? (
                    <tr>
                      <td class="field-label">Home Town:</td>
                      <td>{profile.hometown}</td>
                    </tr>
                  ) : null}
                  {profile.highSchool ? (
                    <tr>
                      <td class="field-label">High School:</td>
                      <td>{profile.highSchool}</td>
                    </tr>
                  ) : null}
                  {profile.classYear ? (
                    <tr>
                      <td class="field-label">Class Year:</td>
                      <td>{profile.classYear}</td>
                    </tr>
                  ) : null}
                </table>

                <div class="section-label">Contact Info:</div>
                <table>
                  <tr>
                    <td class="field-label">Email:</td>
                    <td>
                      <a href={`mailto:${profile.email}`}>{profile.email}</a>
                    </td>
                  </tr>
                  {profile.screenname ? (
                    <tr>
                      <td class="field-label">Screenname:</td>
                      <td>{profile.screenname}</td>
                    </tr>
                  ) : null}
                  {profile.mobile ? (
                    <tr>
                      <td class="field-label">Mobile:</td>
                      <td>{profile.mobile}</td>
                    </tr>
                  ) : null}
                  {website ? (
                    <tr>
                      <td class="field-label">Website:</td>
                      <td>
                        <a href={website} rel="nofollow noopener" target="_blank">
                          {profile.website}
                        </a>
                      </td>
                    </tr>
                  ) : null}
                </table>

                {links.length ? (
                  <>
                    <div class="section-label">Links:</div>
                    <p class="links-row">
                      {links.map((l) => (
                        <span class="link-item">
                          <b>{l.label}:</b>{" "}
                          <a href={l.href} rel="nofollow noopener" target="_blank">
                            {l.text}
                          </a>
                        </span>
                      ))}
                    </p>
                  </>
                ) : null}

                {lookingFor.length ? (
                  <>
                    <div class="section-label">Looking For:</div>
                    <p class="chips">
                      {lookingFor.map((item) => (
                        <span class="chip">{item}</span>
                      ))}
                    </p>
                  </>
                ) : null}

                {profile.courses ? (
                  <>
                    <div class="section-label">Courses:</div>
                    <p>
                      {parseCourses(profile.courses).map((course, i) => (
                        <>
                          {i > 0 ? ", " : ""}
                          <a href={`/courses/${encodeURIComponent(course)}`}>
                            {course}
                          </a>
                        </>
                      ))}
                    </p>
                  </>
                ) : null}

                {profile.clubs ? (
                  <>
                    <div class="section-label">Clubs &amp; Projects:</div>
                    <p class="pre-line">{profile.clubs}</p>
                  </>
                ) : null}

                {profile.interests ? (
                  <>
                    <div class="section-label">Interests:</div>
                    <p>{profile.interests}</p>
                  </>
                ) : null}
                {profile.music ? (
                  <>
                    <div class="section-label">Favorite Music:</div>
                    <p>{profile.music}</p>
                  </>
                ) : null}
                {profile.books ? (
                  <>
                    <div class="section-label">Favorite Books:</div>
                    <p>{profile.books}</p>
                  </>
                ) : null}
                {profile.aboutMe ? (
                  <>
                    <div class="section-label">About Me:</div>
                    <p class="pre-line">{profile.aboutMe}</p>
                  </>
                ) : null}
              </div>
            </div>

            <div class="box" style="margin-top:12px" id="wall">
              <div class="box-title">The Wall</div>
              <div class="box-body">
                {wallError ? <p class="error">{wallError}</p> : null}
                {closed ? null : canWall ? (
                  <form method="post" action={`/wall/${profile.id}`}>
                    <textarea
                      name="body"
                      rows={3}
                      required
                      maxlength={2000}
                      placeholder={isYou ? "What's on your mind?" : `Write something to ${first}...`}
                    />
                    <div class="btn-row">
                      <button class="btn" type="submit">
                        Post
                      </button>
                    </div>
                  </form>
                ) : (
                  <p class="meta">
                    Only friends can start a post on this wall — but anyone can
                    reply and vote.
                  </p>
                )}
                {wallTree.map((node) => (
                  <WallThread
                    node={node}
                    viewer={viewer}
                    profile={profile}
                    votes={wallVotes}
                    canReply={!closed}
                    depth={0}
                  />
                ))}
                {!wallTree.length ? <p class="meta">No wall posts yet.</p> : null}
              </div>
            </div>
          </td>
        </tr>
      </table>
    </Layout>
  );
});

profileRoutes.get("/edit-profile", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const welcome = c.req.query("welcome") === "1";
  const friendsCount = welcome ? (await friendIds(user.id)).length : 0;
  return c.html(editForm(user, { welcome, friendsCount }));
});

profileRoutes.post("/edit-profile", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const body = await c.req.parseBody({ all: true });

  // Single string value of a field, or undefined when it wasn't submitted.
  const field = (key: string): string | undefined => {
    const raw = body[key];
    const one = Array.isArray(raw) ? raw[0] : raw;
    return typeof one === "string" ? one : undefined;
  };
  // Trimmed + capped, defaulting to the stored value when absent.
  const text = (key: keyof typeof MAX & keyof User, current: string) => {
    const v = field(key);
    return v === undefined ? current : v.trim().slice(0, MAX[key]);
  };
  const errors: string[] = [];

  let name = user.name;
  const rawName = field("name");
  if (rawName !== undefined) {
    const cleaned = cleanName(rawName);
    if (cleaned.length < 2 || cleaned.length > MAX.name) {
      errors.push(`Display name must be 2–${MAX.name} characters. Kept "${user.name}".`);
    } else {
      name = cleaned;
    }
  }

  let lookingFor = user.lookingFor;
  if (field("lookingFor_present") !== undefined) {
    const raw = body.lookingFor;
    const picked = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(
      (v): v is string => typeof v === "string"
    );
    lookingFor = LOOKING_FOR.filter((opt) => picked.includes(opt)).join(",");
  }

  const handle = (key: "telegram" | "github" | "instagram") => {
    const v = field(key);
    return v === undefined ? user[key] : cleanHandle(v);
  };
  const rawLinkedin = field("linkedin");
  const linkedin =
    rawLinkedin === undefined
      ? user.linkedin
      : rawLinkedin.trim()
        ? (safeHref(rawLinkedin.slice(0, MAX.linkedin)) ?? "")
        : "";
  if (rawLinkedin?.trim() && !linkedin) errors.push("That LinkedIn link doesn't look like a web address.");

  const rawSex = field("sex");
  const sex = rawSex !== undefined && ["", "Male", "Female"].includes(rawSex) ? rawSex : user.sex;
  const rawStatus = field("status");
  const status = rawStatus !== undefined && STATUSES.includes(rawStatus) ? rawStatus : user.status;

  // Photo: identified by magic bytes, never by the file name.
  let photoPath = user.photoPath;
  let photoBytes: Buffer | null = null;
  let photoExt = "";
  const rawPhoto = Array.isArray(body.photo) ? body.photo[0] : body.photo;
  if (rawPhoto && typeof rawPhoto === "object" && "arrayBuffer" in rawPhoto && rawPhoto.size > 0) {
    const f = rawPhoto as File;
    if (f.size > MEDIA_LIMITS.imageBytes) {
      errors.push(
        `Your photo is ${formatBytes(f.size)} — pictures can be up to ${formatBytes(MEDIA_LIMITS.imageBytes)}. Your other changes were saved.`
      );
    } else if (!withinLimit("uploadsPerUser", user.id)) {
      errors.push("You've uploaded a lot of files recently. Try the photo again later — your other changes were saved.");
    } else {
      const bytes = Buffer.from(await f.arrayBuffer());
      const sniffed = sniff(bytes);
      if (!sniffed || sniffed.kind !== "image") {
        errors.push("That photo isn't a JPG, PNG, GIF or WEBP image. Your other changes were saved.");
      } else {
        photoBytes = bytes;
        photoExt = sniffed.ext;
      }
    }
  }

  const uploadDir = process.env.UPLOAD_DIR ?? "./uploads";
  if (photoBytes) {
    await mkdir(uploadDir, { recursive: true });
    const filename = `${user.id}-${Date.now()}${photoExt}`;
    await writeFile(path.join(uploadDir, filename), photoBytes);
    photoPath = filename;
  }

  const [updated] = await db
    .update(users)
    .set({
      name,
      headline: text("headline", user.headline),
      lookingFor,
      clubs: text("clubs", user.clubs),
      telegram: handle("telegram"),
      github: handle("github"),
      instagram: handle("instagram"),
      linkedin,
      residence: text("residence", user.residence),
      birthday: text("birthday", user.birthday),
      hometown: text("hometown", user.hometown),
      highSchool: text("highSchool", user.highSchool),
      screenname: text("screenname", user.screenname),
      mobile: text("mobile", user.mobile),
      website: text("website", user.website),
      courses: text("courses", user.courses),
      interests: text("interests", user.interests),
      music: text("music", user.music),
      books: text("books", user.books),
      aboutMe: text("aboutMe", user.aboutMe),
      classYear: text("classYear", user.classYear),
      sex,
      status,
      photoPath,
      lastUpdate: new Date(),
    })
    .where(eq(users.id, user.id))
    .returning();

  // Replace the old picture file (only plain file names we generated).
  if (photoBytes && user.photoPath && path.basename(user.photoPath) === user.photoPath) {
    await unlink(path.join(uploadDir, user.photoPath)).catch(() => {});
  }

  if (errors.length) {
    return c.html(editForm(updated ?? user, { error: errors.join(" ") }), 400);
  }
  return c.redirect(`/profile/${user.id}`);
});

profileRoutes.get("/account", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const usage = await mediaUsage(user.id);
  const pct = Math.min(100, Math.round((usage.bytes / MEDIA_LIMITS.userQuotaBytes) * 100));
  const uploads = await mediaForUser(user.id);
  return c.html(
    <Layout title="Account" user={user} banner="My Account">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <Box title="[ My Account ]" alt>
              <table>
                <tr>
                  <td class="field-label">Email:</td>
                  <td>{user.email}</td>
                </tr>
                <tr>
                  <td class="field-label">Name:</td>
                  <td>{user.name}</td>
                </tr>
                {user.nativeName && user.nativeName !== user.name ? (
                  <tr>
                    <td class="field-label">Official Name:</td>
                    <td>{user.nativeName}</td>
                  </tr>
                ) : null}
                <tr>
                  <td class="field-label">Member Since:</td>
                  <td>{formatDate(user.memberSince)}</td>
                </tr>
                <tr>
                  <td class="field-label">Activated:</td>
                  <td>{user.claimedAt ? formatDate(user.claimedAt) : "—"}</td>
                </tr>
              </table>
              <p>
                <a href="/edit-profile">Edit Profile</a> ·{" "}
                <a href="/account/password">Change Password</a> ·{" "}
                <a href="/privacy">Privacy Settings</a>
              </p>
              <p class="meta">
                Forgot your password? <a href="/forgot">Reset it by email</a>.
              </p>
            </Box>

            <div id="uploads">
              <Box title="[ My Uploads ]">
                <p>
                  You've used <b>{formatBytes(usage.bytes)}</b> of{" "}
                  {formatBytes(MEDIA_LIMITS.userQuotaBytes)}.
                </p>
                <div class="usage-bar" title={`${pct}%`}>
                  <div class="usage-fill" style={`width:${pct}%`}></div>
                </div>
                <p class="meta">
                  Covers images and PDFs attached to discussion posts and
                  comments. {usage.today} of {MEDIA_LIMITS.dailyUploads} daily
                  uploads used in the last 24 hours. Deleting a file, post or
                  comment frees its space.
                </p>
                {uploads.length ? (
                  <div class="uploads-scroll">
                    <table class="bordertable uploads-table">
                      <tr>
                        <th>File</th>
                        <th>Size</th>
                        <th>Uploaded</th>
                        <th>Attached to</th>
                        <th></th>
                      </tr>
                      {uploads.map((m) => {
                        const url = mediaUrl(m);
                        const where =
                          m.postId !== null
                            ? { href: `/d/p/${m.postId}`, label: "post" }
                            : m.commentId !== null
                              ? { href: `/d/c/${m.commentId}`, label: "comment" }
                              : null;
                        return (
                          <tr>
                            <td class="upload-file">
                              {m.kind === "image" ? (
                                <a href={url} target="_blank" rel="noopener">
                                  <img class="upload-thumb" src={url} alt="" loading="lazy" />
                                </a>
                              ) : (
                                <span class="upload-pdf">PDF</span>
                              )}
                              <a href={url} target="_blank" rel="noopener" class="upload-name">
                                {m.originalName}
                              </a>
                            </td>
                            <td class="nowrap">{formatBytes(m.sizeBytes)}</td>
                            <td class="nowrap">{formatDate(m.createdAt)}</td>
                            <td>
                              {where ? <a href={where.href}>{where.label}</a> : <span class="meta">—</span>}
                            </td>
                            <td class="actions">
                              <form
                                method="post"
                                action={`/media/${m.id}/delete`}
                                class="inline-form"
                                data-confirm="Delete this file? It will disappear from the post."
                              >
                                <button class="btn-link" type="submit">
                                  delete
                                </button>
                              </form>
                            </td>
                          </tr>
                        );
                      })}
                    </table>
                  </div>
                ) : (
                  <p class="meta">You haven't uploaded anything yet.</p>
                )}
              </Box>
            </div>
          </td>
        </tr>
      </table>
    </Layout>
  );
});

profileRoutes.get("/privacy", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  return c.html(
    <Layout title="Privacy" user={user} banner="Privacy">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <Box title="[ Privacy Settings ]" alt>
              <form method="post" action="/privacy">
                <p>Who can view my profile?</p>
                <p>
                  <label>
                    <input
                      type="radio"
                      name="privacy"
                      value="network"
                      checked={user.privacy === "network"}
                    />{" "}
                    Everyone at QAIRU
                  </label>
                  <br />
                  <label>
                    <input
                      type="radio"
                      name="privacy"
                      value="friends_of_friends"
                      checked={user.privacy === "friends_of_friends"}
                    />{" "}
                    Friends of friends
                  </label>
                  <br />
                  <label>
                    <input
                      type="radio"
                      name="privacy"
                      value="friends"
                      checked={user.privacy === "friends"}
                    />{" "}
                    Only my friends
                  </label>
                </p>
                <button class="btn" type="submit">
                  Save
                </button>
              </form>
            </Box>
          </td>
        </tr>
      </table>
    </Layout>
  );
});

profileRoutes.post("/privacy", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const body = await c.req.parseBody();
  const privacy = String(body.privacy ?? "network");
  if (!["network", "friends", "friends_of_friends"].includes(privacy)) {
    return c.redirect("/privacy");
  }
  await db.update(users).set({ privacy }).where(eq(users.id, user.id));
  return c.redirect("/privacy");
});

profileRoutes.post("/wall/:id", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const author = gate.user;
  const profileId = Number(c.req.param("id"));
  if (!Number.isInteger(profileId)) return c.notFound();
  const body = await c.req.parseBody();
  const text = String(body.body ?? "").trim();
  const parentRaw = Number(body.parentId ?? 0);
  const parentId = Number.isInteger(parentRaw) && parentRaw > 0 ? parentRaw : null;
  const back = (error?: string) =>
    c.redirect(`/profile/${profileId}${error ? `?error=${error}#wall` : ""}`);
  if (!text) return back();

  const [profile] = await db.select().from(users).where(eq(users.id, profileId)).limit(1);
  if (!profile) return c.notFound();
  // Walls of people who haven't activated stay closed.
  if (profile.claimedAt === null) return back("not_joined");
  if (profile.suspendedAt !== null && !isAdmin(author)) return back("suspended");

  let parent: WallPost | undefined;
  if (parentId) {
    // Replies: anyone who can see the profile may join the thread.
    [parent] = await db.select().from(wallPosts).where(eq(wallPosts.id, parentId)).limit(1);
    if (!parent || parent.profileUserId !== profileId) return back();
    if (!(await canViewProfile(author, profile))) return back();
  } else {
    const allowed = author.id === profileId || (await areFriends(author.id, profileId));
    if (!allowed) return back("friends_only");
  }

  if (!withinLimit("wallPerUser", author.id)) return back("wall_limit");

  const [post] = await db
    .insert(wallPosts)
    .values({
      profileUserId: profileId,
      authorUserId: author.id,
      parentId,
      body: text.slice(0, 2000),
    })
    .returning();

  if (parent) {
    await awardReply(parent.authorUserId, author.id, "wall", parent.id);
  } else {
    await addBoardEvent(author.id, "wall", text.slice(0, 120), profileId);
  }
  return c.redirect(`/profile/${profileId}#wall-${post.id}`);
});

profileRoutes.post("/wall/delete/:postId", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const postId = Number(c.req.param("postId"));
  if (!Number.isInteger(postId)) return c.redirect("/home");
  const [post] = await db.select().from(wallPosts).where(eq(wallPosts.id, postId)).limit(1);
  if (!post) return c.redirect("/home");
  // Author, wall owner, or an admin moderating.
  if (post.authorUserId === user.id || post.profileUserId === user.id || isAdmin(user)) {
    await db.delete(wallPosts).where(eq(wallPosts.id, postId));
  }
  return c.redirect(`/profile/${post.profileUserId}`);
});

function Onboarding({ user, friendsCount }: { user: User; friendsCount: number }) {
  const steps: { done: boolean; label: string; hint: Child }[] = [
    { done: Boolean(user.photoPath), label: "Add a photo", hint: "use the Picture field below" },
    { done: Boolean(user.headline), label: "Write a headline", hint: "one line about you, below" },
    {
      done: Boolean(user.courses || user.interests),
      label: "Add your courses & interests",
      hint: "so classmates in your classes can find you",
    },
    {
      done: friendsCount > 0,
      label: "Find friends",
      hint: <a href="/friends">search for classmates</a>,
    },
    {
      done: false,
      label: "Say hi in Discussions",
      hint: <a href="/d">homework help, coding, study materials</a>,
    },
    {
      done: false,
      label: "Invite classmates",
      hint: <a href="/invite">+{REP.referral} rep for each one who joins</a>,
    },
  ];
  return (
    <div class="onboarding">
      <div class="welcome-title">Welcome to theqairubook! Here's how to get started:</div>
      <ul class="onboarding-list">
        {steps.map((s) => (
          <li class={s.done ? "done" : ""}>
            <span class="check">{s.done ? "✓" : "☐"}</span> <b>{s.label}</b>{" "}
            <span class="meta">— {s.hint}</span>
          </li>
        ))}
      </ul>
      {user.referredByUserId ? (
        <p class="meta">You're already friends with whoever invited you.</p>
      ) : null}
    </div>
  );
}

function editForm(
  user: User,
  opts: { error?: string; welcome?: boolean; friendsCount?: number } = {}
) {
  const { error, welcome, friendsCount = 0 } = opts;
  const picked = parseLookingFor(user.lookingFor);
  const photo = defaultPhoto(user);
  return (
    <Layout title="Edit Profile" user={user} banner="Edit My Profile">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <Box title="[ Edit Profile ]" alt>
              {welcome ? <Onboarding user={user} friendsCount={friendsCount} /> : null}
              {error ? <p class="error">{error}</p> : null}
              <form method="post" action="/edit-profile" enctype="multipart/form-data">
                <table class="search-form">
                  <tr>
                    <td class="field-label">Display Name:</td>
                    <td>
                      <input
                        type="text"
                        name="name"
                        size={30}
                        required
                        minlength={2}
                        maxlength={MAX.name}
                        value={user.name}
                      />
                      {user.nativeName && user.nativeName !== user.name ? (
                        <div class="meta">Official name: {user.nativeName}</div>
                      ) : null}
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Headline:</td>
                    <td>
                      <input
                        type="text"
                        name="headline"
                        class="wide-input"
                        maxlength={MAX.headline}
                        value={user.headline}
                        placeholder="CS '28 · building AI agents · ask me about linear algebra"
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Picture:</td>
                    <td>
                      {photo ? (
                        <img class="edit-thumb" src={photo} alt="current picture" />
                      ) : null}
                      <input type="file" name="photo" accept={PHOTO_ACCEPT} />
                      <div class="meta">
                        JPG, PNG, GIF or WEBP, up to {formatBytes(MEDIA_LIMITS.imageBytes)}.
                        {photo ? " Uploading a new one replaces the current picture." : ""}
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Status:</td>
                    <td>
                      <select name="status">
                        {STATUSES.map((s) => (
                          <option selected={user.status === s}>{s}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Sex:</td>
                    <td>
                      <select name="sex">
                        <option value="">-</option>
                        <option selected={user.sex === "Male"}>Male</option>
                        <option selected={user.sex === "Female"}>Female</option>
                      </select>
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Class Year:</td>
                    <td>
                      <input
                        type="text"
                        name="classYear"
                        size={20}
                        maxlength={MAX.classYear}
                        value={user.classYear}
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Residence:</td>
                    <td>
                      <input
                        type="text"
                        name="residence"
                        size={30}
                        maxlength={MAX.residence}
                        value={user.residence}
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Birthday:</td>
                    <td>
                      <input
                        type="text"
                        name="birthday"
                        size={30}
                        maxlength={MAX.birthday}
                        value={user.birthday}
                        placeholder="e.g. March 15, 2005"
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Home Town:</td>
                    <td>
                      <input
                        type="text"
                        name="hometown"
                        size={30}
                        maxlength={MAX.hometown}
                        value={user.hometown}
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">High School:</td>
                    <td>
                      <input
                        type="text"
                        name="highSchool"
                        size={30}
                        maxlength={MAX.highSchool}
                        value={user.highSchool}
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Screenname:</td>
                    <td>
                      <input
                        type="text"
                        name="screenname"
                        size={30}
                        maxlength={MAX.screenname}
                        value={user.screenname}
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Mobile:</td>
                    <td>
                      <input
                        type="text"
                        name="mobile"
                        size={30}
                        maxlength={MAX.mobile}
                        value={user.mobile}
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Website:</td>
                    <td>
                      <input
                        type="text"
                        name="website"
                        size={30}
                        maxlength={MAX.website}
                        value={user.website}
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Telegram:</td>
                    <td>
                      @
                      <input
                        type="text"
                        name="telegram"
                        size={24}
                        maxlength={MAX.handle + 30}
                        value={user.telegram}
                        placeholder="username"
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">GitHub:</td>
                    <td>
                      <input
                        type="text"
                        name="github"
                        size={24}
                        maxlength={MAX.handle + 30}
                        value={user.github}
                        placeholder="username"
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Instagram:</td>
                    <td>
                      @
                      <input
                        type="text"
                        name="instagram"
                        size={24}
                        maxlength={MAX.handle + 30}
                        value={user.instagram}
                        placeholder="username"
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">LinkedIn:</td>
                    <td>
                      <input
                        type="text"
                        name="linkedin"
                        size={40}
                        maxlength={MAX.linkedin}
                        value={user.linkedin}
                        placeholder="https://www.linkedin.com/in/..."
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Looking For:</td>
                    <td>
                      <input type="hidden" name="lookingFor_present" value="1" />
                      <div class="checkbox-grid">
                        {LOOKING_FOR.map((opt) => (
                          <label>
                            <input
                              type="checkbox"
                              name="lookingFor"
                              value={opt}
                              checked={picked.includes(opt)}
                            />{" "}
                            {opt}
                          </label>
                        ))}
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Courses:</td>
                    <td>
                      <textarea name="courses" rows={3} maxlength={MAX.courses}>
                        {user.courses}
                      </textarea>
                      <br />
                      <span class="meta">
                        Comma-separated, e.g. Intro to Programming, Linear
                        Algebra, AI Systems
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Clubs &amp; Projects:</td>
                    <td>
                      <textarea name="clubs" rows={3} maxlength={MAX.clubs}>
                        {user.clubs}
                      </textarea>
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Interests:</td>
                    <td>
                      <textarea name="interests" rows={2} maxlength={MAX.interests}>
                        {user.interests}
                      </textarea>
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Music:</td>
                    <td>
                      <textarea name="music" rows={2} maxlength={MAX.music}>
                        {user.music}
                      </textarea>
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Books:</td>
                    <td>
                      <textarea name="books" rows={2} maxlength={MAX.books}>
                        {user.books}
                      </textarea>
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">About Me:</td>
                    <td>
                      <textarea name="aboutMe" rows={4} maxlength={MAX.aboutMe}>
                        {user.aboutMe}
                      </textarea>
                    </td>
                  </tr>
                </table>
                <div class="btn-row">
                  <button class="btn" type="submit">
                    Save Changes
                  </button>
                </div>
              </form>
            </Box>
          </td>
        </tr>
      </table>
    </Layout>
  );
}
