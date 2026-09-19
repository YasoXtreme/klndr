const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// How klndr's pages and their files reach the browser.
//
// Every stylesheet and script used to go out with Express's defaults: public,
// max-age=0. So each page view re-asked the server about every file it had
// already downloaded - about twenty-five requests, twenty-three of them behind
// the session guard, so two database reads apiece - before anything could
// paint. On Vercel all of it runs through the one function.
//
// The fix is the standard one, done at runtime because klndr has no build step.
// Each page is served with every local asset URL carrying a hash of that file's
// contents, and a URL whose hash is current is cached for a year and never
// asked about again. Editing a file changes its hash, so the next page load
// asks for the new URL. The pages themselves are always revalidated, which is
// how a deploy reaches anyone.
//
// None of this touches the guards. /protected and /admin still demand a
// session, and an admin for /admin; their files are only ever cached privately,
// in the browser that was allowed to fetch them.

const ROOT = path.join(__dirname, "..");

// The same URL-to-directory mapping as the static mounts in server.js.
const MOUNTS = [
  ["/public/", path.join(ROOT, "public")],
  ["/protected/", path.join(ROOT, "protected")],
  ["/admin/", path.join(ROOT, "admin")],
];

const PAGES = {
  app: path.join(ROOT, "protected", "index.html"),
  admin: path.join(ROOT, "admin", "index.html"),
  login: path.join(ROOT, "public", "login.html"),
};

const YEAR = 31536000;
const WEEK = 604800;

// Keyed on (mtime, size) rather than computed once per process: `node --watch`
// restarts for server code, not for an edited stylesheet, and a stale hash here
// would pin the old file in the browser for a year. On Vercel the files cannot
// change underneath a deployment, so the stat always hits.
const fileHashes = new Map();
const templates = new Map();

function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch (err) {
    return null;
  }
}

function hashFile(file, stat = fs.statSync(file)) {
  const known = fileHashes.get(file);
  if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
    return known.hash;
  }
  const hash = crypto
    .createHash("sha1")
    .update(fs.readFileSync(file))
    .digest("hex")
    .slice(0, 10);
  fileHashes.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
  return hash;
}

/** The file a local asset URL is served from, or null if it is not one. */
function fileFor(urlPath) {
  for (const [prefix, dir] of MOUNTS) {
    if (!urlPath.startsWith(prefix)) continue;
    let rel;
    try {
      rel = decodeURIComponent(urlPath.slice(prefix.length));
    } catch (err) {
      return null;
    }
    const file = path.join(dir, rel);
    // Never outside the mount, whatever the markup says.
    return file.startsWith(dir + path.sep) ? file : null;
  }
  return null;
}

// Only attribute values that are a bare local path: anything already carrying
// a query or a fragment is left exactly as written.
//
// /assets is deliberately not in the list. The ElmsSans preload in each page
// and the @font-face in common.css have to name the font by the same URL, or
// the browser treats them as two files and downloads it twice - and the
// stylesheet cannot be rewritten the way a page can.
const ASSET_ATTR = /\b(src|href)="(\/(?:public|protected|admin)\/[^"?#]+)"/g;

/** Stamp every local asset URL in a page with its file's current hash. */
function versionUrls(html) {
  return html.replace(ASSET_ATTR, (match, attr, url) => {
    const file = fileFor(url);
    const stat = file && statOrNull(file);
    if (!stat || !stat.isFile()) return match;
    return `${attr}="${url}?v=${hashFile(file, stat)}"`;
  });
}

function template(file) {
  const stat = fs.statSync(file);
  const known = templates.get(file);
  if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
    return known.html;
  }
  const html = fs.readFileSync(file, "utf8");
  templates.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, html });
  return html;
}

function render(name) {
  const file = PAGES[name];
  if (!file) throw new Error(`No page called ${name}`);
  return versionUrls(template(file));
}

/**
 * Express handler for one of the pages. Always revalidated - the ETag that
 * res.send attaches turns an unchanged page into a bodiless 304 - and never
 * cached anywhere shared, because the guarded pages are only for whoever got
 * past the guard.
 */
function page(name) {
  return (req, res, next) => {
    let html;
    try {
      html = render(name);
    } catch (err) {
      return next(err);
    }
    res.set("Cache-Control", "private, no-cache");
    res.type("html").send(html);
  };
}

/**
 * The Cache-Control for a static file.
 *
 * `current` is whether the request named the file's current hash. Only then is
 * it safe to cache for a year: a request naming an old hash is served today's
 * file, and caching that answer would pin today's file to yesterday's URL.
 */
function cacheControl(scope, current) {
  if (scope === "assets") return `public, max-age=${WEEK}`;
  if (scope === "public") {
    // s-maxage lets Vercel's CDN keep it too. The CDN strips it from what the
    // browser sees, and it is never set on a guarded file.
    return current
      ? `public, max-age=${YEAR}, immutable, s-maxage=${YEAR}`
      : "public, no-cache";
  }
  return current ? `private, max-age=${YEAR}, immutable` : "private, no-cache";
}

/**
 * Options for express.static. setHeaders only runs for a file that is actually
 * being served, so a missing file can never be answered with a year-long
 * cache, and send leaves a Cache-Control it finds already set alone.
 */
function staticOptions(scope, options = {}) {
  return {
    ...options,
    setHeaders(res, file, stat) {
      const query = res.req && res.req.query;
      const v = query && typeof query.v === "string" ? query.v : null;
      const current = Boolean(v) && scope !== "assets" && hashFile(file, stat) === v;
      res.setHeader("Cache-Control", cacheControl(scope, current));
    },
  };
}

module.exports = {
  page,
  render,
  versionUrls,
  fileFor,
  hashFile,
  cacheControl,
  staticOptions,
  PAGES,
};
