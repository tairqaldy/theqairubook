import { Hono } from "hono";
import type { FC, Child } from "hono/jsx";
import { asc, sql } from "drizzle-orm";
import type { AppEnv } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { boards, discussionPosts, users } from "../db/schema.js";
import { Layout, Box, NotJoined } from "../views/layout.js";
import { REP } from "../lib/rep.js";
import { MEDIA_LIMITS, formatBytes } from "../lib/media.js";
import { emailEnabled } from "../lib/email.js";
import { turnstileEnabled } from "../lib/security.js";

export const publicRoutes = new Hono<AppEnv>();

const ADMIN_NAME = "Tair Kaldybayev";
const ADMIN_EMAIL = "tair.kaldybaev@qairu.edu.kz";
const REPO_URL = "https://github.com/tairqaldy/theqairubook";
const HUB_URL = "https://qairuhub.com";

type Stats = { students: number; joined: number; discussions: number; materials: number };

/** Landing-page numbers. Never let a DB hiccup take the front page down. */
async function landingStats(): Promise<Stats | null> {
  try {
    const [u] = await db
      .select({
        students: sql<number>`count(*)::int`,
        joined: sql<number>`count(${users.claimedAt})::int`,
      })
      .from(users);
    const [p] = await db
      .select({
        discussions: sql<number>`count(*)::int`,
        materials: sql<number>`count(*) filter (where ${discussionPosts.flair} = 'material')::int`,
      })
      .from(discussionPosts)
      .where(sql`${discussionPosts.deleted} = false`);
    return {
      students: u?.students ?? 0,
      joined: u?.joined ?? 0,
      discussions: p?.discussions ?? 0,
      materials: p?.materials ?? 0,
    };
  } catch (err) {
    console.error("landing stats failed", err);
    return null;
  }
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const Mail: FC = () => <a href={`mailto:${ADMIN_EMAIL}`}>{ADMIN_EMAIL}</a>;

/** A guide section: anchor + small "back to top" link. */
const Section: FC<{ id: string; title: string; children: Child }> = ({ id, title, children }) => (
  <div id={id} class="pub-section">
    <Box title={`[ ${title} ]`} alt>
      {children}
      <div class="pub-top">
        <a href="#top">back to top</a>
      </div>
    </Box>
  </div>
);

/** "Register with your email…" wording that matches whether email codes are on. */
const JoinSentence: FC = () =>
  emailEnabled() ? (
    <>
      <b>Register</b> with your <code>@qairu.edu.kz</code> email — we'll send a 6-digit code to
      that inbox to prove it's you — then choose a password.
    </>
  ) : (
    <>
      <b>Register</b> with your <code>@qairu.edu.kz</code> email — your name is already on the
      list, you just activate it with a password.
    </>
  );

/** Signup-protection bullets for the guide and the terms, matching what is switched on. */
const SignupProtection: FC = () => (
  <>
    {turnstileEnabled() ? (
      <li>
        <b>Anti-bot and rate limits.</b> Signup and login use a Cloudflare check, and posting,
        messaging and uploads are rate limited so nobody can flood the place.
      </li>
    ) : (
      <li>
        <b>Rate limits.</b> Signups are limited to the official student list, and signup,
        login, posting, messaging and uploads are rate limited so nobody can flood the place.
      </li>
    )}
    {emailEnabled() ? (
      <li>
        <b>Email verification.</b> Activating an account or resetting a password needs a
        6-digit code sent to that student's <code>@qairu.edu.kz</code> inbox, so nobody can
        take over someone else's account just by knowing their email.
      </li>
    ) : null}
  </>
);

const HouseRules: FC = () => (
  <ul class="bullets">
    <li>
      <b>Be kind.</b> Everyone here is a classmate. Disagree with ideas, not people.
    </li>
    <li>
      <b>Be yourself.</b> Accounts belong to real students on the list — no fake or shared
      accounts.
    </li>
    <li>
      <b>No harassment.</b> No bullying, threats, hate, or posting someone's private info.
    </li>
    <li>
      <b>No spam.</b> No ads, chain messages, or rep farming.
    </li>
    <li>
      <b>No exam answers during exams.</b> Help people learn; don't help them cheat.
    </li>
    <li>
      <b>Only share materials you have the right to share.</b> Your own notes are great;
      paid textbooks and leaked tests are not.
    </li>
  </ul>
);

/* ------------------------------------------------------------------ landing */

publicRoutes.get("/", async (c) => {
  const user = c.get("user");
  if (user) return c.redirect("/home");
  const stats = await landingStats();
  return c.html(
    <Layout title="Welcome" user={null} banner="Welcome to theqairubook!">
      <div class="pub-hero">
        <b>theqairubook</b> — a calm little network just for QAIRU students. No feed. No
        ads. Just people and conversations.
      </div>
      <table class="layout-table pub-cols">
        <tr>
          <td class="pub-main">
            <Box title="[ Welcome to theqairubook ]" alt>
              <p>
                theqairubook is an online directory and discussion board for students of{" "}
                <b>Qazaq AI Research University (QAIRU)</b>, built so we have one quiet place
                of our own to ask, help, share and find each other — without the doomscroll.
              </p>
            </Box>

            <Box title="[ What you can do ]" alt>
              <ul class="bullets">
                <li>
                  Ask for <b>homework help</b> and mark the answer that actually helped
                </li>
                <li>
                  Talk <b>code</b>, projects, hackathons, internships and events on the boards
                </li>
                <li>
                  Share <b>study materials</b> — notes, photos of the whiteboard, PDFs
                </li>
                <li>Save posts to find them again before the exam</li>
                <li>Fill in and decorate your profile: headline, clubs, links, photo</li>
                <li>Find classmates, add friends, look up friends of friends</li>
                <li>Chat privately, poke people, and earn a bit of rep</li>
              </ul>
            </Box>

            <Box title="[ How to join ]" alt>
              <ol class="pub-steps">
                <li>
                  <JoinSentence />
                </li>
                <li>
                  <b>Fill in your profile</b> so classmates recognise you.
                </li>
                <li>
                  <b>Find classmates</b>, join a discussion, share something useful.
                </li>
              </ol>
              <div class="btn-row">
                <a class="btn" href="/register">
                  Register
                </a>
                <a class="btn btn-gray" href="/login">
                  Login
                </a>
              </div>
              <p class="meta">
                Only students on the official QAIRU student list can join. New here?{" "}
                <a href="/guide">Read how it works</a>.
              </p>
            </Box>
          </td>
          <td class="pub-side">
            <Box title="[ Right now ]">
              {stats ? (
                <>
                  <div class="pub-stat">
                    <span class="pub-num">{stats.joined}</span>
                    {stats.students > 0 ? (
                      <>
                        {" "}
                        of <span class="pub-num">{stats.students}</span>
                      </>
                    ) : null}{" "}
                    {plural(stats.students, "student has", "students have")} joined
                  </div>
                  <div class="pub-stat">
                    <span class="pub-num">{stats.discussions}</span>{" "}
                    {plural(stats.discussions, "discussion", "discussions")}
                  </div>
                  <div class="pub-stat">
                    <span class="pub-num">{stats.materials}</span>{" "}
                    {plural(stats.materials, "material", "materials")} shared
                  </div>
                  {stats.joined === 0 ? (
                    <p class="meta">Brand new. You could be the first one in.</p>
                  ) : stats.discussions === 0 ? (
                    <p class="meta">The boards are empty — start the first thread.</p>
                  ) : null}
                </>
              ) : (
                <p class="meta">Stats are taking a nap. Try again in a minute.</p>
              )}
            </Box>

            <Box title="[ Why 2004? ]">
              <p>
                No feed, no algorithm, no infinite scroll — just people and conversations.
                Nothing disappears: what you share stays saved and searchable.
              </p>
            </Box>

            <Box title="[ Part of QairuHub ]">
              <p>
                theqairubook is one piece of <a href={HUB_URL}>QairuHub</a>, a small ecosystem
                of tools for QAIRU students, made with care by {ADMIN_NAME}.
              </p>
              <p class="meta">
                <a href="/about">The story</a> · <a href={REPO_URL}>open source</a>
              </p>
            </Box>

            <Box title="[ Коротко по-русски ]">
              <p lang="ru">
                theqairubook — спокойная студенческая сеть только для студентов QAIRU: обсуждения,
                учебные материалы, профили и личные сообщения, без ленты и рекламы.
                Присоединиться могут только студенты из официального списка — ваш аккаунт уже
                {emailEnabled() ? (
                  <>
                    создан, просто зарегистрируйтесь с почтой <code>@qairu.edu.kz</code> — мы
                    пришлём код на эту почту — и придумайте пароль.
                  </>
                ) : (
                  <>
                    создан, просто зарегистрируйтесь с почтой <code>@qairu.edu.kz</code> и
                    придумайте пароль.
                  </>
                )}
              </p>
            </Box>
          </td>
        </tr>
      </table>
    </Layout>
  );
});

/* -------------------------------------------------------------------- guide */

const GUIDE_TOC: [string, string][] = [
  ["getting-started", "Getting started"],
  ["discussions", "Discussions"],
  ["attachments", "Attachments & limits"],
  ["rep", "Rep"],
  ["friends", "Friends & invites"],
  ["messages", "Messages"],
  ["privacy", "Privacy & safety"],
  ["rules", "House rules"],
];

publicRoutes.get("/guide", async (c) => {
  const user = c.get("user");
  let boardRows: { slug: string; name: string; description: string }[] = [];
  try {
    boardRows = await db
      .select({ slug: boards.slug, name: boards.name, description: boards.description })
      .from(boards)
      .orderBy(asc(boards.id));
  } catch (err) {
    console.error("guide boards failed", err);
  }

  return c.html(
    <Layout title="How it works" user={user} banner="How theqairubook works">
      <div id="top" class="pub-intro">
        Everything you need to know, on one page. Five minutes, tops.
      </div>
      <Box title="[ On this page ]">
        <ol class="pub-toc">
          {GUIDE_TOC.map(([id, label]) => (
            <li>
              <a href={`#${id}`}>{label}</a>
            </li>
          ))}
        </ol>
      </Box>

      <Section id="getting-started" title="Getting started">
        <p>
          theqairubook is a closed network: only the students on the official QAIRU student
          list can join. Every one of them already has an account waiting.
        </p>
        <ol class="pub-steps">
          <li>
            Go to <a href="/register">register</a>. <JoinSentence /> That activates your
            pre-created account.
          </li>
          <li>
            <a href="/edit-profile">Edit your profile</a>: add a photo, a headline, what you're
            looking for (study buddy, teammates, a co-founder…), your clubs and links.
          </li>
          <li>
            Look around: <a href="/search">search</a> for classmates, open{" "}
            <a href="/d">discussions</a>, say hi.
          </li>
        </ol>
      </Section>

      <Section id="discussions" title="Discussions">
        <p>
          Discussions live on <b>boards</b>. Pick the board that fits, write a title, add some
          text, a link or files.
        </p>
        {boardRows.length ? (
          <table class="pub-table">
            <tr>
              <th>Board</th>
              <th>What goes there</th>
            </tr>
            {boardRows.map((b) => (
              <tr>
                <td class="pub-nowrap">
                  {user ? <a href={`/d/${b.slug}`}>{b.name}</a> : <b>{b.name}</b>}
                </td>
                <td>{b.description}</td>
              </tr>
            ))}
          </table>
        ) : (
          <p class="meta">The boards list will show up here once the site is set up.</p>
        )}
        <p>
          <b>Flairs.</b> Every post has one:
        </p>
        <ul class="bullets">
          <li>
            <span class="flair flair-discussion">Discussion</span> — talk, opinions, news.
          </li>
          <li>
            <span class="flair flair-question">Question</span> — you need an answer. When one
            helps, mark it as <b>the answer</b>: the post gets a{" "}
            <span class="flair flair-solved">✓ solved</span> tag and the helper gets{" "}
            <b>+{REP.acceptedAnswer} rep</b>. You can change your mind later.
          </li>
          <li>
            <span class="flair flair-material">Material</span> — notes, slides, PDFs, useful
            links.
          </li>
        </ul>
        <p>
          <b>Voting.</b> ▲ things that are helpful or good, ▼ things that are off-topic or wrong.
          Votes move the author's rep by {REP.vote}. You can't vote on your own stuff.
        </p>
        <p>
          <b>Saving.</b> Hit "save" on any post and find it later under{" "}
          <a href="/d/saved">Saved Posts</a>. Nobody else sees what you saved.
        </p>
        <p>
          <b>Search.</b> Nothing disappears, so old threads stay findable — search before you
          ask, someone may have solved it last semester.
        </p>
        <p>
          <b>New boards.</b> Once you have <b>{REP.createBoard} rep</b> you can create a board of
          your own for a course, club or topic that doesn't have a home yet.
        </p>
      </Section>

      <Section id="attachments" title="Attachments & limits">
        <p>
          You can attach images and PDFs to posts and comments. Storage is shared and not
          infinite, so there are limits:
        </p>
        <table class="pub-table">
          <tr>
            <td>Images (JPG, PNG, GIF, WEBP)</td>
            <td>
              up to <b>{formatBytes(MEDIA_LIMITS.imageBytes)}</b> each
            </td>
          </tr>
          <tr>
            <td>PDFs</td>
            <td>
              up to <b>{formatBytes(MEDIA_LIMITS.pdfBytes)}</b> each
            </td>
          </tr>
          <tr>
            <td>Files per post / per comment</td>
            <td>
              <b>{MEDIA_LIMITS.filesPerPost}</b> / <b>{MEDIA_LIMITS.filesPerComment}</b>
            </td>
          </tr>
          <tr>
            <td>Your total storage</td>
            <td>
              <b>{formatBytes(MEDIA_LIMITS.userQuotaBytes)}</b>
            </td>
          </tr>
          <tr>
            <td>Uploads per day</td>
            <td>
              <b>{MEDIA_LIMITS.dailyUploads}</b> files
            </td>
          </tr>
        </table>
        <p class="meta">
          Files are checked by their actual contents, not just the extension. Attachments are
          only visible to logged-in members. Deleting a post or comment removes its files and
          frees your space. You can see and delete your files one by one under{" "}
          <a href="/account#uploads">My Account → My uploads</a>. Deleted files free storage,
          but they still count towards the daily upload limit.
        </p>
      </Section>

      <Section id="rep" title="Rep">
        <p>
          Rep is a small number next to your name that says "this person helps out". It is not
          a currency and it doesn't unlock much — it's just nice.
        </p>
        <table class="pub-table">
          <tr>
            <th>You get</th>
            <th>When</th>
          </tr>
          <tr>
            <td class="pub-nowrap">
              <b>+{REP.vote}</b> / <b>−{REP.vote}</b>
            </td>
            <td>someone up- or downvotes your wall post, discussion post or comment</td>
          </tr>
          <tr>
            <td class="pub-nowrap">
              <b>+{REP.replyReceived}</b>
            </td>
            <td>someone new replies to your post or comment</td>
          </tr>
          <tr>
            <td class="pub-nowrap">
              <b>+{REP.acceptedAnswer}</b>
            </td>
            <td>your comment is marked as the answer to a question</td>
          </tr>
          <tr>
            <td class="pub-nowrap">
              <b>+{REP.referral}</b>
            </td>
            <td>
              a classmate activates their account through your invite link (you also become
              friends automatically; counts for up to {REP.referralDailyCap} people a day)
            </td>
          </tr>
          <tr>
            <td class="pub-nowrap">
              <b>{REP.createBoard}</b> needed
            </td>
            <td>to create a new discussion board</td>
          </tr>
        </table>
        <p class="meta">
          The top of the table lives at <a href="/rep">rep</a>. Only joined members show up on
          the leaderboard.
        </p>
      </Section>

      <Section id="friends" title="Friends & invites">
        <p>
          Every student on the list has a pre-created account. Until they activate it, their
          name shows a <NotJoined /> badge.
        </p>
        <ul class="bullets">
          <li>
            You can send a <b>friend request</b> to someone who hasn't joined yet — it waits
            for them and they'll see it when they sign up.
          </li>
          <li>
            You can copy a <b>personal invite link</b> from their profile or the{" "}
            <a href="/invite">invite</a> page and send it on Telegram or wherever you talk.
          </li>
          <li>
            Invite links don't let outsiders in: the person still needs their listed{" "}
            <code>@qairu.edu.kz</code> email. When they join through your link you become
            friends and you get +{REP.referral} rep.
          </li>
          <li>
            People who haven't joined can't get messages, pokes or wall posts yet — there's
            nobody there to read them.
          </li>
        </ul>
        <p>
          Once you have friends you'll also see <b>friends of friends</b> — a good way to find
          people from other groups.
        </p>
      </Section>

      <Section id="messages" title="Messages">
        <p>
          <a href="/messages">Messages</a> are private one-to-one chats with other members. Only
          you and the other person can read them. Pokes are the lazy version: a simple "hey,
          I'm here". What a poke means is up to you.
        </p>
        <p class="meta">
          Please don't use messages for spam or anything you'd be embarrassed to see
          screenshotted.
        </p>
      </Section>

      <Section id="privacy" title="Privacy & safety">
        <ul class="bullets">
          <li>
            <b>Members only.</b> Profiles, posts and files are only visible to logged-in
            QAIRU students. Search engines and outsiders see the public pages, nothing more.
          </li>
          <li>
            <b>Your settings.</b> Under <a href="/privacy">Privacy</a> you can limit who sees
            your profile (for example, friends only).
          </li>
          <SignupProtection />
          <li>
            <b>Moderation.</b> Admins can remove posts, comments and wall posts, and suspend
            accounts that break the <a href="#rules">house rules</a>.
          </li>
          <li>
            <b>Passwords</b> are hashed with scrypt — nobody, including the admin, can read
            them.
          </li>
          <li>
            <b>Something wrong?</b> Harassment, a bug, a fake account, content that shouldn't
            be here — tell the admin, {ADMIN_NAME}: <Mail />.
          </li>
        </ul>
      </Section>

      <Section id="rules" title="House rules">
        <HouseRules />
        <p class="meta">
          The full version is in the <a href="/terms">terms</a>.
        </p>
      </Section>
    </Layout>
  );
});

/* -------------------------------------------------------------------- about */

publicRoutes.get("/about", (c) => {
  return c.html(
    <Layout title="About" user={c.get("user")} banner="About theqairubook">
      <Box title="[ The story ]" alt>
        <p>
          In 2004 a college directory with a blue bar and tiny Tahoma text let students look
          each other up, see who was in their classes, and poke people for no reason.
          theqairubook is a homage to that — rebuilt for{" "}
          <b>Qazaq AI Research University (QAIRU)</b> in Astana.
        </p>
        <p>
          It started just for fun. It stayed because we wanted something real: an internal
          channel only for students, where you can ask for help with homework, argue about
          code, pass around lecture notes, and find the person from your group whose name you
          forgot.
        </p>
      </Box>

      <Box title="[ The low-dopamine idea ]" alt>
        <ul class="bullets">
          <li>No algorithmic feed — you go where you want to go.</li>
          <li>No infinite scroll and no ads.</li>
          <li>Nothing disappears — what's shared stays saved and searchable.</li>
          <li>No outsiders — just QAIRU students on the official list.</li>
        </ul>
        <p>
          The goal is a place you open because you need something, get it, and close again.
        </p>
      </Box>

      <Box title="[ Who made this ]" alt>
        <p>
          theqairubook is a <a href={HUB_URL}>QairuHub</a> passion project by{" "}
          <b>{ADMIN_NAME}</b>, part of building a small ecosystem of tools for QAIRU students.
          It lives at <b>the.qairuhub.com</b>.
        </p>
        <p>
          It is open source: <a href={REPO_URL}>{REPO_URL.replace("https://", "")}</a>. Found a
          bug or have an idea? Open an issue or send a pull request.
        </p>
      </Box>

      <Box title="[ The fine print ]">
        <p class="meta">
          theqairubook is an independent student project. It is not affiliated with, endorsed
          by, or connected to Meta Platforms, Inc. or Facebook, and it is not an official
          service of Qazaq AI Research University.
        </p>
      </Box>
    </Layout>
  );
});

/* ---------------------------------------------------------------------- faq */

/** Built per request: some answers depend on whether email codes are switched on. */
const faqItems = (): [string, string, Child][] => [
  [
    "who",
    "Who can join?",
    <>
      Only students on the official QAIRU student list, using their{" "}
      <code>@qairu.edu.kz</code> email. Invite links don't change that — they just make it
      easy to find the way in.
    </>,
  ],
  [
    "not-listed",
    "My @qairu.edu.kz email says it's not on the list — what now?",
    <>
      First double-check the spelling: addresses look like <code>first.last@qairu.edu.kz</code>,
      and transliterated names are easy to mistype. Still stuck? Write to the admin,{" "}
      {ADMIN_NAME}, at <Mail /> from your university email and we'll sort it out.
    </>,
  ],
  [
    "forgot-password",
    "I forgot my password",
    emailEnabled() ? (
      <>
        Use <a href="/forgot">Forgot your password?</a> on the login page. We'll email a 6-digit
        code to your <code>@qairu.edu.kz</code> inbox; enter it and choose a new password.
      </>
    ) : (
      <>
        Ask the admin, {ADMIN_NAME}, at <Mail /> from your university email. They can send you a
        personal link to set a new password.
      </>
    ),
  ],
  [
    "someone-else",
    "Someone else activated my account",
    <>
      Contact the admin, {ADMIN_NAME}, at <Mail /> right away. They will reset and lock the
      account and send you a personal activation link that only you receive.
    </>,
  ],
  [
    "not-joined",
    'What does "not joined yet" mean?',
    <>
      Every student on the list has a pre-created account. <NotJoined /> means that person
      hasn't activated theirs yet. You can still send them a friend request (it waits for
      them) or copy an invite link to send them — but you can't message, poke or write on
      their wall until they join.
    </>,
  ],
  [
    "rep",
    "What is rep?",
    <>
      A small karma score. You get +{REP.vote} when someone upvotes you, +{REP.replyReceived}{" "}
      when someone replies, +{REP.acceptedAnswer} when your answer is accepted, and +
      {REP.referral} when a classmate joins through your invite link. At {REP.createBoard} rep
      you can create your own board. Details in the <a href="/guide#rep">guide</a>.
    </>,
  ],
  [
    "uploads",
    "What can I upload and how much?",
    <>
      Images (JPG, PNG, GIF, WEBP) up to {formatBytes(MEDIA_LIMITS.imageBytes)} and PDFs up to{" "}
      {formatBytes(MEDIA_LIMITS.pdfBytes)}; up to {MEDIA_LIMITS.filesPerPost} files per post and{" "}
      {MEDIA_LIMITS.filesPerComment} per comment; {MEDIA_LIMITS.dailyUploads} uploads a day and{" "}
      {formatBytes(MEDIA_LIMITS.userQuotaBytes)} of storage in total. Delete old files to free
      space (deleted files still count towards the daily limit).
    </>,
  ],
  [
    "delete-attachment",
    "How do I delete an attachment?",
    <>
      Go to <a href="/account#uploads">My Account → My uploads</a>: it lists every file you've
      uploaded, each with a delete button. Deleting frees the storage, but the upload still
      counts towards today's limit.
    </>,
  ],
  [
    "moderation",
    "Who moderates this place?",
    <>
      Admins can remove posts, comments and wall posts, and suspend accounts that break the{" "}
      <a href="/terms">rules</a>. Suspended accounts can't log in. See something that
      shouldn't be here? Tell the admin at <Mail />.
    </>,
  ],
  [
    "who-sees",
    "Who can see my profile?",
    <>
      Only logged-in members — never the public internet. Under Privacy you can narrow it
      further, for example to friends only.
    </>,
  ],
  [
    "official",
    "Is this official?",
    <>
      No. It's a student passion project (part of <a href={HUB_URL}>QairuHub</a>), not an
      official QAIRU service, and it has nothing to do with Meta or Facebook. The official
      university site is qairu.edu.kz.
    </>,
  ],
  [
    "delete",
    "How do I delete my account or content?",
    <>
      You can delete your own posts, comments and files yourself at any time. To remove your
      whole account, email the admin at <Mail /> and it will be taken care of.
    </>,
  ],
  [
    "2004",
    "Why does it look like 2004?",
    <>
      Because 2004 was calmer. No feed, no algorithm, no autoplay — just people and
      conversations. Also, Tahoma 11px is a vibe.
    </>,
  ],
];

publicRoutes.get("/faq", (c) => {
  const FAQ = faqItems();
  return c.html(
    <Layout title="FAQ" user={c.get("user")} banner="Frequently Asked Questions">
      <Box title="[ Questions ]">
        <ol class="pub-toc">
          {FAQ.map(([id, q]) => (
            <li>
              <a href={`#${id}`}>{q}</a>
            </li>
          ))}
        </ol>
      </Box>
      <Box title="[ FAQ ]" alt>
        {FAQ.map(([id, q, a], i) => (
          <>
            {i > 0 ? <hr class="thin" /> : null}
            <div id={id} class="pub-qa">
              <b>{q}</b>
              <p>{a}</p>
            </div>
          </>
        ))}
      </Box>
      <p class="meta">
        Didn't find it? Read <a href="/guide">how it works</a> or ask the admin at <Mail />.
      </p>
    </Layout>
  );
});

/* -------------------------------------------------------------------- terms */

publicRoutes.get("/terms", (c) => {
  return c.html(
    <Layout title="Terms" user={c.get("user")} banner="Terms & Rules">
      <Box title="[ In short ]">
        <p>
          theqairubook is a small, non-commercial student project. By using it you agree to
          the rules below. Be decent, and we'll get along fine.
        </p>
      </Box>

      <Box title="[ House rules ]" alt>
        <HouseRules />
      </Box>

      <Box title="[ Your content & uploads ]" alt>
        <ul class="bullets">
          <li>
            You are responsible for what you post, send and upload. Only upload things you
            made yourself or have the right to share.
          </li>
          <li>
            Don't upload anything illegal, anyone's private documents, or photos of people who
            didn't agree to it.
          </li>
          <li>
            Uploads are limited (images up to {formatBytes(MEDIA_LIMITS.imageBytes)}, PDFs up
            to {formatBytes(MEDIA_LIMITS.pdfBytes)},{" "}
            {formatBytes(MEDIA_LIMITS.userQuotaBytes)} per person) and only visible to
            logged-in members.
          </li>
          <li>You can delete your own posts, comments and files whenever you want.</li>
        </ul>
      </Box>

      <Box title="[ Moderation ]" alt>
        <p>
          Admins may remove posts, comments, wall posts and files that break these rules, and
          may suspend accounts that look fake or abusive (a suspended account can't log in). We'll try to be fair and to explain, but on
          a small volunteer-run site the admin has the final word.
        </p>
      </Box>

      <Box title="[ Your data ]" alt>
        <ul class="bullets">
          <li>
            Data is stored in a Postgres database and a storage volume on Railway, in the EU.
          </li>
          <li>Passwords are hashed with scrypt; nobody can read them.</li>
          <SignupProtection />
          <li>No ads, no tracking for ads, and your data is never sold.</li>
          <li>
            Accounts are pre-created from the official QAIRU student list (name and university
            email) so classmates can find each other.
          </li>
          <li>Want your account removed? Ask the admin (below).</li>
        </ul>
      </Box>

      <Box title="[ Contact ]">
        <p>
          Questions, reports or removal requests: {ADMIN_NAME}, <Mail />.
        </p>
        <p class="meta">
          theqairubook is not affiliated with Meta Platforms, Inc. or Facebook and is not an
          official service of Qazaq AI Research University. The service is provided as is.
        </p>
      </Box>
    </Layout>
  );
});
