import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const url =
  process.env.DATABASE_URL ??
  "postgres://qairu:qairu@localhost:5433/theqairubook";

const client = postgres(url, { max: 10 });
export const db = drizzle(client, { schema });
export { schema };
