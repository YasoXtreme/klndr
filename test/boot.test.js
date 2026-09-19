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
function runInPage(variant, { breakCreate = false, handoff = null } = {}) {
  const classes = new Set();
  const inserted = [];
  const errors = [];
  const listeners = [];
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
    addEventListener: (type) => listeners.push(type),
    fonts: null,
  };
  const window = {
    matchMedia: () => ({ matches: false }),
    location: { pathname: variant === "admin" ? "/admin" : "/", reload() {} },
    addEventListener: (type) => listeners.push(type),
  };
  const context = vm.createContext({
    window,
    document,
    sessionStorage: {
      getItem: (key) => (key === "klndr:boot" && handoff ? JSON.stringify(handoff) : null),
      removeItem() {},
    },
    performance: { now: () => 0, timeOrigin: 0, getEntriesByType: () => [] },
    setTimeout: () => 0,
    clearTimeout() {},
    console: { error: (...args) => errors.push(args) },
  });
  vm.runInContext(SOURCE, context);
  return { window, classes, inserted, errors, listeners };
}

test("the overlay starts on both pages, and is in front before the page hides", () => {
  for (const variant of ["app", "admin"]) {
    const { window, classes, inserted, errors } = runInPage(variant);
    assert.deepEqual(errors, [], `${variant} logged an error`);
    for (const name of ["ready", "fail", "leave", "guard"]) {
      assert.equal(typeof window.KlndrBoot[name], "function", `${variant}.${name}`);
    }
    assert.equal(inserted.length, 1, variant);
    assert.equal(inserted[0].id, "klndrBoot", variant);
    assert.ok(classes.has("kb-busy"), `${variant} hides the page behind the overlay`);
    assert.equal(inserted[0].innerHTML.includes("kb-face-shield"), variant === "admin", variant);
    assert.equal(inserted[0].innerHTML.includes("kb-tag-in"), variant === "admin", variant);
  }
});

test("a page carried in from another one starts without a fuss", () => {
  const handoff = {
    v: 1,
    kind: "leave",
    to: "/admin",
    variant: "admin",
    fromAdmin: false,
    at: Date.now(),
    rects: {
      plate: { left: 18, top: 18, width: 32, height: 32 },
      word: { left: 58, top: 24, width: 53, height: 20 },
      tag: null,
    },
  };
  const { window, inserted, errors, listeners } = runInPage("admin", { handoff });
  assert.deepEqual(errors, []);
  assert.equal(inserted.length, 1);
  assert.equal(typeof window.KlndrBoot.leave, "function");
  // A link click and a return from the back/forward cache are both watched for.
  assert.ok(listeners.includes("click"), "click");
  assert.ok(listeners.includes("pageshow"), "pageshow");
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

test("the trip to admin turns the plate over after the rise; the trip back drops the tag", () => {
  const toAdmin = Boot.leaveTimeline("admin", false);
  assert.equal(toAdmin.flipDelay, toAdmin.rise, "the plate turns once the logo is up");
  assert.ok(toAdmin.tagDelay > toAdmin.flipDelay, "the tag follows the turn");
  assert.equal(toAdmin.retract, 0);
  assert.equal(toAdmin.end, Math.max(toAdmin.flipDelay + toAdmin.flip, toAdmin.tagDelay + toAdmin.tag));

  const toApp = Boot.leaveTimeline("app", true);
  assert.equal(toApp.flip, 0, "nothing to turn over");
  assert.ok(toApp.retract > 0 && toApp.retract < toApp.rise, "the tag goes while the logo rises");
  assert.equal(toApp.end, toApp.rise);

  // Between two pages of the same kind there is only the rise.
  assert.equal(Boot.leaveTimeline("app", false).end, Boot.TIMING.rise);
});

test("an arriving page plays only what is left of the trip", () => {
  const end = Boot.leaveTimeline("admin", false).end;
  const left = (offset) => Boot.schedule("leave", "admin", false, { fromAdmin: false, offset }).settle;
  assert.equal(left(0), end, "nothing of it had played");
  assert.equal(left(200), end - 200);
  assert.equal(left(end + 500), 0, "the trip was over before the page came");
  assert.equal(
    Boot.schedule("leave", "admin", true, { fromAdmin: false, offset: 0 }).settle,
    Boot.TIMING.reduced
  );
  // The press waits for the trip to land, however much of it is left.
  assert.ok(Boot.schedule("leave", "admin", false, { fromAdmin: false, offset: 100 }).idleDelay > left(100));
});

test("the trip resumes from the frame the last page stopped on, not from now", () => {
  const at = 10_000; // the click
  // The old page drew until this page's response started: 150ms of the trip.
  assert.equal(Boot.resumeOffset(at, 10_020, 130), 150);
  // No timing to go on: fall back to when this navigation began.
  assert.equal(Boot.resumeOffset(at, 10_090, 0), 90);
  // Clocks disagreeing, or a handoff kept far too long, cannot rewind it.
  assert.equal(Boot.resumeOffset(at, 9_000, 0), 0);
  assert.equal(Boot.resumeOffset(at, 10_000, 99_000), 10_000);
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

test("a leave handoff carries the brand it lifted off, or nothing at all", () => {
  const now = 1_000_000;
  const rects = {
    plate: { left: 22, top: 23, width: 32, height: 32 },
    word: { left: 61.65, top: 28.75, width: 52.63, height: 20.49 },
    tag: { left: 120, top: 24, width: 54, height: 20 },
  };
  const write = (fields) =>
    JSON.stringify({ v: 1, kind: "leave", to: "/admin", variant: "admin", fromAdmin: true, at: now - 300, rects, ...fields });
  const at = (pathname) => ({ now, pathname });

  const carried = Boot.parseHandoff(write(), false, at("/admin/analytics"));
  assert.equal(carried.kind, "leave");
  assert.equal(carried.fromAdmin, true);
  assert.deepEqual(carried.rects, rects);

  // Nothing to lift off from: the logo grows where it stands instead.
  assert.equal(Boot.parseHandoff(write({ rects: null }), false, at("/admin")).rects, null);
  assert.equal(Boot.parseHandoff(write({ rects: { plate: rects.plate } }), false, at("/admin")).rects, null);
  assert.equal(
    Boot.parseHandoff(write({ rects: { plate: rects.plate, word: { left: 0, top: 0, width: 0, height: 0 } } }), false, at("/admin")).rects,
    null
  );
  // An optional part missing is just that part missing.
  assert.equal(Boot.parseHandoff(write({ rects: { plate: rects.plate, word: rects.word } }), false, at("/admin")).rects.tag, null);

  assert.equal(Boot.parseHandoff(write(), false, at("/")), null, "another page");
  assert.equal(Boot.parseHandoff(write({ at: now - 30_000 }), false, at("/admin")), null, "stale");
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
