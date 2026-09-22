// Vitest `setupFiles` entry. Runs once per test FILE (Vitest gives each test
// file its own module registry / globals), mirroring what
// `@cloudflare/vitest-pool-workers` used to give us for free: a fresh,
// fully-migrated database before any test in that file runs.
//
// This does NOT reset between individual `it()`/`test()` cases within a
// file -- test files that need that (most of them) already have their own
// local `resetDb()`/`beforeEach` that deletes rows between cases, same as
// before.
import { afterAll, beforeAll } from "vitest";
import { openDatabase, type Database } from "../src/db/sqlite";
import { runMigrations } from "../src/db/migrate";
import { __setTestDatabase } from "./test-env";
import { __resetPresenceForTests } from "../src/presence/status";

let db: Database | null = null;

beforeAll(() => {
  db = openDatabase(":memory:");
  runMigrations(db);
  __setTestDatabase(db);
  __resetPresenceForTests();
});

afterAll(() => {
  db?.close();
  db = null;
});
