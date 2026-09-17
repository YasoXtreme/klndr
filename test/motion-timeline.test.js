// The motion timeline decides what plays when: which clip is on screen, where its
// clock stands, where the camera is between clips, and how full the progress bar
// is. The player, the Studio and the Remotion render all ask it, so its
// arithmetic is pinned down here.

const test = require("node:test");
const assert = require("node:assert/strict");

const Core = require("../protected/js/motion/motion-core");
const Scenes = require("../protected/js/motion/scenes");
const Timeline = require("../protected/js/motion/motion-timeline");

const FPS = Timeline.FPS;
const OUTRO = Scenes.OUTRO;
const { EARLY, MOVE, LAND } = Timeline;

function introOf(id, props = {}) {
  return Scenes.timing(id, props).intro;
}

// A recording 2D context that keeps just the calls, for comparing and counting
// what was drawn.
function recorder() {
  const calls = [];
  const ctx = new Proxy({ globalAlpha: 1, font: "10px sans-serif" }, {
    get(target, prop) {
      if (prop === "calls") return calls;
      if (prop === "measureText") return (text) => ({ width: String(text).length * 10 });
      if (prop in target) return target[prop];
      return (...args) => calls.push([prop, ...args.map((v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v))]);
    },
    set(target, prop, value) {
      target[prop] = value;
      calls.push(["=", prop, typeof value === "number" ? Math.round(value * 1000) / 1000 : value]);
      return true;
    },
  });
  return ctx;
}

const PAINTS = new Set(["fill", "fillText", "stroke", "fillRect"]);
const paintsOf = (ctx) => ctx.calls.filter(([call]) => PAINTS.has(call)).map(([call]) => call);
const SIZE = { width: 1200, height: 600 };

function drawn(plan, T) {
  const ctx = recorder();
  Timeline.render(ctx, plan, T, SIZE);
  return ctx.calls;
}

// ==========================================
// SHAPE
// ==========================================

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

test("describing the animation reads every clip in order", () => {
  const scene = {
    clips: [
      { id: "stamp", props: { label: "v2", sublabel: "Out now" } },
      { id: "ticker", props: { headline: "Everything is faster" } },
    ],
  };
  assert.equal(Timeline.describe(scene), "v2: Out now, then Everything is faster");
});

// ==========================================
// ONE CLIP
// ==========================================

test("a looping clip plans in, idle, out", () => {
  const intro = introOf("stamp");
  const plan = Timeline.plan({ loop: true, clips: [{ id: "stamp", hold: 2.5 }] });
  const [clip] = plan.clips;
  assert.equal(plan.travels, false);
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

test("a looping clip idles, leaves, and comes round again on an empty stage", () => {
  const plan = Timeline.plan({ loop: true, clips: [{ id: "stamp", props: { background: "#3ba4f6" }, hold: 1 }] });
  const { outStart, end } = plan.clips[0];

  assert.deepEqual(Timeline.at(plan, 0).clock, { t: 0, exit: 0 });
  assert.deepEqual(Timeline.at(plan, outStart - 1).clock, { t: outStart - 1, exit: 0 });
  assert.deepEqual(Timeline.at(plan, outStart).clock, { t: outStart, exit: 0 });
  assert.deepEqual(Timeline.at(plan, outStart + 1).clock, { t: outStart + 1, exit: 1 });

  // The frame after the last is the first again, on every pass - and with
  // nowhere to travel, no camera ever moves.
  assert.deepEqual(Timeline.at(plan, end).clock, { t: 0, exit: 0 });
  assert.deepEqual(Timeline.at(plan, end * 5 + 7).clock, { t: 7, exit: 0 });
  for (let T = 0; T < end * 2; T += 3) assert.equal(Timeline.at(plan, T).camera, null);

  // The last frame of the out, and the first of the next pass: only the ground.
  assert.equal(Timeline.at(plan, end - 1).clock.exit, OUTRO - 1);
  const ctx = recorder();
  Timeline.render(ctx, plan, end, SIZE);
  assert.deepEqual(paintsOf(ctx), ["fillRect", "stroke"]);

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
  assert.deepEqual(later.clock, { t: 1e7, exit: 0 });
  assert.equal(later.position, intro);
  assert.equal(later.progress, 1);
  assert.equal(later.settled, true);
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
  const frame = Timeline.render(ctx, plan, 0, SIZE);
  assert.equal(frame.layers.length, 1);
  assert.deepEqual(calls.slice(0, 2), [["fillStyle", "#3ba4f6"], ["fillRect", 0, 0, 1200, 600]]);
});

// ==========================================
// A RUN OF CLIPS
// ==========================================

const RUN = [
  { id: "stamp", props: { background: "#3ba4f6" }, hold: 1 },
  { id: "chat", props: {}, hold: 0 },
  { id: "ticker", props: {}, hold: 2.5 },
  { id: "keycaps", props: {}, hold: 0.5 },
];

test("clips hand over with one camera move, the next arriving while it travels", () => {
  const plan = Timeline.plan({ loop: true, clips: RUN });
  assert.equal(plan.travels, true);

  plan.clips.forEach((clip, i) => {
    // The camera sets off just before the out - but never before the clip has
    // arrived, when there is no idle to take it from.
    assert.equal(clip.leave, Math.max(clip.start + clip.intro, clip.outStart - EARLY), `clip ${i} leaves`);
    const next = plan.clips[i + 1];
    if (next) {
      assert.equal(next.start, clip.leave + LAND, `clip ${i + 1} starts ${LAND} frames into the move`);
      assert.equal(next.enter, clip.leave);
    }
  });
  assert.equal(plan.clips[1].leave, plan.clips[1].outStart, "no idle, no head start");
  assert.equal(plan.cycle, plan.clips[3].leave + LAND);

  const [a, b] = plan.clips;
  // Before the move: A alone, full-bleed.
  const before = Timeline.at(plan, a.leave);
  assert.equal(before.camera, null);
  assert.deepEqual(before.layers.map((l) => [l.index, l.offset]), [[0, 0]]);

  // In the move: A sliding off, B sliding on, clocks running on from where
  // they were.
  let travelled = 0;
  for (let since = 1; since < MOVE; since++) {
    const frame = Timeline.at(plan, a.leave + since);
    assert.ok(frame.camera, `a camera at ${since}`);
    assert.ok(frame.camera.travel > travelled, "the camera only ever goes forwards");
    travelled = frame.camera.travel;
    const [leaving, arriving] = frame.layers;
    assert.equal(leaving.index, 0);
    assert.equal(arriving.index, 1);
    assert.equal(leaving.offset, -frame.camera.travel);
    assert.equal(arriving.offset, 1 - frame.camera.travel);
    assert.equal(leaving.clock.t, a.leave + since);
    assert.equal(leaving.clock.exit, Math.max(0, a.leave + since - a.outStart));
    assert.equal(arriving.clock.t, since - LAND);
    assert.equal(frame.index, since < LAND ? 0 : 1, "the stage passes to B as it starts");
  }

  // Set down: B alone.
  const after = Timeline.at(plan, a.leave + MOVE);
  assert.equal(after.camera, null);
  assert.deepEqual(after.layers.map((l) => [l.index, l.offset]), [[1, 0]]);
  assert.deepEqual(after.clock, { t: MOVE - LAND, exit: 0 });
  assert.equal(Timeline.at(plan, b.start + b.intro + 60).layers[0].shift, 0, "and at rest, long before its out");
});

test("the camera sets off and sets down without a jolt", () => {
  const plan = Timeline.plan({ loop: true, clips: RUN });
  const { leave } = plan.clips[2];
  const step = 1e-3;
  const edges = [
    [Timeline.at(plan, leave + step), 0],
    [Timeline.at(plan, leave + MOVE - step), 1],
  ];
  for (const [frame, rest] of edges) {
    assert.ok(Math.abs(frame.camera.travel - rest) < 1e-5, `travel ${frame.camera.travel} near ${rest}`);
    assert.ok(frame.camera.lift < 1e-3, `lift ${frame.camera.lift}`);
  }
  // What the panels carry moves with them, never leaping ahead or behind.
  let last = null;
  for (let T = leave; T <= leave + MOVE + 30; T += 0.25) {
    const layer = Timeline.at(plan, T).layers.find((l) => l.index === 3);
    if (!layer) continue;
    const x = layer.offset * 1260 + layer.shift;
    if (last !== null) assert.ok(Math.abs(x - last) < 50, `jumped ${x - last}px at ${T}`);
    last = x;
  }
  assert.ok(Math.abs(Timeline.at(plan, leave + MOVE - step).layers[1].shift - Timeline.at(plan, leave + MOVE).layers[0].shift) < 0.05);
});

test("once the animation has begun, something is always on screen", () => {
  for (const loop of [true, false]) {
    const plan = Timeline.plan({ loop, clips: RUN });
    const until = loop ? plan.cycle * 2 + 40 : plan.settle + 60;
    let begun = false;
    for (let T = 0; T <= until; T++) {
      const frame = Timeline.at(plan, T);
      const showing = frame.layers.some((layer) => {
        if (Math.abs(layer.offset) > 0.9 || layer.clock.t < 0) return false;
        const ctx = recorder();
        Scenes.renderContent(ctx, layer.id, layer.clock, plan.clips[layer.index].props, { ...SIZE, flow: layer.flow });
        return paintsOf(ctx).length > 0;
      });
      if (showing) begun = true;
      else assert.ok(!begun, `${loop ? "loop" : "once"}: nothing on screen at frame ${T}`);
    }
    assert.ok(begun);
  }
});

test("the first pass opens on an empty stage, and every pass after comes in from the last clip", () => {
  const plan = Timeline.plan({ loop: true, clips: RUN });
  const ctx = recorder();
  Timeline.render(ctx, plan, 0, SIZE);
  assert.deepEqual(paintsOf(ctx), ["fillRect", "stroke"]);
  for (let T = 0; T < MOVE; T++) assert.equal(Timeline.at(plan, T).camera, null, `no move into the first pass at ${T}`);

  const wrap = Timeline.at(plan, plan.cycle + 3);
  assert.ok(wrap.camera);
  assert.deepEqual(wrap.layers.map((l) => l.index), [3, 0]);

  // Every pass after the first draws the same, the move back included.
  const last = plan.clips[3];
  for (const T of [last.leave - 2, last.leave + 3, plan.cycle - 1, plan.cycle, plan.cycle + 5, plan.cycle + MOVE, plan.cycle + 200]) {
    assert.deepEqual(drawn(plan, T + plan.cycle), drawn(plan, T + 2 * plan.cycle), `pass 2 and 3 differ at ${T}`);
  }
});

test("between moves, a clip in a run draws exactly as it does on its own", () => {
  for (const { id } of Scenes.list()) {
    const clips = [{ id: "stamp", props: {}, hold: 0 }, { id, props: {}, hold: 3 }, { id: "chat", props: {}, hold: 0 }];
    const plan = Timeline.plan({ loop: true, clips });
    const clip = plan.clips[1];
    for (const t of [clip.intro + 20, clip.intro + 45, clip.intro + 80]) {
      const alone = recorder();
      Scenes.render(alone, id, { t }, clip.props, { ...SIZE, theme: Core.readTheme("light") });
      assert.deepEqual(drawn(plan, clip.start + t), alone.calls, `${id} at t=${t}`);
    }
  }
});

test("a header that plays once never leaves its last clip, whatever came before", () => {
  const plan = Timeline.plan({ loop: false, clips: [{ id: "chat" }, { id: "stamp", hold: 0 }, { id: "flip-board" }] });
  const last = plan.clips[2];
  assert.equal(Timeline.at(plan, last.start + 3).layers.length, 2, "it travels in like any other");
  for (const T of [last.start + last.intro, last.start + last.intro + 1000, 1e7]) {
    const frame = Timeline.at(plan, T);
    assert.equal(frame.index, 2);
    assert.equal(frame.clock.exit, 0);
    assert.equal(frame.camera, null);
    assert.deepEqual(frame.layers.map((l) => l.id), ["flip-board"]);
    assert.equal(frame.progress, 1);
  }
  // The bar reaches the end exactly when the last clip has arrived.
  assert.ok(Timeline.at(plan, last.start + last.intro - 1).progress < 1);
});

// ==========================================
// EDITING AND VIDEO
// ==========================================

test("editing a run of clips keeps the preview on a clip that still exists", () => {
  const three = Timeline.plan({ loop: true, clips: [{ id: "stamp" }, { id: "chat" }, { id: "ticker" }] });
  const inTicker = three.clips[2].start + 10;

  // The ticker was removed: the preview lands on what is now the last clip.
  const two = Timeline.plan({ loop: true, clips: [{ id: "stamp" }, { id: "chat" }] });
  assert.equal(Timeline.at(two, Timeline.reanchor(three, two, inTicker)).index, 1);

  // Props changed in the clip that is playing: same clip, same moment - and a
  // camera caught mid-move is still exactly as far along.
  const edited = Timeline.plan({ loop: true, clips: [{ id: "stamp" }, { id: "chat" }, { id: "ticker", props: { headline: "New words" } }] });
  assert.equal(Timeline.reanchor(three, edited, inTicker), edited.clips[2].start + 10);
  const moving = three.clips[2].start + 4;
  const moved = Timeline.at(edited, Timeline.reanchor(three, edited, moving));
  assert.equal(moved.camera.travel, Timeline.at(three, moving).camera.travel);
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
  assert.equal(Timeline.videoStart(loop), 0);
  const once = Timeline.plan({ loop: false, clips: [{ id: "stamp", hold: 2 }] });
  assert.equal(Timeline.videoLength(once, 3), once.settle + 3 * FPS);
  assert.equal(Timeline.videoLength(Timeline.plan(null)), 1);
});

test("a video of a looping run of clips repeats without a seam", () => {
  const plan = Timeline.plan({ loop: true, clips: RUN });
  const start = Timeline.videoStart(plan);
  const length = Timeline.videoLength(plan);
  assert.equal(start, plan.cycle);
  // The frame after the file's last is its first again.
  assert.deepEqual(drawn(plan, start + length), drawn(plan, start));
  assert.equal(Timeline.videoStart(Timeline.plan({ loop: false, clips: RUN })), 0);
});
