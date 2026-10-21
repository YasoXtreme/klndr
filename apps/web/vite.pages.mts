import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createLogger, type InlineConfig, type Plugin } from "vite";
import { klndrPage, type PartialName } from "./build/klndr-page.mts";

// The three pages, each its own Vite build into a directory of dist/ that the
// server mounts at the page's base. They stay siblings: the server guards each
// directory on its own mount, and one inside another would be reachable
// through the outer mount, past the inner one's guard (see apps/server/src/server.js).
//
//   app     /            its files under /protected, behind a login
//   admin   /admin       its files under /admin, behind an admin login
//   login   /login       its files under /public, served to anyone
//
// Every file a build writes goes in its assets/ with a hash of its contents in
// the name, which is what lets the server cache them for a year. What is
// served as it is, unhashed (the font, the icons, the manifest), is
// static/assets, mounted at /assets.

const WEB = import.meta.dirname;

export type Page = {
  name: string;
  dir: string;
  base: string;
  out: string;
  partials: readonly PartialName[];
};

export const PAGES: readonly Page[] = [
  { name: "app", dir: "app", base: "/protected/", out: "protected", partials: ["boot.css", "boot.js"] },
  { name: "admin", dir: "admin", base: "/admin/", out: "admin", partials: ["boot.css", "boot.js"] },
  { name: "login", dir: "login", base: "/public/", out: "public", partials: [] },
];

export const DIST = path.join(WEB, "dist");

// Tabs opened before the move to Vite load Lottie and fflate from these two
// URLs, as plain scripts. They are copied for one release so those tabs keep
// working, and go with the next one.
function legacyVendorCopies(outDir: string): Plugin {
  const require = createRequire(import.meta.url);
  const copies: [string, string][] = [
    [require.resolve("lottie-web/build/player/lottie_light.min.js"), "lottie_light.min.js"],
    [path.join(path.dirname(require.resolve("fflate/package.json")), "umd", "index.js"), "fflate.min.js"],
  ];
  return {
    name: "klndr-legacy-vendor",
    writeBundle() {
      const dir = path.join(outDir, "vendor");
      fs.mkdirSync(dir, { recursive: true });
      for (const [from, to] of copies) fs.copyFileSync(from, path.join(dir, to));
    },
  };
}

// Vite points out every /assets URL in a stylesheet that it leaves for the
// server to resolve. Each one is left that way on purpose (see above), so the
// notice is dropped; anything else it says is kept.
function quietLogger() {
  const logger = createLogger("warn");
  const expected = (message: string) => /(^|\n)\/assets\/\S+ referenced in .* didn't resolve at build time/.test(message);
  const { warn, warnOnce } = logger;
  logger.warn = (message, options) => (expected(message) ? undefined : warn(message, options));
  logger.warnOnce = (message, options) => (expected(message) ? undefined : warnOnce(message, options));
  return logger;
}

export function pageConfig(page: Page, { watch = false } = {}): InlineConfig {
  const outDir = path.join(DIST, page.out);
  return {
    configFile: false,
    root: path.join(WEB, "src", page.dir),
    base: page.base,
    // Nothing is copied into a page's directory as it is: unhashed files live
    // in static/ and have a mount of their own.
    publicDir: false,
    logLevel: "warn",
    customLogger: quietLogger(),
    plugins: [
      klndrPage({ page: page.name, partials: page.partials }),
      ...(page.name === "app" ? [legacyVendorCopies(outDir)] : []),
    ],
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: true,
      // Stylesheets are bundled as written, not minified. The minifier
      // rewrites custom properties (#ffffff to #fff, 120ms to .12s, rgba() to
      // eight-digit hex) and lowers color-scheme into variables of its own,
      // and the canvas and the motion core read those properties from script
      // and parse them. Compressed in transit, the difference in size is small.
      cssMinify: false,
      // Which source files went into which output file: the tests read it to
      // hold the login page to its own code.
      manifest: true,
      // The notices of every library bundled in (lottie-web, fflate), served
      // beside the files that carry them.
      license: { fileName: "licenses.md" },
      reportCompressedSize: false,
      watch: watch ? {} : null,
    },
  };
}
