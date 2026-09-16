// The motion timeline decides what plays when: which clip is on screen, where its
// clock stands, and how full the progress bar is. The player, the Studio and the
// Remotion render all ask it, so its arithmetic is pinned down here.

const test = require("node:test");
const assert = require("node:assert/strict");

const Scenes = require("../protected/js/motion/scenes");
const Timeline = require("../protected/js/motion/motion-timeline");

const FPS = Timeline.FPS;
const OUTRO = Scenes.OUTRO;

function introOf(id, props = {}) {
  return Scenes.timing(id, props).intro;
}

test("a header saved before clips existed reads as one looping clip", () => {
  const scene = Timeline.normalize({ id: "stamp", props: { label: "v2", junk: true } });
  assert.deepEqual(Object.keys(scene), ["loop", "clips"]);
  assert.equal(scene.loop, true);
  assert.equal(scene.clips.length, 1);
  assert.deepEqual(Object.keys(scene.clips[0]), ["id", "props", "hold"]);
  assert.equal(scene.clips[0].id, "stamp");
  assert.equal(scene.clips[0].props.label, "v2");
  assert.ok(!("junk" in scene.clips[0].props));
  assert.equal(scene.clips[0].hold, Timeline.HOLD_DEFAULT);
});

test("normalizing keeps what is playable and nothing else", () => {
  const clips = [
    { id: "stamp", hold: 1.26 },
    { id: "nope", hold: 1 },
    null,
    { id: "chat", hold: -3 },
    { id: "ticker", hold: 99 },
    { id: "checklist", hold: "soon" },
    { id: "keycaps", hold: null },
    { id: "flip-board", hold: 4 },
    { id: "pop-reveal", hold: 0 },
  ];
  const scene = Timeline.normalize({ loop: false, clips });
  assert.equal(scene.loop, false);
  assert.deepEqual(scene.clips.map((c) => c.id), ["stamp", "chat", "ticker", "checklist", "keycaps", "flip-board"]);
  assert.deepEqual(scene.clips.map((c) => c.hold), [1.5, 0, 10, 2, 2, 4]);
  assert.equal(Timeline.normalize({ loop: "no", clips: [{ id: "stamp" }] }).loop, true);
  assert.deepEqual(Timeline.normalize(null), { loop: true, clips: [] });
  assert.deepEqual(Timeline.normalize({ clips: "stamp" }).clips, []);
});

test("normalizing is idempotent", () => {
  const once = Timeline.normalize({ loop: false, clips: [{ id: "chat", props: { messages: ["Hi"] }, hold: 3 }] });
  assert.deepEqual(Timeline.normalize(once), once);
  assert.equal(JSON.stringify(Timeline.normalize(once)), JSON.stringify(once));
});

test("a looping clip plans in, idle, out", () => {
  const intro = introOf("stamp");
  const plan = Timeline.plan({ loop: true, clips: [{ id: "stamp", hold: 2.5 }] });
  const [clip] = plan.clips;
  assert.equal(clip.start, 0);
  assert.equal(clip.intro, intro);
  assert.equal(clip.hold, 2.5 * FPS);
  assert.equal(clip.outStart, intro + 2.5 * FPS);
  assert.equal(clip.end, intro + 2.5 * FPS + OUTRO);
  assert.equal(plan.cycle, clip.end);
  assert.equal(plan.settle, intro);
  assert.equal(plan.length, plan.cycle);
  assert.equal(plan.still, intro);
});

test("a looping clip idles, leaves, and comes round again", () => {
  const plan = Timeline.plan({ loop: true, clips: [{ id: "stamp", hold: 1 }] });
  const { outStart, end } = plan.clips[0];

  assert.deepEqual(Timeline.at(plan, 0).layers[0].clock, { t: 0, exit: 0 });
  assert.deepEqual(Timeline.at(plan, outStart - 1).layers[0].clock, { t: outStart - 1, exit: 0 });
  assert.deepEqual(Timeline.at(plan, outStart).layers[0].clock, { t: outStart, exit: 0 });
  assert.deepEqual(Timeline.at(plan, outStart + 1).layers[0].clock, { t: outStart + 1, exit: 1 });

  // The frame after the last is the first again, on every pass.
  assert.deepEqual(Timeline.at(plan, end).layers[0].clock, { t: 0, exit: 0 });
  assert.deepEqual(Timeline.at(plan, end * 5 + 7).layers[0].clock, { t: 7, exit: 0 });

  assert.equal(Timeline.at(plan, 0).progress, 0);
  assert.equal(Timeline.at(plan, end - 1).progress, 1);
  assert.equal(Timeline.at(plan, end).progress, 0);
  assert.equal(Timeline.at(plan, 12).settled, false);
});

test("a clip that plays once fills the bar through its intro, then idles for good", () => {
  const intro = introOf("chat");
  const plan = Timeline.plan({ loop: false, clips: [{ id: "chat", hold: 1 }] });
  assert.equal(plan.length, intro);

  const half = Timeline.at(plan, intro / 2);
  assert.equal(half.progress, 0.5);
  assert.equal(half.settled, false);

  const later = Timeline.at(plan, 1e7);
  assert.deepEqual(later.layers[0].clock, { t: 1e7, exit: 0 });
  assert.equal(later.position, intro);
  assert.equal(later.progress, 1);
  assert.equal(later.settled, true);
});

test("clips play one after another", () => {
  const scene = {
    loop: true,
    clips: [
      { id: "stamp", hold: 1 },
      { id: "chat", hold: 0.5 },
      { id: "ticker", hold: 2 },
    ],
  };
  const plan = Timeline.plan(scene);
  const [a, b, c] = plan.clips;
  assert.equal(b.start, a.end);
  assert.equal(c.start, b.end);
  assert.equal(plan.cycle, c.end);

  assert.equal(Timeline.at(plan, a.end - 1).layers[0].id, "stamp");
  assert.deepEqual(Timeline.at(plan, a.end - 1).layers[0].clock, { t: a.end - 1, exit: OUTRO - 1 });
  assert.equal(Timeline.at(plan, b.start).layers[0].id, "chat");
  assert.deepEqual(Timeline.at(plan, b.start).layers[0].clock, { t: 0, exit: 0 });
  assert.equal(Timeline.at(plan, plan.cycle).layers[0].id, "stamp");

  const once = Timeline.plan({ ...scene, loop: false });
  assert.equal(once.settle, once.clips[2].start + once.clips[2].intro);
  assert.equal(Timeline.at(once, once.clips[1].end - 1).layers[0].clock.exit, OUTRO - 1);
  assert.equal(Timeline.at(once, once.settle + 5000).layers[0].id, "ticker");
  assert.equal(Timeline.at(once, once.settle + 5000).layers[0].clock.exit, 0);
});

// A recording 2D context that keeps just the calls, for counting what was drawn.
function recorder() {
  const calls = [];
  const ctx = new Proxy({ globalAlpha: 1, font: "10px sans-serif" }, {
    get(target, prop) {
      if (prop === "calls") return calls;
      if (prop === "measureText") return (text) => ({ width: String(text).length * 10 });
      if (prop in target) return target[prop];
      return (...args) => calls.push([prop, ...args]);
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
  return ctx;
}

const PAINTS = new Set(["fill", "fillText", "stroke", "fillRect"]);

test("every hand-over between clips happens on an empty stage", () => {
  const clips = [
    { id: "stamp", props: { background: "#3ba4f6" }, hold: 1 },
    { id: "chat", props: {}, hold: 0 },
    { id: "ticker", props: {}, hold: 2.5 },
    { id: "keycaps", props: {}, hold: 0.5 },
  ];
  for (const loop of [true, false]) {
    const plan = Timeline.plan({ loop, clips });
    const joins = plan.clips.slice(1).map((clip) => clip.start);
    // Looping, the last clip hands back to the first as well.
    if (loop) joins.push(plan.cycle);

    for (const join of joins) {
      const before = Timeline.at(plan, join - 1).layers[0];
      const after = Timeline.at(plan, join).layers[0];
      assert.equal(before.clock.exit, OUTRO - 1, `the frame before ${join} is the last of an out`);
      assert.deepEqual(after.clock, { t: 0, exit: 0 }, `frame ${join} is the first of an in`);
      assert.notEqual(before.index, after.index);

      // The incoming clip's first frame paints its ground and nothing else: one
      // fill of the canvas and one stroke of the grid.
      const ctx = recorder();
      Timeline.render(ctx, plan, join, { width: 1200, height: 600 });
      const paints = ctx.calls.filter(([call]) => PAINTS.has(call)).map(([call]) => call);
      assert.deepEqual(paints, ["fillRect", "stroke"], `${loop ? "loop" : "once"}: frame ${join} drew ${paints.join(", ")}`);
    }
  }
});

test("a header that plays once never leaves its last clip, whatever came before", () => {
  const plan = Timeline.plan({ loop: false, clips: [{ id: "chat" }, { id: "stamp", hold: 0 }, { id: "flip-board" }] });
  const last = plan.clips[2];
  for (const T of [last.start + last.intro, last.start + last.intro + 1000, 1e7]) {
    const frame = Timeline.at(plan, T);
    assert.equal(frame.layers[0].id, "flip-board");
    assert.equal(frame.layers[0].clock.exit, 0);
    assert.equal(frame.progress, 1);
  }
  // The bar reaches the end exactly when the last clip has arrived.
  assert.ok(Timeline.at(plan, last.start + last.intro - 1).progress < 1);
});

test("editing a run of clips keeps the preview on a clip that still exists", () => {
  const three = Timeline.plan({ loop: true, clips: [{ id: "stamp" }, { id: "chat" }, { id: "ticker" }] });
  const inTicker = three.clips[2].start + 10;

  // The ticker was removed: the preview lands on what is now the last clip.
  const two = Timeline.plan({ loop: true, clips: [{ id: "stamp" }, { id: "chat" }] });
  const landed = Timeline.at(two, Timeline.reanchor(three, two, inTicker)).layers[0];
  assert.equal(landed.index, 1);

  // Props changed in the clip that is playing: same clip, same moment.
  const edited = Timeline.plan({ loop: true, clips: [{ id: "stamp" }, { id: "chat" }, { id: "ticker", props: { headline: "New words" } }] });
  assert.equal(Timeline.reanchor(three, edited, inTicker), edited.clips[2].start + 10);
});

test("an edit keeps the preview where it was", () => {
  const before = Timeline.plan({ loop: true, clips: [{ id: "stamp", props: {}, hold: 4 }] });
  const intro = before.clips[0].intro;

  // Mid-intro: stays put.
  assert.equal(Timeline.reanchor(before, before, 10), 10);

  // Idling 30 frames in, the idle grows: still 30 frames in.
  const longer = Timeline.plan({ loop: true, clips: [{ id: "stamp", props: {}, hold: 8 }] });
  assert.equal(Timeline.reanchor(before, longer, intro + 30), intro + 30);

  // Idling 90 frames in, the idle shrinks to 1 second: the out starts now.
  const shorter = Timeline.plan({ loop: true, clips: [{ id: "stamp", props: {}, hold: 1 }] });
  assert.equal(Timeline.reanchor(before, shorter, intro + 90), intro + 30);

  // Halfway out, the idle changes: still halfway out.
  assert.equal(Timeline.reanchor(before, shorter, before.clips[0].outStart + 9), shorter.clips[0].outStart + 9);

  // Stopping the loop mid-idle keeps idling from the same place.
  const once = Timeline.plan({ loop: false, clips: [{ id: "stamp", props: {}, hold: 1 }] });
  assert.equal(Timeline.reanchor(before, once, intro + 90), intro + 90);

  // A different scene starts from its own beginning.
  const swapped = Timeline.plan({ loop: true, clips: [{ id: "chat", props: {}, hold: 4 }] });
  assert.equal(Timeline.reanchor(before, swapped, intro + 30), 0);

  // A loop past its first pass stays past it.
  assert.equal(Timeline.reanchor(before, longer, before.cycle + 10), longer.cycle + 10);
  assert.equal(Timeline.reanchor(null, longer, 10), 0);
});

test("a video runs one loop, or the way in and a tail of idle", () => {
  const loop = Timeline.plan({ loop: true, clips: [{ id: "stamp", hold: 2 }] });
  assert.equal(Timeline.videoLength(loop), loop.cycle);
  const once = Timeline.plan({ loop: false, clips: [{ id: "stamp", hold: 2 }] });
  assert.equal(Timeline.videoLength(once, 3), once.settle + 3 * FPS);
  assert.equal(Timeline.videoLength(Timeline.plan(null)), 1);
});

test("describing the animation reads every clip in order", () => {
  const scene = {
    clips: [
      { id: "stamp", props: { label: "v2", sublabel: "Out now" } },
      { id: "ticker", props: { headline: "Everything is faster" } },
    ],
  };
  assert.equal(Timeline.describe(scene), "v2: Out now, then Everything is faster");
});

test("rendering a frame paints the ground of the clip on screen", () => {
  const calls = [];
  const ctx = new Proxy({ globalAlpha: 1, font: "10px sans-serif" }, {
    get(target, prop) {
      if (prop === "measureText") return (text) => ({ width: String(text).length * 10 });
      if (prop in target) return target[prop];
      return (...args) => calls.push([prop, ...args]);
    },
    set(target, prop, value) {
      target[prop] = value;
      if (prop === "fillStyle") calls.push(["fillStyle", value]);
      return true;
    },
  });
  const plan = Timeline.plan({ loop: true, clips: [{ id: "stamp", props: { background: "#3ba4f6" } }] });
  const frame = Timeline.render(ctx, plan, 0, { width: 1200, height: 600 });
  assert.equal(frame.layers.length, 1);
  assert.deepEqual(calls.slice(0, 2), [["fillStyle", "#3ba4f6"], ["fillRect", 0, 0, 1200, 600]]);
});
