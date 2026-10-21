// Serves .vercel/output the way Vercel does, so the deployed artifact itself can
// be tested before it is deployed: a file under static/ is served as-is with the
// headers config.json gives a filesystem hit, and everything else goes to the
// bundled server. `npm run build` first.
//
//   PORT=3011 MONGODB_DB=klndr_e2e node scripts/serve-bundle.mjs

import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".vercel", "output");
const STATIC = path.join(OUT, "static");
const BUNDLE = path.join(OUT, "functions", "index.func", "index.js");

if (!fs.existsSync(BUNDLE)) {
  console.error("No .vercel/output yet: run `npm run build` first.");
  process.exit(1);
}

// Vercel hands the function its environment; locally that is .env, as for
// `npm start`. The shell wins over the file.
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const handler = createRequire(import.meta.url)(BUNDLE);
const { routes } = JSON.parse(fs.readFileSync(path.join(OUT, "config.json"), "utf8"));
const hitRoutes = routes.slice(routes.findIndex((route) => route.handle === "hit") + 1).filter((route) => route.src);

// A module script with any other type is refused by the browser, which is what
// the CDN would never do.
const TYPES = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
};

function staticFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const file = path.join(STATIC, decoded);
  if (!file.startsWith(STATIC + path.sep)) return null;
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const file = req.method === "GET" || req.method === "HEAD" ? staticFile(pathname) : null;
  if (!file) return handler(req, res);

  for (const route of hitRoutes) {
    if (new RegExp(route.src).test(pathname)) {
      for (const [name, value] of Object.entries(route.headers ?? {})) res.setHeader(name, value);
    }
  }
  res.setHeader("Content-Type", TYPES[path.extname(file)] ?? "application/octet-stream");
  res.setHeader("Content-Length", fs.statSync(file).size);
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => console.log(`Serving .vercel/output on http://localhost:${port}`));
