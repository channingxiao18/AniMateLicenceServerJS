/**
 * D1 database connection factory.
 */

import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(d1: D1Database): Database {
  return drizzle(d1, { schema });
}
