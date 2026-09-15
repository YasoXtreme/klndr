// Motion scenes are pure functions of the frame. These tests hold them to it:
// the same frame draws the same way every time, and the frame after the last one
// draws exactly what frame 0 does, so a loop never jumps.
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

const SIZES = [
  [1200, 600],
  [1200, 675],
  [1200, 400],
  [1200, 1200],
];

for (const theme of ["light", "dark"]) {
  const palette = Core.readTheme(theme);

  for (const scene of Scenes.list()) {
    const props = Scenes.sanitizeProps(scene.id, {});

    test(`${scene.id} (${theme}): the same frame draws the same way twice`, () => {
      for (const frame of [0, scene.stillFrame, Math.floor(scene.durationInFrames * 0.8)]) {
        const a = recordingContext();
        const b = recordingContext();
        Scenes.render(a, scene.id, frame, props, { width: 1200, height: 600, theme: palette });
        Scenes.render(b, scene.id, frame, props, { width: 1200, height: 600, theme: palette });
        assert.deepEqual(a.log, b.log);
      }
    });

    test(`${scene.id} (${theme}): loops without a seam at every aspect`, () => {
      for (const [width, height] of SIZES) {
        const start = recordingContext();
        const wrap = recordingContext();
        Scenes.render(start, scene.id, 0, props, { width, height, theme: palette });
        Scenes.render(wrap, scene.id, scene.durationInFrames, props, { width, height, theme: palette });
        assert.deepEqual(wrap.log, start.log);
      }
    });

    // A seamless loop is trivially true of a scene that draws nothing, so check
    // the representative frame is busy. (Not "busier than frame 0": the ticker
    // scrolls from its very first frame, by design.)
    test(`${scene.id} (${theme}): actually draws something mid-loop`, () => {
      const ctx = recordingContext();
      Scenes.render(ctx, scene.id, scene.stillFrame, props, { width: 1200, height: 600, theme: palette });
      const marks = ctx.log.filter(([call]) => call === "fillText" || call === "fill").length;
      assert.ok(marks >= 6, `${scene.id} drew only ${marks} marks at frame ${scene.stillFrame}`);
    });

    // The least a scene can be handed - empty words, one-item lists - is where
    // a layout divides by nothing or runs out of things to lay out.
    test(`${scene.id} (${theme}): copes with the least it can be given`, () => {
      const least = Scenes.sanitizeProps(
        scene.id,
        Object.fromEntries(scene.schema.map((f) => [
          f.key,
          f.type === "list" ? f.default.slice(0, 1) : f.type === "text" ? "" : f.default,
        ]))
      );
      for (const [width, height] of SIZES) {
        const start = recordingContext();
        const wrap = recordingContext();
        Scenes.render(start, scene.id, 0, least, { width, height, theme: palette });
        Scenes.render(wrap, scene.id, scene.durationInFrames, least, { width, height, theme: palette });
        assert.deepEqual(wrap.log, start.log);

        const still = recordingContext();
        Scenes.render(still, scene.id, scene.stillFrame, least, { width, height, theme: palette });
        assert.ok(!still.log.flat().some((value) => Number.isNaN(value)), `${scene.id} drew NaN at ${width}x${height}`);
      }
    });
  }
}

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
