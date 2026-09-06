#!/usr/bin/env node
const db = require("../server/db");

const args = process.argv.slice(2);
const command = args[0];

function printHelp() {
  console.log(`
======================================================
  Klndr Beta Account Manager CLI
======================================================
Usage:
  node scripts/manage-users.js add <username> <password> [role]
  node scripts/manage-users.js list
  node scripts/manage-users.js delete <username>
  node scripts/manage-users.js reset <username>

Examples:
  node scripts/manage-users.js add john securePass123
  node scripts/manage-users.js add sara physicsPro2026 admin
  node scripts/manage-users.js list
  node scripts/manage-users.js reset john
======================================================
`);
}

async function main() {
  if (!command) {
    printHelp();
    process.exit(0);
  }

  // Wait for Mongo indexes + optional seed before CLI ops
  if (db.ready) await db.ready;

  switch (command.toLowerCase()) {
    case "add": {
      const username = args[1];
      const password = args[2];
      const role = args[3] || "user";

      if (!username || !password) {
        console.error("Error: username and password are required.");
        console.log(
          "Usage: node scripts/manage-users.js add <username> <password> [role]",
        );
        process.exit(1);
      }

      try {
        const user = await db.createUser(username, password, role);
        console.log(`\n✓ Successfully created Klndr beta user:`);
        console.log(`  ID:       ${user.id}`);
        console.log(`  Username: ${user.username}`);
        console.log(`  Role:     ${user.role}`);
        console.log(
          `  Created:  ${new Date(user.created_at * 1000).toLocaleString()}\n`,
        );
      } catch (err) {
        console.error(`\n✗ Failed to create user: ${err.message}\n`);
        process.exit(1);
      }
      break;
    }

    case "list": {
      const users = await db.getAllUsers();
      console.log(`\n=== Klndr Beta Accounts (${users.length}) ===`);
      if (users.length === 0) {
        console.log("No users registered yet.");
      } else {
        console.table(users);
      }
      console.log("");
      break;
    }

    case "reset": {
      const username = args[1];
      if (!username) {
        console.error("Error: username is required.");
        console.log("Usage: node scripts/manage-users.js reset <username>");
        process.exit(1);
      }

      const result = await db.adminResetPassword(username);
      if (!result) {
        console.log(`\n✗ User '${username}' not found.\n`);
        process.exit(1);
      }
      console.log(`\n✓ Password reset for '${result.user.username}'.`);
      console.log(`\n  Temporary password:  ${result.tempPassword}\n`);
      console.log("  Hand this over directly. It is not stored in readable");
      console.log("  form and will not be shown again. Their sessions have");
      console.log("  all been signed out, and they must choose a new password");
      console.log("  at their next login.");
      console.log("");
      break;
    }

    case "delete": {
      const username = args[1];
      if (!username) {
        console.error("Error: username is required.");
        console.log(
          "Usage: node scripts/manage-users.js delete <username>",
        );
        process.exit(1);
      }

      const success = await db.deleteUser(username);
      if (success) {
        console.log(`\n✓ Successfully deleted user '${username}'.\n`);
      } else {
        console.log(`\n✗ User '${username}' not found.\n`);
        process.exit(1);
      }
      break;
    }

    default:
      printHelp();
      process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
