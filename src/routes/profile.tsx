import { Hono } from "hono";
import { eq, desc, and, isNull, isNotNull, count } from "drizzle-orm";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppEnv } from "../middleware/auth.js";
import { needLogin } from "../middleware/auth.js";
import {
  Layout,
  LeftNav,
  Box,
  VoteBox,
  UserLink,
  FriendButton,
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
  mutualFriends,
  canViewProfile,
  areFriends,
  addBoardEvent,
  parseCourses,
  buildTree,
  type TreeNode,
} from "../lib/social.js";
import { awardReply, myVotes } from "../lib/rep.js";
import { safeHref } from "../lib/url.js";

export const profileRoutes = new Hono<AppEnv>();

const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp"];

type WallRow = WallPost & { author: Pick<User, "id" | "name" | "rep"> };

function WallThread(props: {
  node: TreeNode<WallRow>;
  viewer: User;
  profile: User;
  votes: Map<number, number>;
  canReply: boolean;
  depth: number;
}) {
  const { node, viewer, profile, votes, canReply, depth } = props;
  const canDelete = node.authorUserId === viewer.id || profile.id === viewer.id;
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
  const viewer = gate.user;
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
  const mutual = await mutualFriends(viewer.id, profile.id);

  const authorCols = { id: users.id, name: users.name, rep: users.rep };
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
    viewer.id === profile.id || (await areFriends(viewer.id, profile.id));
  const photo = defaultPhoto(profile);
  const isYou = viewer.id === profile.id;
  const website = safeHref(profile.website);

  return c.html(
    <Layout
      title={profile.name}
      user={viewer}
      banner={isYou ? `Welcome ${profile.name.split(" ")[0]}!` : profile.name}
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
                <a class="btn btn-block" href={`/messages/with/${profile.id}`}>
                  Message {profile.name.split(" ")[0]}
                </a>
                <form method="post" action={`/poke/${profile.id}`}>
                  <button class="btn btn-block btn-gray" type="submit">
                    Poke {profile.sex === "Female" ? "Her" : profile.sex === "Male" ? "Him" : "Them"}!
                  </button>
                </form>
                <div class="friend-action">
                  <FriendButton userId={profile.id} status={status} />
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
                    <p>You are friends with {profile.name.split(" ")[0]}.</p>
                  ) : (
                    <p>You are in the same network as {profile.name.split(" ")[0]}.</p>
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
                    <td>{formatDate(profile.memberSince)}</td>
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
                    <td>
                      <a href="/search?school=QAIRU">{profile.school}</a>
                    </td>
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
                    <p>{profile.aboutMe}</p>
                  </>
                ) : null}
              </div>
            </div>

            <div class="box" style="margin-top:12px">
              <div class="box-title">The Wall</div>
              <div class="box-body">
                {canWall ? (
                  <form method="post" action={`/wall/${profile.id}`}>
                    <textarea
                      name="body"
                      rows={3}
                      required
                      maxlength={2000}
                      placeholder={isYou ? "What's on your mind?" : `Write something to ${profile.name.split(" ")[0]}...`}
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
                    canReply={true}
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
  return c.html(editForm(user, undefined, c.req.query("welcome") === "1"));
});

profileRoutes.post("/edit-profile", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const body = await c.req.parseBody();

  let photoPath = user.photoPath;
  const file = body.photo;
  if (file && typeof file === "object" && "arrayBuffer" in file) {
    const f = file as File;
    const ext = path.extname(f.name || "").toLowerCase();
    // Only image extensions — anything else (e.g. .html) would be served as-is.
    if (f.size > 0 && f.size < 5_000_000 && IMAGE_EXTS.includes(ext)) {
      const uploadDir = process.env.UPLOAD_DIR ?? "./uploads";
      await mkdir(uploadDir, { recursive: true });
      const filename = `${user.id}-${Date.now()}${ext}`;
      const buf = Buffer.from(await f.arrayBuffer());
      await writeFile(path.join(uploadDir, filename), buf);
      photoPath = filename;
    }
  }

  await db
    .update(users)
    .set({
      residence: String(body.residence ?? ""),
      birthday: String(body.birthday ?? ""),
      hometown: String(body.hometown ?? ""),
      highSchool: String(body.highSchool ?? ""),
      screenname: String(body.screenname ?? ""),
      mobile: String(body.mobile ?? ""),
      website: String(body.website ?? ""),
      courses: String(body.courses ?? ""),
      interests: String(body.interests ?? ""),
      music: String(body.music ?? ""),
      books: String(body.books ?? ""),
      aboutMe: String(body.aboutMe ?? ""),
      classYear: String(body.classYear ?? ""),
      sex: String(body.sex ?? user.sex),
      status: String(body.status ?? user.status),
      photoPath,
      lastUpdate: new Date(),
    })
    .where(eq(users.id, user.id));

  return c.redirect(`/profile/${user.id}`);
});

profileRoutes.get("/account", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  return c.html(
    <Layout title="Account" user={user} banner="My Account">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <Box title="[ My Account ]" alt>
              <p>
                <b>Email:</b> {user.email}
                <br />
                <b>Name:</b> {user.name}
                <br />
                <b>Member since:</b> {formatDate(user.memberSince)}
              </p>
              <p>
                <a href="/edit-profile">Edit Profile</a> ·{" "}
                <a href="/privacy">Privacy Settings</a>
              </p>
            </Box>
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
  const body = await c.req.parseBody();
  const text = String(body.body ?? "").trim();
  const parentId = Number(body.parentId ?? 0) || null;
  if (!text || !Number.isInteger(profileId)) return c.redirect(`/profile/${profileId}`);

  const [profile] = await db.select().from(users).where(eq(users.id, profileId)).limit(1);
  if (!profile) return c.notFound();

  let parent: WallPost | undefined;
  if (parentId) {
    // Replies: anyone who can see the profile may join the thread.
    [parent] = await db.select().from(wallPosts).where(eq(wallPosts.id, parentId)).limit(1);
    if (!parent || parent.profileUserId !== profileId) return c.redirect(`/profile/${profileId}`);
    if (!(await canViewProfile(author, profile))) return c.redirect(`/profile/${profileId}`);
  } else {
    const allowed = author.id === profileId || (await areFriends(author.id, profileId));
    if (!allowed) return c.redirect(`/profile/${profileId}`);
  }

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
  const [post] = await db.select().from(wallPosts).where(eq(wallPosts.id, postId)).limit(1);
  if (!post) return c.redirect("/home");
  if (post.authorUserId === user.id || post.profileUserId === user.id) {
    await db.delete(wallPosts).where(eq(wallPosts.id, postId));
  }
  return c.redirect(`/profile/${post.profileUserId}`);
});

function editForm(user: User, error?: string, welcome?: boolean) {
  return (
    <Layout title="Edit Profile" user={user} banner="Edit My Profile">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <Box title="[ Edit Profile ]" alt>
              {welcome ? (
                <p class="notice">
                  Welcome to theqairubook! You're already friends with whoever
                  invited you. Fill in your profile so classmates can find you.
                </p>
              ) : null}
              {error ? <p class="error">{error}</p> : null}
              <form method="post" action="/edit-profile" enctype="multipart/form-data">
                <table class="search-form">
                  <tr>
                    <td class="field-label">Picture:</td>
                    <td>
                      <input type="file" name="photo" accept="image/*" />
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Status:</td>
                    <td>
                      <select name="status">
                        {["Student", "Faculty", "Staff", "Alumnus/Alumna"].map(
                          (s) => (
                            <option selected={user.status === s}>{s}</option>
                          )
                        )}
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
                        value={user.website}
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Courses:</td>
                    <td>
                      <textarea name="courses" rows={3}>
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
                    <td class="field-label">Interests:</td>
                    <td>
                      <textarea name="interests" rows={2}>
                        {user.interests}
                      </textarea>
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Music:</td>
                    <td>
                      <textarea name="music" rows={2}>
                        {user.music}
                      </textarea>
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Books:</td>
                    <td>
                      <textarea name="books" rows={2}>
                        {user.books}
                      </textarea>
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">About Me:</td>
                    <td>
                      <textarea name="aboutMe" rows={4}>
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
