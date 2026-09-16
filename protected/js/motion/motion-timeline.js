// Klndr Motion Timeline
//
// What plays when. A header's motion is a run of clips - scenes, each with its
// own words and colours - that play one after another and then either loop or
// come to rest. This file turns that into frame numbers: when each clip starts,
// how long it idles, when it leaves, and for any frame of playback, which clip
// is on screen and where its clock stands.
//
// It is the one place that knows, so the player, the Studio's scrubber, the
// server, the tests and the Remotion render all agree frame for frame.
//
// Browser global and CommonJS module, like palette.js.

const KlndrMotionTimeline = (() => {
  const Scenes = typeof KlndrScenes !== 'undefined' ? KlndrScenes : require('./scenes');

  const FPS = Scenes.FPS;
  // Idle is set in seconds, on the Studio's slider.
  const HOLD_DEFAULT = 2;
  const HOLD_MAX = 10;
  const HOLD_STEP = 0.5;
  const MAX_CLIPS = 6;

  // ==========================================
  // SHAPE
  // ==========================================

  /** Seconds of idle, snapped to the slider's steps and kept in its range. */
  function cleanHold(value) {
    if (value == null || value === '') return HOLD_DEFAULT;
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return HOLD_DEFAULT;
    return Math.min(HOLD_MAX, Math.max(0, Math.round(seconds / HOLD_STEP) * HOLD_STEP));
  }

  /** The clips in a stored scene, whichever shape it was saved in. */
  function rawClips(scene) {
    if (!scene || typeof scene !== 'object') return [];
    if (Array.isArray(scene.clips)) return scene.clips;
    // Before clips, a header was a single scene: { id, props }.
    return scene.id ? [scene] : [];
  }

  /**
   * A header's motion in its one shape: { loop, clips: [{ id, props, hold }] }.
   *
   * Lenient on purpose - posts saved before clips existed, and the places that
   * build a scene inline, still read. Unknown scenes are dropped and props are
   * cleaned, so what comes out is always safe to play. A scene saved without a
   * loop setting loops, because every header did before there was a choice.
   */
  function normalize(scene) {
    const clips = rawClips(scene)
      .filter((clip) => clip && typeof clip === 'object' && Scenes.get(clip.id))
      .slice(0, MAX_CLIPS)
      .map((clip) => ({
        id: clip.id,
        props: Scenes.sanitizeProps(clip.id, clip.props),
        hold: cleanHold(clip.hold)
      }));
    return {
      loop: scene && typeof scene.loop === 'boolean' ? scene.loop : true,
      clips
    };
  }

  /** Words a screen reader can say in place of the whole animation. */
  function describe(scene) {
    return normalize(scene).clips
      .map((clip) => Scenes.describe(clip.id, clip.props))
      .filter(Boolean)
      .join(', then ');
  }

  // ==========================================
  // PLAN
  // ==========================================

  /**
   * When everything happens, in frames.
   *
   *   clips[i]  start, intro, hold, outStart and end of each clip
   *   cycle     one pass through every clip, in and out - what a loop repeats
   *   settle    the frame the last clip has fully arrived on: where a header
   *             that plays once stops moving forward
   *   length    what a progress bar or scrubber spans - the cycle when looping,
   *             otherwise the way to `settle`
   *   still     the frame thumbnails and reduced motion show: the first clip,
   *             arrived
   */
  function plan(scene) {
    const timeline = normalize(scene);
    const clips = [];
    let cursor = 0;
    timeline.clips.forEach((clip, index) => {
      const { intro, outro } = Scenes.timing(clip.id, clip.props);
      const hold = Math.round(clip.hold * FPS);
      const start = cursor;
      const outStart = start + intro + hold;
      clips.push({ index, id: clip.id, props: clip.props, intro, hold, outro, start, outStart, end: outStart + outro });
      cursor = outStart + outro;
    });
    const last = clips[clips.length - 1];
    const settle = last ? last.start + last.intro : 0;
    return {
      scene: timeline,
      loop: timeline.loop,
      clips,
      cycle: cursor,
      settle,
      length: timeline.loop ? cursor : settle,
      still: clips.length ? clips[0].intro : 0
    };
  }

  /**
   * Where playback stands on frame T - frames since it began, never wrapped:
   * which clip is on screen and its clock, and how full the progress bar is.
   */
  function at(plan, T) {
    const { clips } = plan;
    if (!clips.length) return { layers: [], position: 0, progress: 1, settled: true };

    const time = Math.max(0, Number(T) || 0);
    const tau = plan.loop ? (plan.cycle > 0 ? time % plan.cycle : 0) : time;
    const last = clips.length - 1;

    let index = last;
    for (let i = 0; i < clips.length; i++) {
      if (tau < clips[i].end) {
        index = i;
        break;
      }
    }
    // A header that plays once comes to rest on its last clip, and stays there.
    if (!plan.loop && tau >= clips[last].start) index = last;

    const clip = clips[index];
    const resting = !plan.loop && index === last;
    const position = plan.loop ? tau : Math.min(tau, plan.settle);
    const span = plan.loop ? plan.cycle - 1 : plan.settle;
    return {
      layers: [{
        index,
        id: clip.id,
        props: clip.props,
        clock: { t: tau - clip.start, exit: resting ? 0 : Math.max(0, tau - clip.outStart) }
      }],
      position,
      progress: span > 0 ? Math.min(1, position / span) : 1,
      settled: !plan.loop && tau >= plan.settle
    };
  }

  /** Draw frame T of a plan: the ground of what is on screen, then its content. */
  function render(ctx, plan, T, env = {}) {
    const frame = at(plan, T);
    for (const layer of frame.layers) {
      Scenes.render(ctx, layer.id, { ...layer.clock, ambient: env.ambient }, layer.props, env);
    }
    return frame;
  }

  /**
   * Frame T of `before`, carried over to `after` - so an edit in the Studio
   * leaves the preview where it was instead of starting it over.
   *
   * Same clip, same place in it. Through the intro it stays put; through idle
   * it keeps how long it has idled, unless the new idle is shorter, when the out
   * starts now; through the out it keeps how far out it is. A clip whose scene
   * was swapped starts again from its own beginning.
   */
  function reanchor(before, after, T) {
    if (!before || !after || !after.clips.length) return 0;
    const time = Math.max(0, Number(T) || 0);
    const layer = at(before, time).layers[0];
    if (!layer) return 0;

    const index = Math.min(layer.index, after.clips.length - 1);
    const was = before.clips[layer.index];
    const clip = after.clips[index];
    const resting = !after.loop && index === after.clips.length - 1;
    const { t, exit } = layer.clock;

    let local;
    if (!was || was.id !== clip.id) {
      local = 0;
    } else if (exit > 0) {
      local = clip.intro + clip.hold + Math.min(exit, clip.outro - 1);
    } else if (t >= was.intro) {
      const idled = t - was.intro;
      local = clip.intro + (resting ? idled : Math.min(idled, clip.hold));
    } else {
      local = Math.min(t, clip.intro);
    }

    // A loop past its first pass stays past it.
    const passes = after.loop && before.loop && before.cycle > 0 && time >= before.cycle ? after.cycle : 0;
    return clip.start + local + passes;
  }

  /** Frames for a video of this: one whole loop, or the way in plus `tail` seconds of idle. */
  function videoLength(plan, tailSeconds = 3) {
    if (!plan.clips.length) return 1;
    const tail = Math.round(Math.max(0, Number(tailSeconds) || 0) * FPS);
    return Math.max(1, plan.loop ? plan.cycle : plan.settle + tail);
  }

  return {
    FPS,
    HOLD_DEFAULT,
    HOLD_MAX,
    HOLD_STEP,
    MAX_CLIPS,
    cleanHold,
    normalize,
    describe,
    plan,
    at,
    render,
    reanchor,
    videoLength
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = KlndrMotionTimeline;
