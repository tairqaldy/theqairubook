import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { db } from "./index.js";
import {
  users,
  friendships,
  wallPosts,
  boardEvents,
  pokes,
  messages,
  boards,
  discussionPosts,
  discussionComments,
} from "./schema.js";
import { hashPassword } from "../auth/password.js";
import { ensureSchema } from "./migrate.js";
import { castVote, awardReply, awardReferral } from "../lib/rep.js";

const SEED_PASSWORD = "qairu123";

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

// Discussions, threaded comments, votes, wall replies, chats and a referral —
// all through the real rep functions so scores and rep stay consistent.
async function seedCommunity(ids: number[]) {
  const [aigerim, dias, madina, yerasyl, sara, nursultan, prof, zarina] = ids;
  if (!zarina) return;
  const [already] = await db.select().from(discussionPosts).limit(1);
  if (already) return;

  const boardRows = await db.select().from(boards);
  const board = (slug: string) => boardRows.find((b) => b.slug === slug)!.id;

  const posts = [
    {
      board: "courses",
      author: madina,
      h: 20,
      title: "Linear Algebra midterm study group — Thursday 18:00 at B2.2?",
      body: "Going through eigenvalues + SVD past papers. Bring snacks, I'll bring the whiteboard markers.",
    },
    {
      board: "events",
      author: aigerim,
      h: 9,
      title: "AI Fridays this week: build an agent in 90 minutes 🤖",
      body: "Teams of 2-3. Best demo gets pizza and eternal glory. Sign up in the comments.",
    },
    {
      board: "ask",
      author: sara,
      h: 30,
      title: "Which is harder: Discrete Math or Linear Algebra?",
      body: "Picking electives for next semester and everyone gives me a different answer.",
    },
    {
      board: "housing",
      author: yerasyl,
      h: 52,
      title: "Looking for a roommate near EXPO for spring",
      body: "2-room flat, 10 min walk to campus. Quiet, cooks plov on weekends.",
    },
    {
      board: "memes",
      author: dias,
      h: 4,
      title: "When the model finally converges at 3am and you have class at 9",
      body: "",
    },
    {
      board: "marketplace",
      author: nursultan,
      h: 70,
      title: "Selling: Deep Learning (Goodfellow) hardcover, barely used",
      body: "8000₸, can meet at the library.",
    },
    {
      board: "general",
      author: prof,
      h: 14,
      title: "Office hours moved to Wednesday 15:00 this week",
      body: "Room 3.14 as usual. Bring your project questions.",
    },
  ];

  const postIds: Record<string, number> = {};
  for (const p of posts) {
    const [row] = await db
      .insert(discussionPosts)
      .values({
        boardId: board(p.board),
        authorUserId: p.author,
        title: p.title,
        body: p.body,
        createdAt: hoursAgo(p.h),
      })
      .returning();
    postIds[p.board] = row.id;
    await db.insert(boardEvents).values({
      actorUserId: p.author,
      kind: "discussion",
      detail: JSON.stringify({ postId: row.id, slug: p.board, title: p.title }),
      createdAt: hoursAgo(p.h),
    });
  }

  async function comment(
    post: string,
    author: number,
    body: string,
    h: number,
    parent?: { id: number; authorUserId: number }
  ) {
    const postId = postIds[post];
    const [row] = await db
      .insert(discussionComments)
      .values({ postId, parentId: parent?.id ?? null, authorUserId: author, body, createdAt: hoursAgo(h) })
      .returning();
    await db
      .update(discussionPosts)
      .set({ commentCount: sql`${discussionPosts.commentCount} + 1` })
      .where(eq(discussionPosts.id, postId));
    const [op] = await db.select().from(discussionPosts).where(eq(discussionPosts.id, postId));
    if (parent) await awardReply(parent.authorUserId, author, "comment", parent.id);
    else await awardReply(op.authorUserId, author, "post", postId);
    return row;
  }

  const e1 = await comment("events", dias, "Me + Yerasyl are in. Can we use any framework?", 8);
  const e2 = await comment("events", aigerim, "Anything goes, as long as it runs live on stage 😄", 7, e1);
  await comment("events", yerasyl, "Bringing my Raspberry Pi. No promises it survives.", 6, e2);
  const e3 = await comment("events", madina, "Is there a speech track? I'd love to demo a voice agent.", 5);
  await comment("events", aigerim, "Yes! Speech demos welcome.", 5, e3);
  await comment("events", nursultan, "Count me in, looking for a teammate who knows CV.", 3);

  const c1 = await comment("courses", sara, "I'm in. Can we also cover determinants?", 19);
  await comment("courses", madina, "Sure, first 30 minutes on determinants.", 18, c1);
  await comment("courses", dias, "Will there be recordings for people in the late lab?", 17);

  const a1 = await comment("ask", nursultan, "Discrete is harder to start, LinAlg is harder to finish.", 28);
  await comment("ask", sara, "That is somehow the most helpful answer so far", 27, a1);
  await comment("ask", prof, "Take Discrete first — proofs make Linear Algebra much easier.", 25);

  await comment("memes", madina, "loss.backward() and so did my sleep schedule", 3);
  await comment("general", zarina, "Registrar note: add/drop deadline is Friday too.", 12);

  const allPosts = await db.select().from(discussionPosts);
  const allComments = await db.select().from(discussionComments);
  const voters = [aigerim, dias, madina, yerasyl, sara, nursultan, prof, zarina];
  // Deterministic pseudo-random votes, weighted toward upvotes.
  let seed = 7;
  const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  for (const p of allPosts) {
    for (const v of voters) {
      if (v !== p.authorUserId && rand() < 0.8) await castVote(v, "post", p.id, rand() < 0.9 ? 1 : -1);
    }
  }
  for (const cm of allComments) {
    for (const v of voters) {
      if (v !== cm.authorUserId && rand() < 0.45) await castVote(v, "comment", cm.id, rand() < 0.88 ? 1 : -1);
    }
  }

  // Wall replies + votes
  const walls = await db.select().from(wallPosts);
  const fridays = walls.find((w) => w.body.startsWith("See you at AI Fridays"));
  if (fridays) {
    const [r] = await db
      .insert(wallPosts)
      .values({
        profileUserId: fridays.profileUserId,
        authorUserId: aigerim,
        parentId: fridays.id,
        body: "Obviously! Save me a seat near the projector.",
      })
      .returning();
    await awardReply(fridays.authorUserId, aigerim, "wall", fridays.id);
    await db.insert(wallPosts).values({
      profileUserId: fridays.profileUserId,
      authorUserId: sara,
      parentId: r.id,
      body: "Can I join you two?",
    });
    await awardReply(aigerim, sara, "wall", r.id);
    for (const v of [madina, sara, yerasyl]) await castVote(v, "wall", fridays.id, 1);
    for (const v of [dias, madina]) await castVote(v, "wall", r.id, 1);
  }

  // A chat between Aigerim and Madina
  const chat: [number, number, string, number][] = [
    [madina, aigerim, "hey! are you coming to the LinAlg study group?", 26],
    [aigerim, madina, "yes!! can I bring Dias?", 25.9],
    [madina, aigerim, "of course, the more the merrier", 25.8],
    [aigerim, madina, "also do you have the SVD notes from Tuesday?", 2],
    [madina, aigerim, "sending them now 📎 check the course board too", 1.9],
  ];
  for (const [from, to, body, h] of chat) {
    await db.insert(messages).values({ fromUserId: from, toUserId: to, body, read: h > 1.95, createdAt: hoursAgo(h) });
  }

  // Sara joined through Aigerim's invite link
  await db.update(users).set({ referredByUserId: aigerim }).where(eq(users.id, sara));
  await awardReferral(aigerim, sara);
  await db.insert(boardEvents).values({
    actorUserId: sara,
    targetUserId: aigerim,
    kind: "referral",
    detail: "+25 rep",
    createdAt: hoursAgo(40),
  });
}

const people = [
  {
    name: "Aigerim Nurlanova",
    email: "aigerim.nurlanova@qairu.edu.kz",
    sex: "Female",
    status: "Student",
    classYear: "2029",
    residence: "EXPO B2.2 Cowork",
    birthday: "May 12, 2006",
    hometown: "Almaty",
    highSchool: "NIS Almaty",
    courses: "Intro to Programming, Linear Algebra, AI Systems",
    interests: "agents, hackathons, coffee",
    music: "The Weeknd, Dimash",
    books: "Hackers & Painters",
    aboutMe: "Building things at QAIRU. Fake seed account for demos.",
  },
  {
    name: "Dias Bekmuratov",
    email: "dias.bekmuratov@qairu.edu.kz",
    sex: "Male",
    status: "Student",
    classYear: "2029",
    residence: "Student Housing Block A",
    birthday: "January 3, 2005",
    hometown: "Astana",
    highSchool: "RFMSH Astana",
    courses: "Intro to Programming, Discrete Math, AI Systems",
    interests: "robotics, football",
    music: "Kanye, Mozart",
    books: "Surely You're Joking, Mr. Feynman",
    aboutMe: "Seed classmate. Not a real person.",
  },
  {
    name: "Madina Satpayeva",
    email: "madina.satpayeva@qairu.edu.kz",
    sex: "Female",
    status: "Student",
    classYear: "2028",
    residence: "EXPO B2.2 Cowork",
    birthday: "August 21, 2004",
    hometown: "Shymkent",
    highSchool: "Bilim-Innovation Shymkent",
    courses: "Linear Algebra, Machine Learning, Speech AI",
    interests: "speech AI, startups",
    music: "Lana Del Rey",
    books: "Zero to One",
    aboutMe: "Seed profile for theqairubook demos.",
  },
  {
    name: "Yerasyl Omarov",
    email: "yerasyl.omarov@qairu.edu.kz",
    sex: "Male",
    status: "Student",
    classYear: "2028",
    residence: "Student Housing Block B",
    birthday: "November 9, 2004",
    hometown: "Karaganda",
    highSchool: "Nazarbayev Intellectual School",
    courses: "AI Systems, Computer Vision, Intro to Programming",
    interests: "CV, photography",
    music: "Radiohead",
    books: "Gödel, Escher, Bach",
    aboutMe: "Fake QAIRU student for directory testing.",
  },
  {
    name: "Sara Iskakova",
    email: "sara.iskakova@qairu.edu.kz",
    sex: "Female",
    status: "Student",
    classYear: "2029",
    residence: "EXPO B2.2 Cowork",
    birthday: "February 28, 2006",
    hometown: "Aktau",
    highSchool: "Daryn Aktau",
    courses: "Discrete Math, Linear Algebra, Intro to Programming",
    interests: "math olympiads, tea",
    music: "classical playlist",
    books: "How to Prove It",
    aboutMe: "Seed account. Hello from the Caspian.",
  },
  {
    name: "Nursultan Abiyev",
    email: "nursultan.abiyev@qairu.edu.kz",
    sex: "Male",
    status: "Student",
    classYear: "2027",
    residence: "Off-campus Astana",
    birthday: "July 4, 2003",
    hometown: "Kokshetau",
    highSchool: "Lyceum 1",
    courses: "Machine Learning, Speech AI, Computer Vision",
    interests: "ML research, Alem cloud",
    music: "Travis Scott",
    books: "Attention Is All You Need (paper)",
    aboutMe: "Third-year seed profile for demos only.",
  },
  {
    name: "Prof. Anuar Suleimenov",
    email: "anuar.suleimenov@qairu.edu.kz",
    sex: "Male",
    status: "Faculty",
    classYear: "",
    residence: "Faculty Wing",
    birthday: "",
    hometown: "Astana",
    highSchool: "",
    courses: "AI Systems, Machine Learning",
    interests: "teaching, applied AI",
    music: "",
    books: "",
    aboutMe: "Seed faculty account — not a real professor.",
  },
  {
    name: "Zarina Temirbek",
    email: "zarina.temirbek@qairu.edu.kz",
    sex: "Female",
    status: "Staff",
    classYear: "",
    residence: "Registrar Office",
    birthday: "",
    hometown: "Astana",
    highSchool: "",
    courses: "",
    interests: "student services",
    music: "",
    books: "",
    aboutMe: "Seed staff account for directory demos.",
  },
];

async function main() {
  console.log("Seeding theqairubook…");
  await ensureSchema();
  const hash = hashPassword(SEED_PASSWORD);
  const created: { id: number; name: string }[] = [];

  for (const p of people) {
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.email, p.email))
      .limit(1);
    if (existing.length) {
      created.push({ id: existing[0].id, name: existing[0].name });
      continue;
    }
    const [u] = await db
      .insert(users)
      .values({
        ...p,
        passwordHash: hash,
        school: "QAIRU",
        privacy: "network",
      })
      .returning();
    created.push({ id: u.id, name: u.name });
    await db.insert(boardEvents).values({
      actorUserId: u.id,
      kind: "joined",
      detail: `${u.name} joined theqairubook`,
    });
  }

  // Friendships among first six students
  const pairs: [number, number][] = [
    [0, 1],
    [0, 2],
    [1, 3],
    [2, 3],
    [0, 4],
    [1, 4],
    [3, 5],
    [2, 5],
  ];
  for (const [a, b] of pairs) {
    const from = created[a];
    const to = created[b];
    if (!from || !to) continue;
    const exists = await db
      .select()
      .from(friendships)
      .where(eq(friendships.fromUserId, from.id))
      .limit(20);
    if (exists.some((f) => f.toUserId === to.id && f.status === "accepted")) {
      continue;
    }
    try {
      await db.insert(friendships).values({
        fromUserId: from.id,
        toUserId: to.id,
        status: "accepted",
      });
      await db.insert(boardEvents).values({
        actorUserId: from.id,
        targetUserId: to.id,
        kind: "friend",
        detail: "became friends",
      });
    } catch {
      // unique constraint — already friends
    }
  }

  // Wall posts
  if (created[0] && created[1]) {
    const existingWall = await db.select().from(wallPosts).limit(1);
    if (!existingWall.length) {
      await db.insert(wallPosts).values([
        {
          profileUserId: created[0].id,
          authorUserId: created[1].id,
          body: "See you at AI Fridays?",
        },
        {
          profileUserId: created[1].id,
          authorUserId: created[0].id,
          body: "Welcome to QAIRU — this wall still works like 2004.",
        },
        {
          profileUserId: created[2].id,
          authorUserId: created[3].id,
          body: "Lab partners for Computer Vision?",
        },
      ]);
      await db.insert(boardEvents).values({
        actorUserId: created[1].id,
        targetUserId: created[0].id,
        kind: "wall",
        detail: "See you at AI Fridays?",
      });
    }
  }

  // A poke
  if (created[3] && created[0]) {
    const existingPoke = await db.select().from(pokes).limit(1);
    if (!existingPoke.length) {
      await db.insert(pokes).values({
        fromUserId: created[3].id,
        toUserId: created[0].id,
      });
    }
  }

  // A message
  if (created[2] && created[0]) {
    const existingMsg = await db.select().from(messages).limit(1);
    if (!existingMsg.length) {
      await db.insert(messages).values({
        fromUserId: created[2].id,
        toUserId: created[0].id,
        subject: "Study group",
        body: "Hey — want to form a study group for Linear Algebra this week?",
      });
    }
  }

  await seedCommunity(created.map((p) => p.id));

  console.log(`Seeded ${created.length} people.`);
  console.log(`Password for all seed accounts: ${SEED_PASSWORD}`);
  console.log("Example login: aigerim.nurlanova@qairu.edu.kz / qairu123");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
