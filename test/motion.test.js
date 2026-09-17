// Motion scenes are pure functions of their clock. These tests hold them to it:
// the same moment draws the same way every time; a scene starts on an empty
// stage, and its out ends on that same empty stage however long it idled; the
// in has really finished by the time the scene says it has; and the idle that
// follows never stands still.
//
// Drawing is recorded against a fake 2D context rather than compared as pixels,
// which keeps the test free of a canvas implementation.

const test = require("node:test");
const assert = require("node:assert/strict");

const Core = require("../protected/js/motion/motion-core");
const Scenes = require("../protected/js/motion/scenes");

function round(value) {
  if (typeof value !== "number") return value;
  const r = Math.round(value * 1000) / 1000;
  return r === 0 ? 0 : r;
}

function recordingContext() {
  const log = [];
  const state = { globalAlpha: 1, font: "10px sans-serif" };
  return new Proxy(state, {
    get(target, prop) {
      if (prop === "log") return log;
      if (prop === "measureText") {
        return (text) => {
          const size = parseFloat((/(\d+(?:\.\d+)?)px/.exec(target.font) || [])[1]) || 10;
          return { width: String(text).length * size * 0.55 };
        };
      }
      if (prop in target) return target[prop];
      return (...args) => log.push([prop, ...args.map(round)]);
    },
    set(target, prop, value) {
      target[prop] = value;
      log.push(["=", prop, round(value)]);
      return true;
    },
  });
}

// "Arrived" is not "exactly still": a spring at rest is 1.0004, not 1, and asks
// for a scale(1.0004) that a perfect 1 would skip. So two poses are compared
// with a tolerance - two pixels, or 0.03 of a unit-sized value such as a scale
// or an alpha, though any translate is a move in pixels - and a transform next
// to nothing, drawn on one side only, is passed over.
function nearNothing([call, ...args]) {
  if (call === "scale") return Math.abs(args[0] - 1) <= 0.05 && Math.abs(args[1] - 1) <= 0.05;
  if (call === "rotate") return Math.abs(args[0]) <= 0.02;
  return false;
}

function colour(value) {
  if (typeof value !== "string") return null;
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = /^rgba\(([^)]+)\)$/.exec(value);
  return rgba ? rgba[1].split(",").map(Number) : null;
}

function alike(x, y, pixels = false) {
  if (typeof x === "number" && typeof y === "number") {
    return Math.abs(x - y) <= (!pixels && Math.abs(x) < 2 && Math.abs(y) < 2 ? 0.03 : 2);
  }
  const cx = colour(x);
  const cy = colour(y);
  if (cx && cy) return cx.length === cy.length && cx.every((v, i) => Math.abs(v - cy[i]) <= (i === 3 ? 0.03 : 4));
  if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((v, i) => alike(v, y[i]));
  return x === y;
}

function assertSamePose(a, b, message) {
  const sameCall = (x, y) => x[0] === y[0] && (x[0] !== "=" || x[1] === y[1]);
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = a[i];
    const y = b[j];
    if (x && y && sameCall(x, y)) {
      const same = x.length === y.length && x.every((v, k) => alike(v, y[k], x[0] === "translate"));
      assert.ok(same, `${message}: call ${i} ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
      i += 1;
      j += 1;
    } else if (x && nearNothing(x)) {
      i += 1;
    } else if (y && nearNothing(y)) {
      j += 1;
    } else {
      assert.fail(`${message}: call ${i} ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
    }
  }
}

const SIZES = [
  [1200, 600],
  [1200, 675],
  [1200, 400],
  [1200, 1200],
];

const PAINTS = new Set(["fill", "stroke", "fillText", "fillRect"]);

// The least a scene can be handed - empty words, one-item lists - is where a
// layout divides by nothing or runs out of things to lay out.
function leastProps(scene) {
  return Scenes.sanitizeProps(
    scene.id,
    Object.fromEntries(scene.schema.map((f) => [
      f.key,
      f.type === "list" ? f.default.slice(0, 1) : f.type === "text" ? "" : f.default,
    ]))
  );
}

for (const theme of ["light", "dark"]) {
  const palette = Core.readTheme(theme);

  for (const scene of Scenes.list()) {
    const variants = [
      ["default props", Scenes.sanitizeProps(scene.id, {})],
      ["the least props", leastProps(scene)],
    ];

    const draw = (props, clock, size = SIZES[0], full = true) => {
      const ctx = recordingContext();
      const [width, height] = size;
      (full ? Scenes.render : Scenes.renderContent)(ctx, scene.id, clock, props, { width, height, theme: palette });
      return ctx.log;
    };

    test(`${scene.id} (${theme}): the same moment draws the same way twice`, () => {
      for (const [, props] of variants) {
        const { intro, outro } = Scenes.timing(scene.id, props);
        for (const clock of [{ t: 0 }, { t: intro / 2 }, { t: intro }, { t: intro + 45 }, { t: intro + 30 + outro / 2, exit: outro / 2 }]) {
          assert.deepEqual(draw(props, clock), draw(props, clock));
        }
      }
    });

    test(`${scene.id} (${theme}): starts on an empty stage`, () => {
      for (const [label, props] of variants) {
        for (const size of SIZES) {
          const paints = draw(props, { t: 0 }, size, false).filter(([call]) => PAINTS.has(call)).length;
          assert.equal(paints, 0, `${label} at ${size.join("x")} painted ${paints} marks on frame 0`);
        }
      }
    });

    // The out has to clear the stage whenever it starts: straight after the in,
    // or after a long idle when every wave and drift is somewhere else.
    test(`${scene.id} (${theme}): ends its out on that empty stage after any idle`, () => {
      for (const [label, props] of variants) {
        const { intro, outro } = Scenes.timing(scene.id, props);
        for (const size of SIZES) {
          const start = draw(props, { t: 0 }, size);
          for (const hold of [0, 15, 61, 300]) {
            const end = draw(props, { t: intro + hold + outro, exit: outro }, size);
            assert.deepEqual(end, start, `${label} at ${size.join("x")} after ${hold} frames of idle`);
          }
        }
      }
    });

    test(`${scene.id} (${theme}): the out starts from exactly what idle was drawing`, () => {
      for (const [label, props] of variants) {
        const { intro } = Scenes.timing(scene.id, props);
        for (const t of [intro, intro + 17, intro + 400]) {
          assertSamePose(draw(props, { t, exit: 0 }), draw(props, { t, exit: 0.02 }), `${label} at t=${t}`);
        }
      }
    });

    // With idle motion turned off, nothing should still be arriving once the
    // intro is over - otherwise the progress bar fills before the scene has.
    test(`${scene.id} (${theme}): has arrived by the end of its intro`, () => {
      for (const [label, props] of variants) {
        const { intro } = Scenes.timing(scene.id, props);
        assertSamePose(
          draw(props, { t: intro, ambient: 0 }),
          draw(props, { t: intro + 90, ambient: 0 }),
          `${label}, intro ${intro}`
        );
      }
    });

    test(`${scene.id} (${theme}): keeps moving while idle`, () => {
      for (const [label, props] of variants) {
        const { intro } = Scenes.timing(scene.id, props);
        assert.notDeepEqual(draw(props, { t: intro + 10 }), draw(props, { t: intro + 40 }), `${label} stood still`);
      }
    });

    // An empty stage passes every test above, so check the rest pose - what a
    // thumbnail shows - is busy.
    test(`${scene.id} (${theme}): has a busy rest pose`, () => {
      const [, props] = variants[0];
      const { intro } = Scenes.timing(scene.id, props);
      const marks = draw(props, { t: intro, ambient: 0 }).filter(([call]) => call === "fillText" || call === "fill").length;
      assert.ok(marks >= 6, `${scene.id} drew only ${marks} marks at rest`);
    });

    test(`${scene.id} (${theme}): never draws NaN`, () => {
      for (const [label, props] of variants) {
        const { intro, outro } = Scenes.timing(scene.id, props);
        for (const size of SIZES) {
          for (const clock of [{ t: intro / 3 }, { t: intro, ambient: 0 }, { t: intro + 200 }, { t: intro + 60 + outro / 2, exit: outro / 2 }]) {
            const nan = draw(props, clock, size).flat(2).some((value) => Number.isNaN(value));
            assert.ok(!nan, `${label} drew NaN at ${size.join("x")}, ${JSON.stringify(clock)}`);
          }
        }
      }
    });
  }
}

test("every scene says how long it takes to arrive and to leave", () => {
  for (const scene of Scenes.list()) {
    assert.ok(Number.isInteger(scene.intro) && scene.intro >= 1 && scene.intro <= 180, `${scene.id} intro ${scene.intro}`);
    assert.equal(scene.outro, Scenes.OUTRO);
  }
  assert.equal(Scenes.OUTRO, 18);
  // Some intros depend on how much there is to show.
  assert.ok(
    Scenes.timing("checklist", { items: ["One"] }).intro < Scenes.timing("checklist", {}).intro,
    "a one-item checklist arrives sooner"
  );
  assert.equal(Scenes.timing("nope", {}), null);
});

test("scene props are cleaned to their schema", () => {
  const props = Scenes.sanitizeProps("sticker-burst", {
    headline: "   lots   of    space   ",
    emojis: ["🎉", "", 42, "✨", "a", "b", "c", "d", "e"],
    accent: "not a colour",
    background: "",
    unknown: "dropped",
  });
  assert.equal(props.headline, "lots of space");
  assert.deepEqual(props.emojis, ["🎉", "✨", "a", "b", "c", "d"]);
  assert.equal(props.accent, "#d985f5");
  assert.equal(props.background, "");
  assert.ok(!("unknown" in props));
  assert.deepEqual(Scenes.sanitizeProps("nope", {}), {});
  assert.equal(Scenes.describe("stamp", { label: "v2", sublabel: "Out now" }), "v2: Out now");
});

test("a scene's ground is its own background, or the theme's", () => {
  const light = Core.readTheme("light");
  assert.equal(Scenes.ground("stamp", Scenes.sanitizeProps("stamp", {}), light), light.ground);
  assert.equal(Scenes.ground("checklist", Scenes.sanitizeProps("checklist", {}), light), light.mint);
  assert.equal(Scenes.ground("stamp", Scenes.sanitizeProps("stamp", { background: "#3ba4f6" }), light), "#3ba4f6");
});

test("spring starts at rest, overshoots when underdamped, and settles", () => {
  assert.equal(Core.spring({ frame: 0 }), 0);
  const samples = Array.from({ length: 60 }, (_, frame) => Core.spring({ frame, config: { damping: 8 } }));
  assert.ok(Math.max(...samples) > 1.05);
  assert.ok(Math.abs(Core.spring({ frame: 300 }) - 1) < 1e-3);
  assert.ok(Core.spring({ frame: 20, config: { damping: 8, overshootClamping: true } }) <= 1);
  // Critically and over-damped springs never pass their target.
  for (const damping of [20, 60]) {
    const values = Array.from({ length: 90 }, (_, frame) => Core.spring({ frame, config: { damping } }));
    assert.ok(values.every((v) => v <= 1 + 1e-9), `damping ${damping}`);
  }
});

test("idle helpers start from rest", () => {
  assert.equal(Core.rampIn(0, 24), 0);
  assert.equal(Core.rampIn(24, 24), 1);
  assert.equal(Core.rampIn(400, 24), 1);
  assert.equal(Core.swell(0, 70), 0);
  assert.ok(Math.abs(Core.swell(35, 70) - 1) < 1e-9);
  assert.ok(Math.abs(Core.wave(90, 90) - Core.wave(0, 90)) < 1e-9);
  assert.deepEqual(Core.beat(160, 75), { index: 2, local: 10 });
  assert.equal(Core.outOf({ exit: 0 }, 0, 10), 0);
  assert.equal(Core.outOf({ exit: 5 }, 0, 10), 0.5);
  assert.equal(Core.outOf({ exit: 50 }, 0, 10), 1);
});

// A box fading in or out would otherwise show its own slab through its fill, a
// grey smudge across the whole box.
test("a fading box keeps its slab from showing through it", () => {
  const calls = (alpha) => {
    const ctx = recordingContext();
    ctx.globalAlpha = alpha;
    Core.slabBox(ctx, { x: 0, y: 0, w: 100, h: 50, fill: "#ffffff", line: "#000000" });
    return ctx.log.map(([call, arg]) => (call === "clip" ? `clip:${arg}` : call));
  };
  assert.ok(!calls(1).includes("clip:evenodd"), "an opaque box hides its slab by itself");
  const fading = calls(0.5);
  assert.ok(fading.includes("clip:evenodd"), "a fading box clips its slab to where it shows past the box");
  assert.ok(fading.indexOf("clip:evenodd") < fading.indexOf("fill"));
});

test("interpolate clamps and walks multiple segments", () => {
  assert.equal(Core.interpolate(-5, [0, 10], [0, 100]), 0);
  assert.equal(Core.interpolate(15, [0, 10], [0, 100]), 100);
  assert.equal(Core.interpolate(15, [0, 10], [0, 100], { extrapolateRight: "extend" }), 150);
  assert.equal(Core.interpolate(15, [0, 10, 20], [0, 100, 0]), 50);
  assert.equal(Core.interpolate(5, [0, 10], [0, 100], { easing: Core.Easing.quad }), 25);
});

test("random is seeded", () => {
  const a = Core.random("klndr");
  const b = Core.random("klndr");
  const sequence = Array.from({ length: 5 }, () => a());
  assert.deepEqual(Array.from({ length: 5 }, () => b()), sequence);
  assert.ok(sequence.every((n) => n >= 0 && n < 1));
  assert.notDeepEqual(Array.from({ length: 5 }, Core.random("other")), sequence);
});

test("category colours are mixed toward the ground in the dark, as app.css does", () => {
  const light = Core.readTheme("light");
  const dark = Core.readTheme("dark");
  assert.equal(Core.taskFill("#3ba4f6", light), "#3ba4f6");
  assert.equal(Core.taskFill("#3ba4f6", dark), Core.mix("#3ba4f6", "#14140f", 0.88));
});
