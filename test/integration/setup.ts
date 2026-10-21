import { createRequire } from "node:module";

// Runs in every worker before any test file, so the database guard always
// comes before the first require of server/db.
const require = createRequire(import.meta.url);
const { prepareTestDatabase } = require("../support/test-db.cjs");

prepareTestDatabase();
