import { after } from "node:test";
import { type Db, openDb } from "../src/db.ts";

// Lucid's open pool would keep the test process alive; close every database made here.
const opened: Db[] = [];
after(() => Promise.all(opened.map((db) => db.close())));

export async function testDb(salt = "salt"): Promise<Db> {
  const db = await openDb(":memory:", salt);
  opened.push(db);
  await db.migrate();
  return db;
}
