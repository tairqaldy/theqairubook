import "dotenv/config";
// Columns are `timestamp without time zone` holding UTC; postgres-js parses
// them as local time, so pin the process to UTC for correct "x ago" math.
process.env.TZ = "UTC";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const url =
  process.env.DATABASE_URL ??
  "postgres://qairu:qairu@localhost:5433/theqairubook";

// onnotice: the boot migration's IF NOT EXISTS statements emit a NOTICE each.
const client = postgres(url, { max: 10, onnotice: () => {} });
export const db = drizzle(client, { schema });
export { schema };
