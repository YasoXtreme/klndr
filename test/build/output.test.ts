import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

// What scripts/build-vercel-output.mjs hands Vercel. The layout is the
// security model as much as the deploy: anything under static/ is served to
// anyone by the CDN, so nothing behind the login may ever land there.

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const OUT = path.join(ROOT, ".vercel", "output");
const STATIC = path.join(OUT, "static");
const FUNCTION = path.join(OUT, "functions", "index.func");
const LOGIN_ASSETS = path.join(ROOT, "apps", "web", "dist", "public", "assets");

const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
}

describe("the CDN", () => {
  test("holds only /assets, the favicon and the login page's files", () => {
    const files = filesUnder(STATIC);
    expect(files.length).toBeGreaterThan(0);
    const allowed = (file: string) => file.startsWith("assets/") || file.startsWith("public/assets/") || file === "favicon.ico";
    expect(files.filter((file) => !allowed(file))).toEqual([]);
  });

  test("holds no page, and no script or stylesheet but the login page's own", () => {
    const login = new Set(filesUnder(LOGIN_ASSETS).map((file) => `public/assets/${file}`));
    expect(login.size).toBeGreaterThan(0);
    const code = filesUnder(STATIC).filter((file) => /\.(html|js|css|map)$/.test(file));
    expect(code.filter((file) => !login.has(file))).toEqual([]);
  });

  test("serves the font at the exact URL every page preloads", () => {
    expect(fs.existsSync(path.join(STATIC, "assets", "ElmsSans.ttf"))).toBe(true);
  });
});

describe("the function", () => {
  test("carries the three pages as siblings", () => {
    const dist = path.join(FUNCTION, "web", "dist");
    for (const dir of ["public", "protected", "admin"]) {
      expect(fs.statSync(path.join(dist, dir)).isDirectory(), dir).toBe(true);
    }
    expect(fs.existsSync(path.join(dist, "protected", "admin"))).toBe(false);
    expect(fs.existsSync(path.join(FUNCTION, "web", "static", "assets", "ElmsSans.ttf"))).toBe(true);
  });

  test("is configured as a Node 24 function", () => {
    expect(read(path.join(FUNCTION, ".vc-config.json"))).toMatchObject({
      runtime: "nodejs24.x",
      handler: "index.js",
      launcherType: "Nodejs",
    });
    expect(read(path.join(FUNCTION, "package.json"))).toEqual({ type: "commonjs" });
  });

  // Loaded in a child process with a placeholder database address: requiring
  // the server starts a connection, and this only needs to know that every
  // module resolves and the export is a request handler.
  test("loads, and exports a request handler", () => {
    const out = execFileSync(
      process.execPath,
      ["-e", "const app = require(process.argv[1]); console.log(typeof app); process.exit(0)", path.join(FUNCTION, "index.js")],
      { env: { ...process.env, MONGODB_URI: "mongodb://127.0.0.1:1/never", MONGODB_DB: "klndr_build_test" }, encoding: "utf8" },
    );
    // The last line: dotenv announces itself first.
    expect(out.trim().split("\n").pop()).toBe("function");
  });
});

describe("routing", () => {
  test("files first, then everything else to the function, path intact", () => {
    const { version, routes } = read(path.join(OUT, "config.json"));
    expect(version).toBe(3);
    expect(routes[0]).toEqual({ handle: "filesystem" });
    expect(routes[1]).toEqual({ src: "^/.*$", dest: "/index" });
    expect(routes[2]).toEqual({ handle: "hit" });
  });

  test("cache headers apply only to files the CDN served", () => {
    const { routes } = read(path.join(OUT, "config.json"));
    const hit = routes.slice(routes.findIndex((route: { handle?: string }) => route.handle === "hit") + 1);
    expect(hit).toEqual([
      expect.objectContaining({ src: "^/public/assets/.+$", headers: { "Cache-Control": "public, max-age=31536000, immutable" } }),
      expect.objectContaining({ src: "^/(?:assets/.+|favicon\\.ico)$", headers: { "Cache-Control": "public, max-age=604800" } }),
    ]);
  });
});
