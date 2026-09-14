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
// TimeZone: DEFAULT now() on timestamp columns must write UTC whatever the server's zone.
const client = postgres(url, {
  max: 10,
  onnotice: () => {},
  connection: { TimeZone: "UTC" },
});
export const db = drizzle(client, { schema });
export { schema };
