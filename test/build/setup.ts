import { execFileSync } from "node:child_process";
import path from "node:path";

// npm run build, once for the whole suite: the pages into apps/web/dist, then
// what Vercel deploys into .vercel/output.
export default function setup() {
  const root = path.resolve(import.meta.dirname, "..", "..");
  execFileSync(process.execPath, [path.join(root, "scripts", "build-vercel-output.mjs")], { cwd: root, stdio: "pipe" });
}
