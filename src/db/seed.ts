import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "./index.js";
import {
  users,
  friendships,
  wallPosts,
  boardEvents,
  pokes,
  messages,
} from "./schema.js";
import { hashPassword } from "../auth/password.js";

const SEED_PASSWORD = "qairu123";

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

  console.log(`Seeded ${created.length} people.`);
  console.log(`Password for all seed accounts: ${SEED_PASSWORD}`);
  console.log("Example login: aigerim.nurlanova@qairu.edu.kz / qairu123");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
