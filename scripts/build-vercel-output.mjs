// Builds what Vercel deploys, in its Build Output API layout
// (https://vercel.com/docs/build-output-api). `npm run build` runs this, and
// vercel.json makes it the deployment's build command:
//
//   .vercel/output/config.json            files first, then everything else to the function
//   .vercel/output/static/                what the CDN may hand to anyone: /assets, the
//                                         favicon, and the login page's hashed files
//   .vercel/output/functions/index.func/  the server bundled into one file, with the built
//                                         pages beside it in web/dist and web/static
//
// The pages' directories stay siblings inside the function because that is a
// security boundary, not tidiness: a static mount resolves `..` after its guard
// has matched, so a directory inside another mount is reachable through it
// (see apps/server/src/server.js above the /admin mount).
//
// Nothing behind a login goes on the CDN, which serves anyone. The login
// page's files do: the page is public, and the build names each after its
// contents, so a cached copy can never go stale.

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "apps", "web");
const OUT = path.join(ROOT, ".vercel", "output");
const FUNCTION = path.join(OUT, "functions", "index.func");
const STATIC = path.join(OUT, "static");

// The MongoDB driver's optional peers. It requires each inside a try/catch and
// carries on without it, so they stay out of the bundle and out of the deploy.
const OPTIONAL_PEERS = [
  "@aws-sdk/credential-providers",
  "@mongodb-js/zstd",
  "gcp-metadata",
  "kerberos",
  "mongodb-client-encryption",
  "snappy",
  "socks",
];

const WEEK = 604800;
const YEAR = 31536000;

execFileSync(process.execPath, [path.join(WEB, "build.mts")], { cwd: ROOT, stdio: "inherit" });

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(FUNCTION, { recursive: true });
fs.mkdirSync(STATIC, { recursive: true });

await build({
  entryPoints: [path.join(ROOT, "apps", "server", "src", "server.js")],
  outfile: path.join(FUNCTION, "index.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  sourcemap: true,
  external: OPTIONAL_PEERS,
  // apps/server/src/paths.js: inside the bundle, the files sit beside it.
  define: { "process.env.KLNDR_BUNDLED": '"1"' },
  logLevel: "warning",
});

for (const dir of ["dist", "static"]) {
  fs.cpSync(path.join(WEB, dir), path.join(FUNCTION, "web", dir), { recursive: true });
}
fs.cpSync(path.join(WEB, "static", "assets"), path.join(STATIC, "assets"), { recursive: true });
fs.copyFileSync(path.join(WEB, "static", "assets", "favicon.ico"), path.join(STATIC, "favicon.ico"));
fs.cpSync(path.join(WEB, "dist", "public", "assets"), path.join(STATIC, "public", "assets"), { recursive: true });

const json = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

json(path.join(FUNCTION, ".vc-config.json"), {
  runtime: "nodejs24.x",
  handler: "index.js",
  launcherType: "Nodejs",
  // Express reads the raw request itself; Vercel's helpers would only add work.
  shouldAddHelpers: false,
  shouldAddSourcemapSupport: true,
});
// The bundle is CommonJS whatever the repo's package.json ever says.
json(path.join(FUNCTION, "package.json"), { type: "commonjs" });

json(path.join(OUT, "config.json"), {
  version: 3,
  routes: [
    { handle: "filesystem" },
    // Anything that isn't a file on the CDN goes to the server, path intact.
    { src: "^/.*$", dest: "/index" },
    // Headers for files the CDN did serve. In the hit phase only, so a missing
    // file reaches the server and its 404 is never cached.
    { handle: "hit" },
    {
      src: "^/public/assets/.+$",
      headers: { "Cache-Control": `public, max-age=${YEAR}, immutable` },
      continue: true,
      important: true,
    },
    {
      src: "^/(?:assets/.+|favicon\\.ico)$",
      headers: { "Cache-Control": `public, max-age=${WEEK}` },
      continue: true,
      important: true,
    },
  ],
});

const size = fs.statSync(path.join(FUNCTION, "index.js")).size;
console.log(`Built .vercel/output: server bundle ${(size / 1024).toFixed(0)} KB; on the CDN /assets, /favicon.ico and /public/assets.`);
