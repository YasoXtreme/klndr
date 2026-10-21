// How pages and their files are cached. A mistake here is invisible in
// development and expensive in production: a URL cached for a year that points
// at the wrong bytes, or a guarded file cached somewhere shared.

const assert = require("node:assert/strict");
const path = require("path");

const pages = require("../apps/server/src/pages");

test("only files the build named after their contents are cached for a year", () => {
  const cases = [
    ["public", true, "public, max-age=31536000, immutable"],
    ["public", false, "public, no-cache"],
    ["protected", true, "private, max-age=31536000, immutable"],
    ["protected", false, "private, no-cache"],
    ["admin", true, "private, max-age=31536000, immutable"],
    ["admin", false, "private, no-cache"],
    // The font and the icons keep their names, so they are never immutable.
    ["assets", false, "public, max-age=604800"],
    ["assets", true, "public, max-age=604800"],
  ];
  for (const [scope, hashed, expected] of cases) {
    assert.equal(pages.cacheControl(scope, hashed), expected, `${scope} ${hashed}`);
  }
});

test("a file is hashed when it is in its page's own assets/", () => {
  const root = path.join(path.sep, "dist", "protected");
  const headersFor = (scope, rel) => {
    const headers = {};
    const res = { setHeader: (k, v) => (headers[k] = v) };
    pages.staticOptions(scope, root).setHeaders(res, path.join(root, ...rel.split("/")));
    return headers["Cache-Control"];
  };
  assert.equal(headersFor("protected", "assets/index-Dii0slk2.js"), "private, max-age=31536000, immutable");
  assert.equal(headersFor("protected", "index.html"), "private, no-cache");
  assert.equal(headersFor("protected", "vendor/lottie_light.min.js"), "private, no-cache");
  // A directory called assets further down is not the build's.
  assert.equal(headersFor("protected", "vendor/assets/x.js"), "private, no-cache");
  assert.equal(headersFor("public", "assets/index-CgNKhrG8.js"), "public, max-age=31536000, immutable");
});

test("staticOptions keeps the options it is given", () => {
  const options = pages.staticOptions("admin", "/dist/admin", { index: false, redirect: false });
  assert.equal(options.index, false);
  assert.equal(options.redirect, false);
  assert.equal(typeof options.setHeaders, "function");
});

test("there is no page by any other name", () => {
  assert.deepEqual(Object.keys(pages.PAGES).sort(), ["admin", "app", "login"]);
  assert.throws(() => pages.page("nope"), /No page called nope/);
});

test("the three pages are built into sibling directories", () => {
  const dirs = Object.values(pages.PAGES).map((file) => path.dirname(file));
  const parents = new Set(dirs.map((dir) => path.dirname(dir)));
  assert.equal(parents.size, 1, "one parent");
  assert.deepEqual(dirs.map((dir) => path.basename(dir)).sort(), ["admin", "protected", "public"]);
});
