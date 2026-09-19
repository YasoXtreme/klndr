// The boot overlay's arithmetic: how long each entrance holds the logo, which
// handoffs a page believes, and where each part of the logo has to travel to
// land on the page's own brand. The DOM half is checked in a browser; these
// are the numbers it runs on.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const Boot = require("../public/js/boot");
const SOURCE = fs.readFileSync(path.join(__dirname, "..", "public", "js", "boot.js"), "utf8");

// Just enough of a browser for boot.js to start in: the browser half runs
// top to bottom the moment the page parses it, so a mistake there - a constant
// used before its line - blanks a page without a single test noticing.
function runInPage(variant, { breakCreate = false } = {}) {
  const classes = new Set();
  const inserted = [];
  const errors = [];
  const element = () => {
    const children = new Map();
    const el = {
      id: "",
      style: { setProperty() {} },
      classList: { add() {}, remove() {}, contains: () => false },
      setAttribute() {},
      addEventListener() {},
      remove() {},
      querySelector(selector) {
        if (!children.has(selector)) children.set(selector, element());
        return children.get(selector);
      },
    };
    return el;
  };
  const document = {
    documentElement: {
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    },
    body: {
      firstChild: null,
      getAttribute: (name) => (name === "data-boot" ? variant : null),
      insertBefore: (node) => inserted.push(node),
    },
    createElement() {
      if (breakCreate) throw new Error("no DOM today");
      return element();
    },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const window = {
    matchMedia: () => ({ matches: false }),
    location: { pathname: variant === "admin" ? "/admin" : "/", reload() {} },
  };
  const context = vm.createContext({
    window,
    document,
    sessionStorage: { getItem: () => null, removeItem() {} },
    performance: { now: () => 0 },
    setTimeout: () => 0,
    clearTimeout() {},
    console: { error: (...args) => errors.push(args) },
  });
  vm.runInContext(SOURCE, context);
  return { window, classes, inserted, errors };
}

test("the overlay starts on both pages, and is in front before the page hides", () => {
  for (const variant of ["app", "admin"]) {
    const { window, classes, inserted, errors } = runInPage(variant);
    assert.deepEqual(errors, [], `${variant} logged an error`);
    assert.equal(typeof window.KlndrBoot.ready, "function", variant);
    assert.equal(typeof window.KlndrBoot.fail, "function", variant);
    assert.equal(inserted.length, 1, variant);
    assert.equal(inserted[0].id, "klndrBoot", variant);
    assert.ok(classes.has("kb-busy"), `${variant} hides the page behind the overlay`);
    assert.equal(inserted[0].innerHTML.includes("kb-face-shield"), variant === "admin", variant);
    assert.equal(inserted[0].innerHTML.includes("kb-tag-in"), variant === "admin", variant);
  }
});

test("an overlay that cannot start leaves the page showing", () => {
  const { window, classes, errors } = runInPage("admin", { breakCreate: true });
  assert.equal(window.KlndrBoot, undefined);
  assert.equal(classes.has("kb-busy"), false);
  assert.equal(errors.length, 1);
});

test("each kind of load holds the logo for its own entrance and no longer", () => {
  assert.equal(Boot.schedule("normal", "app", false).settle, 420);
  assert.equal(Boot.schedule("hero", "app", false).settle, 920);
  assert.equal(Boot.schedule("normal", "admin", false).settle, 740);
  assert.equal(Boot.schedule("normal", "app", true).settle, Boot.TIMING.reduced);
  assert.equal(Boot.schedule("normal", "admin", true).settle, Boot.TIMING.reduced);
});

test("the admin beat starts as the wordmark lands and ends when the plate has turned", () => {
  const plan = Boot.schedule("normal", "admin", false);
  const wordLands = plan.wordDelay + plan.word;
  assert.ok(plan.flipDelay < wordLands && plan.flipDelay > plan.plate, "flip overlaps the landing");
  assert.ok(plan.tagDelay > plan.flipDelay, "the tag follows the turn");
  assert.equal(plan.settle, Math.max(plan.flipDelay + plan.flip, plan.tagDelay + plan.tag));
  // The app page never plays it.
  const app = Boot.schedule("normal", "app", false);
  assert.equal(app.flip, 0);
  assert.equal(app.tag, 0);
});

test("the idle press waits until the entrance is over", () => {
  for (const [kind, variant] of [["normal", "app"], ["hero", "app"], ["normal", "admin"]]) {
    const plan = Boot.schedule(kind, variant, false);
    assert.ok(plan.idleDelay > plan.settle, `${kind} ${variant}`);
  }
});

test("a handoff counts only for the page it was addressed to, while it is fresh", () => {
  const now = 1_000_000;
  const hero = (fields) => JSON.stringify({ v: 1, kind: "hero", to: "/", at: now - 500, ...fields });
  const at = (pathname) => ({ now, pathname });

  assert.deepEqual(Boot.parseHandoff(hero(), false, at("/")), { kind: "hero" });
  assert.equal(Boot.parseHandoff(hero(), false, at("/admin")), null, "another page");
  assert.equal(Boot.parseHandoff(hero({ at: now - 20_000 }), false, at("/")), null, "stale");
  assert.equal(Boot.parseHandoff(hero({ at: now + 60_000 }), false, at("/")), null, "from the future");
  assert.equal(Boot.parseHandoff(hero({ v: 2 }), false, at("/")), null, "unknown version");
  assert.equal(Boot.parseHandoff("{not json", false, at("/")), null, "garbage");
  assert.equal(Boot.parseHandoff(null, false, at("/")), null, "nothing");
});

test("the old login page's flag still earns the entrance on the app page", () => {
  const where = { now: 5, pathname: "/" };
  assert.deepEqual(Boot.parseHandoff(null, true, where), { kind: "hero" });
  assert.equal(Boot.parseHandoff(null, true, { now: 5, pathname: "/admin" }), null);
});

test("a destination matches its own path and what is under it, nothing else", () => {
  assert.equal(Boot.isDestination("/", "/"), true);
  assert.equal(Boot.isDestination("/admin", "/"), false);
  assert.equal(Boot.isDestination("/admin", "/admin"), true);
  assert.equal(Boot.isDestination("/admin/analytics", "/admin"), true);
  assert.equal(Boot.isDestination("/admin/analytics", "/admin/"), true);
  assert.equal(Boot.isDestination("/administrator", "/admin"), false);
  assert.equal(Boot.isDestination("/", undefined), false);
});

test("a part flies so the element measured inside it lands exactly on its target", () => {
  const rect = (left, top, width, height) => ({ left, top, width, height });
  // The wordmark part sits a little outside the word it holds.
  const part = rect(100, 200, 180, 60);
  const measured = rect(104, 203, 172, 59);
  const target = rect(40, 12, 60, 20.5);
  const move = Boot.flipTransform(part, measured, target, false);

  // transform-origin at the measured element's corner, in the part's own box.
  assert.equal(move.originX, 4);
  assert.equal(move.originY, 3);

  // Apply translate(x, y) scale(s) about that origin to the measured corners.
  const place = (px, py) => {
    const ox = part.left + move.originX;
    const oy = part.top + move.originY;
    return [ox + move.x + move.s * (px - ox), oy + move.y + move.s * (py - oy)];
  };
  const [left, top] = place(measured.left, measured.top);
  const [right, bottom] = place(measured.left + measured.width, measured.top + measured.height);
  assert.ok(Math.abs(left - target.left) < 1e-9);
  assert.ok(Math.abs(top - target.top) < 1e-9);
  assert.ok(Math.abs(bottom - top - target.height) < 1e-9, "height matches");
  assert.ok(Math.abs(right - left - measured.width * move.s) < 1e-9);

  // The plate is square, and scaled by its width.
  const plate = rect(0, 0, 92, 92);
  assert.equal(Boot.flipTransform(plate, plate, rect(10, 10, 32, 32), true).s, 32 / 92);
});
