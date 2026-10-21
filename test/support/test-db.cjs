// The one place the test suites decide which database they are about to write
// to, and refuse when it is not a test database.
//
// Both suites create and delete accounts, tasks and posts. Pointed at a real
// database they would do that to real people, so the guard runs before
// anything requires server/db: requiring it is enough to start index builds
// and the first-run seed against whatever MONGODB_DB names.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const TEST_DATABASE = /_(e2e|test)$/;

// The environment the server will see. `.env.test` comes first and only fills
// what the shell has not set; `.env` then fills the rest (usually just the
// connection string), the same way server/db.js loads it.
function loadTestEnv() {
  const testEnv = path.join(ROOT, ".env.test");
  if (fs.existsSync(testEnv)) process.loadEnvFile(testEnv);
  require("dotenv").config({ path: path.join(ROOT, ".env"), quiet: true });
}

function assertTestDatabase() {
  const name = process.env.MONGODB_DB || "klndr";
  if (!TEST_DATABASE.test(name)) {
    throw new Error(
      `Refusing to run the tests against the "${name}" database: its name must end in _e2e or _test. ` +
        "Copy .env.test.example to .env.test, or set MONGODB_DB.",
    );
  }
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI must be set for the tests (in .env, .env.test or the shell).");
  }
  return name;
}

function prepareTestDatabase() {
  loadTestEnv();
  return assertTestDatabase();
}

// An account with a known password, made the way an admin would make one and
// then released from its temporary password. Recreated on every run, so a
// previous run that died halfway leaves nothing that changes this one.
async function ensureUser(db, username, role, password) {
  await db.deleteUser(username);
  const { user, tempPassword } = await db.createUser(username, role);
  await db.changePassword(user.id, tempPassword, password);
  return user;
}

module.exports = { ROOT, loadTestEnv, assertTestDatabase, prepareTestDatabase, ensureUser };
