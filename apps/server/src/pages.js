const fs = require("fs");
const path = require("path");
const { DIST } = require("./paths");

// How klndr's pages and their files reach the browser.
//
// Every stylesheet and script used to go out with Express's defaults: public,
// max-age=0. So each page view re-asked the server about every file it had
// already downloaded, behind the session guard, before anything could paint.
//
// The build (apps/web) now writes every file a page loads with a hash of its
// contents in its name, under that page's assets/. Editing a file changes its
// name, so a file under assets/ never changes and is cached for a year without
// being asked about again. The pages themselves are always revalidated, which
// is how a deploy reaches anyone. The build also writes the boot overlay into
// each page, so a page is served exactly as it was built.
//
// None of this touches the guards. /protected and /admin still demand a
// session, and an admin for /admin; their files are only ever cached privately,
// in the browser that was allowed to fetch them.

const PAGES = {
  app: path.join(DIST, "protected", "index.html"),
  admin: path.join(DIST, "admin", "index.html"),
  login: path.join(DIST, "public", "index.html"),
};

const YEAR = 31536000;
const WEEK = 604800;

// Keyed on (mtime, size) rather than read once per process: `npm run dev`
// rebuilds a page without restarting the server. On Vercel the files cannot
// change underneath a deployment, so the stat always hits.
const templates = new Map();

function read(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    throw new Error(`${path.relative(process.cwd(), file)} is missing: build the pages with npm run build:web`, { cause: err });
  }
  const known = templates.get(file);
  if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
    return known.html;
  }
  const html = fs.readFileSync(file, "utf8");
  templates.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, html });
  return html;
}

/**
 * Express handler for one of the pages. Always revalidated - the ETag that
 * res.send attaches turns an unchanged page into a bodiless 304 - and never
 * cached anywhere shared, because the guarded pages are only for whoever got
 * past the guard.
 */
function page(name) {
  const file = PAGES[name];
  if (!file) throw new Error(`No page called ${name}`);
  return (req, res, next) => {
    let html;
    try {
      html = read(file);
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
 * `hashed` is whether the file is one the build named after its contents,
 * which is everything under a page's assets/. Anything else might change under
 * the same URL, so it is revalidated. /assets itself (the font, the icons, the
 * manifest) is not hashed: the font's URL is named by both the pages and the
 * stylesheet, and has to stay the same in both or it downloads twice.
 */
function cacheControl(scope, hashed) {
  if (scope === "assets") return `public, max-age=${WEEK}`;
  if (scope === "public") return hashed ? `public, max-age=${YEAR}, immutable` : "public, no-cache";
  return hashed ? `private, max-age=${YEAR}, immutable` : "private, no-cache";
}

/**
 * Options for express.static serving `root`. setHeaders only runs for a file
 * that is actually being served, so a missing file can never be answered with
 * a year-long cache, and send leaves a Cache-Control it finds already set
 * alone.
 */
function staticOptions(scope, root, options = {}) {
  return {
    // Said outright: by default only a path's last segment is checked, so the
    // manifest the build leaves in .vite/ would be served.
    dotfiles: "ignore",
    ...options,
    setHeaders(res, file) {
      const hashed = path.relative(root, file).split(path.sep)[0] === "assets";
      res.setHeader("Cache-Control", cacheControl(scope, hashed));
    },
  };
}

module.exports = {
  page,
  cacheControl,
  staticOptions,
  PAGES,
};
