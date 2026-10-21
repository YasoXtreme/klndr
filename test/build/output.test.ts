import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

// What scripts/build-vercel-output.mjs hands Vercel. The layout is the
// security model as much as the deploy: anything under static/ is served to
// anyone by the CDN, so nothing behind the login may ever land there.

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const OUT = path.join(ROOT, ".vercel", "output");
const STATIC = path.join(OUT, "static");
const FUNCTION = path.join(OUT, "functions", "index.func");

const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
}

beforeAll(() => {
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "build-vercel-output.mjs")], { cwd: ROOT, stdio: "pipe" });
}, 120_000);

describe("the CDN", () => {
  test("holds only /assets and the favicon", () => {
    const files = filesUnder(STATIC);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => !(file.startsWith("assets/") || file === "favicon.ico"))).toEqual([]);
  });

  test("holds no page, script or stylesheet", () => {
    expect(filesUnder(STATIC).filter((file) => /\.(html|js|css|map)$/.test(file))).toEqual([]);
  });

  test("serves the font at the exact URL every page preloads", () => {
    expect(fs.existsSync(path.join(STATIC, "assets", "ElmsSans.ttf"))).toBe(true);
  });
});

describe("the function", () => {
  test("carries public, protected and admin as siblings", () => {
    for (const dir of ["public", "protected", "admin"]) {
      expect(fs.statSync(path.join(FUNCTION, dir)).isDirectory(), dir).toBe(true);
    }
    expect(fs.existsSync(path.join(FUNCTION, "protected", "admin"))).toBe(false);
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
      expect.objectContaining({ src: "^/(?:assets/.+|favicon\\.ico)$", headers: { "Cache-Control": "public, max-age=604800" } }),
    ]);
  });
});
