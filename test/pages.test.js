// How pages and their files are cached. A mistake here is invisible in
// development and expensive in production: a URL cached for a year that points
// at the wrong bytes, or a page that quietly stops being versioned and goes
// back to asking the server about every file on every load.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const pages = require("../server/pages");

const ROOT = path.join(__dirname, "..");
const LOCAL_ASSET = /\b(?:src|href)="(\/(?:public|protected|admin)\/[^"]*)"/g;

function localUrls(html) {
  return [...html.matchAll(LOCAL_ASSET)].map((m) => m[1]);
}

test("versionUrls stamps a local file with a hash of its contents", () => {
  const out = pages.versionUrls('<link rel="stylesheet" href="/public/css/theme.css" />');
  const hash = pages.hashFile(path.join(ROOT, "public", "css", "theme.css"));
  assert.match(hash, /^[0-9a-f]{10}$/);
  assert.equal(out, `<link rel="stylesheet" href="/public/css/theme.css?v=${hash}" />`);
});

test("versionUrls leaves everything that is not a local file alone", () => {
  const untouched = [
    // The font has to keep the URL common.css's @font-face names it by.
    '<link rel="preload" href="/assets/ElmsSans.ttf" as="font" />',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X" />',
    '<script src="/protected/js/app.js?v=abc"></script>',
    '<script src="/protected/js/nope.js"></script>',
    '<a href="/admin/studio">a directory</a>',
    '<a href="/admin/announcements">a page, not a file</a>',
    '<a href="/">home</a>',
    '<script src="/public/../server.js"></script>',
  ];
  for (const html of untouched) {
    assert.equal(pages.versionUrls(html), html, html);
  }
});

test("every local file each page loads is versioned, and page links are not", () => {
  for (const name of Object.keys(pages.PAGES)) {
    const html = pages.render(name);
    let versioned = 0;
    for (const url of localUrls(html)) {
      const [pathname, query] = url.split("?");
      const file = pages.fileFor(pathname);
      const isFile = Boolean(file && fs.existsSync(file) && fs.statSync(file).isFile());
      if (isFile) {
        versioned += 1;
        assert.equal(query, `v=${pages.hashFile(file)}`, `${name}: ${url}`);
      } else {
        assert.equal(query, undefined, `${name}: ${url} is not a file`);
      }
    }
    assert.ok(versioned > 0, `${name} versions nothing`);
  }
});

test("the ElmsSans preload and the @font-face name the same URL", () => {
  const css = fs.readFileSync(path.join(ROOT, "public", "css", "common.css"), "utf8");
  const face = css.match(/url\(['"]?([^'")]+ElmsSans[^'")]*)['"]?\)/)[1];
  for (const name of Object.keys(pages.PAGES)) {
    const html = pages.render(name);
    const preload = html.match(/<link[^>]*rel="preload"[^>]*href="([^"]*ElmsSans[^"]*)"/)[1];
    assert.equal(preload, face, name);
  }
});

test("only a request naming the current hash is cached for a year", () => {
  const cases = [
    ["public", true, "public, max-age=31536000, immutable, s-maxage=31536000"],
    ["public", false, "public, no-cache"],
    ["protected", true, "private, max-age=31536000, immutable"],
    ["protected", false, "private, no-cache"],
    ["admin", true, "private, max-age=31536000, immutable"],
    ["admin", false, "private, no-cache"],
    ["assets", false, "public, max-age=604800"],
  ];
  for (const [scope, current, expected] of cases) {
    assert.equal(pages.cacheControl(scope, current), expected, `${scope} ${current}`);
  }
});

test("setHeaders reads the hash off the request", () => {
  const file = path.join(ROOT, "protected", "js", "api.js");
  const stat = fs.statSync(file);
  const headersFor = (scope, query) => {
    const headers = {};
    const res = { req: { query }, setHeader: (k, v) => (headers[k] = v) };
    pages.staticOptions(scope).setHeaders(res, file, stat);
    return headers["Cache-Control"];
  };
  const v = pages.hashFile(file, stat);
  assert.equal(headersFor("protected", { v }), "private, max-age=31536000, immutable");
  assert.equal(headersFor("protected", { v: "0123456789" }), "private, no-cache");
  assert.equal(headersFor("protected", {}), "private, no-cache");
  assert.equal(headersFor("protected", { v: [v, v] }), "private, no-cache");
  assert.equal(headersFor("public", { v }), "public, max-age=31536000, immutable, s-maxage=31536000");
  // A /assets file is never immutable, whatever the URL claims.
  assert.equal(headersFor("assets", { v }), "public, max-age=604800");
});

test("staticOptions keeps the options it is given", () => {
  const options = pages.staticOptions("admin", { index: false, redirect: false });
  assert.equal(options.index, false);
  assert.equal(options.redirect, false);
  assert.equal(typeof options.setHeaders, "function");
});

test("an edited file gets a new hash, without a restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "klndr-pages-"));
  const file = path.join(dir, "a.css");
  try {
    fs.writeFileSync(file, "a{}");
    const first = pages.hashFile(file);
    assert.equal(pages.hashFile(file), first, "stable while unchanged");

    // Same length, different bytes: only the mtime says it changed.
    fs.writeFileSync(file, "b{}");
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    const second = pages.hashFile(file);
    assert.notEqual(second, first);

    fs.writeFileSync(file, "b{color:red}");
    assert.notEqual(pages.hashFile(file), second);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
