// npm run dev: the pages rebuilt as their files change, and the server
// restarted as its own do.
//
// The server reads each page from apps/web/dist when it is asked for it, so a
// rebuilt page is live on the next reload. There is no hot replacement: what
// runs is what ships, the real guards and the boot overlay included.

import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = path.join(ROOT, "apps", "web", "build.mts");

// Once in full first, so the server never starts without its pages.
execFileSync(process.execPath, [BUILD], { cwd: ROOT, stdio: "inherit" });

const children = [
  spawn(process.execPath, [BUILD, "--watch"], { cwd: ROOT, stdio: "inherit" }),
  spawn(process.execPath, ["--watch", path.join(ROOT, "apps", "server", "src", "server.js")], { cwd: ROOT, stdio: "inherit" }),
];

// Either one stopping stops the other.
for (const child of children) {
  child.on("exit", (code) => {
    for (const other of children) if (other !== child) other.kill();
    process.exitCode = code ?? 0;
  });
}
