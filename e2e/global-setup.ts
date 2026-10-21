import { E2E_ADMIN, E2E_USER } from "./fixtures/users";

// Fresh accounts for every run, so a task left behind by a run that died
// halfway never changes what the next one sees. Deleting an account deletes
// its tasks, settings and receipts with it.
export default async function globalSetup() {
  const { prepareTestDatabase, ensureUser } = require("../test/support/test-db.cjs");
  prepareTestDatabase();
  // Only after the guard: requiring the server's db module starts index builds and the
  // first-run seed against whatever MONGODB_DB names.
  const db = require("../apps/server/src/db");
  try {
    for (const account of [E2E_USER, E2E_ADMIN]) {
      await ensureUser(db, account.username, account.role, account.password);
    }
  } finally {
    await db.close();
  }
}
