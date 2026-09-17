// Klndr Motion Timeline
//
// What plays when. A header's motion is a run of clips - scenes, each with its
// own words and colours - that play one after another and then either loop or
// come to rest. This file turns that into frame numbers: when each clip starts,
// how long it idles, when it leaves, and for any frame of playback, what is on
// screen and where every clock on it stands.
//
// A run of clips is one tracking shot, not clips glued end to end. Each clip is
// a panel on klndr's board, laid out left to right like days on the calendar.
// Just before a clip's out, the camera lifts its panel off the board and slides
// to the next panel, which begins to arrive while it is still sliding in; the
// camera sets it down and it finishes arriving. The same move joins every pair
// of clips, the last back to the first included, so a run keeps one rhythm.
//
// It is the one place that knows, so the player, the Studio's scrubber, the
// server, the tests and the Remotion render all agree frame for frame.
//
// Browser global and CommonJS module, like palette.js.

const KlndrMotionTimeline = (() => {
  const M = typeof KlndrMotionCore !== 'undefined' ? KlndrMotionCore : require('./motion-core');
  const Scenes = typeof KlndrScenes !== 'undefined' ? KlndrScenes : require('./scenes');

  const FPS = Scenes.FPS;
  // Idle is set in seconds, on the Studio's slider.
  const HOLD_DEFAULT = 2;
  const HOLD_MAX = 10;
  const HOLD_STEP = 0.5;
  const MAX_CLIPS = 6;

  // ---- The move between clips, in frames -------------------------------------
  // The camera sets off EARLY frames before a clip's out begins, so the clip is
  // still whole as it starts to slide away and plays its out on the way to the
  // edge of the frame - there is never a moment with nothing to look at. The
  // next clip starts arriving LAND frames into the MOVE, while its panel is
  // still sliding in, and the camera sets it down part-way through its intro.
  const EARLY = 6;
  const MOVE = 22;
  const LAND = 7;

  // The camera eases off and eases in: no jolt at either end.
  const travel = M.Easing.bezier(0.65, 0, 0.35, 1);

  // ---- The board, in stage pixels ----------------------------------------------
  // Panels sit a grid square apart, so the calendar grid runs on unbroken from
  // one to the next. While the camera travels they lift off the board as cards -
  // corners, line and slab - and the view pulls back to show the board around
  // them; set down, a panel is full-bleed again, exactly the clip on its own.
  // Lifting takes RISE frames and setting down SETTLE_DOWN, ending with the move.
  const GAP = 60;
  const PULL_BACK = 0.1;
  const RADIUS = 28;
  const LINE = 5;
  const SLAB = 12;
  const RISE = 9;
  const SETTLE_DOWN = 10;

  // What a panel carries is not glued to it: its content hangs back a touch as
  // the camera sets off and runs on a touch as it stops, then settles.
  const CARRY = 34;
  const CARRY_PERIOD = 15;
  const CARRY_DAMPING = 0.55;
  const CARRY_FRAMES = 44;

  // A clip that hands over leaves the way the camera goes.
  const LEFTWARD = Object.freeze({ x: -1, y: 0 });

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
   *   clips[i]  start      its intro begins
   *             enter      its panel starts sliding into view - the camera
   *                        setting off towards it - or `start` for the first clip
   *             leave      the camera sets off from it, towards the next clip:
   *                        just before its out, but never before it has arrived
   *             outStart   its idle ends and its out begins
   *             end        its out is over and its content gone
   *   travels   whether clips hand over with the camera. A single clip has
   *             nowhere to travel: it leaves, and comes back on an empty stage.
   *   cycle     one pass through every clip - what a loop repeats
   *   settle    the frame the last clip has fully arrived on: where a header
   *             that plays once stops moving forward
   *   length    what a progress bar or scrubber spans - the cycle when looping,
   *             otherwise the way to `settle`
   *   still     the frame thumbnails and reduced motion show: the first clip,
   *             arrived
   */
  function plan(scene) {
    const timeline = normalize(scene);
    const travels = timeline.clips.length > 1;
    const clips = [];
    let cursor = 0;
    timeline.clips.forEach((clip, index) => {
      const { intro, outro } = Scenes.timing(clip.id, clip.props);
      const hold = Math.round(clip.hold * FPS);
      const start = cursor;
      const outStart = start + intro + hold;
      const leave = Math.max(start + intro, outStart - EARLY);
      clips.push({
        index,
        id: clip.id,
        props: clip.props,
        intro,
        hold,
        outro,
        start,
        enter: index > 0 ? start - LAND : start,
        leave,
        outStart,
        end: outStart + outro
      });
      cursor = travels ? leave + LAND : outStart + outro;
    });
    const last = clips[clips.length - 1];
    const settle = last ? last.start + last.intro : 0;
    return {
      scene: timeline,
      loop: timeline.loop,
      travels,
      clips,
      cycle: cursor,
      settle,
      length: timeline.loop ? cursor : settle,
      still: clips.length ? clips[0].intro : 0
    };
  }

  // ==========================================
  // THE CAMERA
  // ==========================================

  /** How lifted off the board the panels are, `since` frames into a move: 0 to 1 and back. */
  function liftAt(since) {
    const up = M.progress(since, 0, RISE, M.Easing.inOut(M.Easing.sin));
    const down = M.progress(since, MOVE - SETTLE_DOWN, MOVE, M.Easing.inOut(M.Easing.sin));
    return up * (1 - down);
  }

  // Worked out once, because every move is the same move: a damped spring
  // riding on the panel, pushed by the panel's own acceleration. It lags as the
  // camera speeds up, runs on as it slows, and rings down after it stops.
  const carryTable = (() => {
    const perFrame = 8;
    const steps = CARRY_FRAMES * perFrame;
    const dt = 1 / perFrame;
    const along = (s) => (s <= 0 ? 0 : s >= MOVE ? 1 : travel(s / MOVE));
    const omega = (Math.PI * 2) / CARRY_PERIOD;
    const table = new Float64Array(steps + 1);
    let x = 0;
    let v = 0;
    let peak = 0;
    for (let i = 0; i <= steps; i++) {
      table[i] = x;
      peak = Math.max(peak, Math.abs(x));
      const s = i * dt;
      const push = (along(s + dt) - 2 * along(s) + along(s - dt)) / (dt * dt);
      v += (push - omega * omega * x - 2 * CARRY_DAMPING * omega * v) * dt;
      x += v * dt;
    }
    const scale = peak > 0 ? CARRY / peak : 0;
    return { perFrame, values: table.map((value) => value * scale) };
  })();

  /** How far behind (positive) or ahead of its panel a panel's content is, `since` frames into a move. */
  function carryAt(since) {
    if (!(since > 0) || since >= CARRY_FRAMES) return 0;
    const at = since * carryTable.perFrame;
    const i = Math.floor(at);
    return M.lerp(carryTable.values[i], carryTable.values[i + 1], at - i);
  }

  // ==========================================
  // WHAT IS ON SCREEN
  // ==========================================

  function layerOf(plan, index, clock, offset, shift, flow) {
    const clip = plan.clips[index];
    return { index, id: clip.id, props: clip.props, clock, offset, shift, flow };
  }

  /**
   * Where playback stands on frame T - frames since it began, never wrapped, and
   * not necessarily whole: what is on screen and how full the progress bar is.
   *
   *   index, clock  the clip that has the stage - the latest to have started -
   *                 and where its clock stands
   *   layers        every panel to draw, back to front: its clip, clock, where
   *                 the panel is (in panel widths from the frame, `offset`), how
   *                 far its content trails it (`shift`, stage pixels) and which
   *                 way its out travels (`flow`)
   *   camera        null when still; while travelling, how far along (`travel`)
   *                 and how lifted off the board (`lift`) it is
   *   moving        drawing changes faster than whole frames can show: the
   *                 camera is travelling, or what it set down is settling
   */
  function at(plan, T) {
    const { clips } = plan;
    if (!clips.length) {
      return { index: -1, clock: null, layers: [], camera: null, moving: false, position: 0, progress: 1, settled: true };
    }

    const time = Math.max(0, Number(T) || 0);
    const { cycle } = plan;
    const pass = plan.loop && cycle > 0 ? Math.floor(time / cycle) : 0;
    const tau = time - pass * cycle;
    const last = clips.length - 1;

    let index = 0;
    for (let i = last; i > 0; i--) {
      if (tau >= clips[i].start) {
        index = i;
        break;
      }
    }
    const clip = clips[index];
    // A header that plays once comes to rest on its last clip, and stays there.
    const resting = !plan.loop && index === last;
    const clock = { t: tau - clip.start, exit: resting ? 0 : Math.max(0, tau - clip.outStart) };
    const flowOf = (i) => (plan.travels && (plan.loop || i !== last) ? LEFTWARD : null);

    // A move under way: into the clip with the stage, or out of it towards the
    // next - which, after the last clip of a loop, is the first again. The
    // first pass opens on an empty stage, so nothing travels into it.
    let move = null;
    let settling = 0;
    if (plan.travels) {
      if (index > 0 || pass > 0) {
        const since = clock.t + LAND;
        if (since < MOVE) move = { from: index > 0 ? index - 1 : last, to: index, since };
        else settling = carryAt(since);
      }
      if (!move && !resting && (index < last || plan.loop)) {
        const since = tau - clip.leave;
        if (since > 0) move = { from: index, to: index < last ? index + 1 : 0, since };
      }
    }

    const layers = [];
    let camera = null;
    if (move) {
      const from = clips[move.from];
      const u = travel(move.since / MOVE);
      const shift = carryAt(move.since);
      camera = { travel: u, lift: liftAt(move.since) };
      const t = from.leave - from.start + move.since;
      const leaving = { t, exit: Math.max(0, t - from.intro - from.hold) };
      const arriving = { t: move.since - LAND, exit: 0 };
      layers.push(layerOf(plan, move.from, leaving, -u, shift, flowOf(move.from)));
      layers.push(layerOf(plan, move.to, arriving, 1 - u, shift, flowOf(move.to)));
    } else {
      // Simply on screen, or set down and still settling.
      layers.push(layerOf(plan, index, clock, 0, settling, flowOf(index)));
    }

    const position = plan.loop ? tau : Math.min(tau, plan.settle);
    const span = plan.loop ? cycle - 1 : plan.settle;
    return {
      index,
      clock,
      layers,
      camera,
      moving: Boolean(camera) || layers.some((layer) => layer.shift !== 0),
      position,
      progress: span > 0 ? Math.min(1, position / span) : 1,
      settled: !plan.loop && tau >= plan.settle
    };
  }

  // ==========================================
  // DRAWING
  // ==========================================

  /** Draw frame T of a plan: the board and panels the camera sees, and what is on them. */
  function render(ctx, plan, T, env = {}) {
    const frame = at(plan, T);
    if (!frame.layers.length) return frame;

    const width = env.width || Scenes.WIDTH;
    const height = env.height || Scenes.BASE_HEIGHT;
    const theme = env.theme || M.readTheme('light');
    const stage = { width, height, theme };
    const { camera } = frame;
    const clockOf = (layer) => ({ ...layer.clock, ambient: env.ambient });

    // Between moves a clip draws exactly as it does on its own.
    if (!camera && frame.layers.length === 1 && frame.layers[0].shift === 0) {
      const [layer] = frame.layers;
      Scenes.render(ctx, layer.id, clockOf(layer), layer.props, { ...stage, flow: layer.flow });
      return frame;
    }

    const lift = camera ? camera.lift : 0;
    const zoom = 1 - PULL_BACK * lift;
    const step = width + GAP;
    const view = {
      left: width / 2 - width / 2 / zoom,
      right: width / 2 + width / 2 / zoom,
      top: height / 2 - height / 2 / zoom,
      bottom: height / 2 + height / 2 / zoom
    };
    const radius = RADIUS * lift;
    const slab = SLAB * lift;
    const line = LINE * lift;

    ctx.save();
    if (camera) {
      ctx.translate(width / 2, height / 2);
      ctx.scale(zoom, zoom);
      ctx.translate(-width / 2, -height / 2);
      // The board, laid from the first panel's corner so its grid meets theirs.
      const origin = frame.layers[0].offset * step;
      ctx.save();
      ctx.translate(origin, 0);
      Scenes.paintGround(ctx, stage, theme.ground, {
        x: view.left - origin,
        y: view.top,
        width: view.right - view.left,
        height: view.bottom - view.top
      });
      ctx.restore();
    }

    for (const layer of frame.layers) {
      const x = layer.offset * step;
      if (x + width + slab <= view.left || x >= view.right) continue;

      ctx.save();
      ctx.translate(x, 0);
      if (camera) {
        if (slab >= 0.5) {
          M.roundRectPath(ctx, slab, slab, width, height, radius);
          ctx.fillStyle = theme.slab;
          ctx.fill();
        }
        M.roundRectPath(ctx, 0, 0, width, height, radius);
        ctx.clip();
      }
      Scenes.paintGround(ctx, stage, Scenes.ground(layer.id, layer.props, theme));
      // Not yet begun, or already gone, is an empty stage: nothing to draw.
      if (layer.clock.t >= 0 && layer.clock.exit < Scenes.OUTRO) {
        if (layer.shift) ctx.translate(layer.shift, 0);
        Scenes.renderContent(ctx, layer.id, clockOf(layer), layer.props, { ...stage, flow: layer.flow });
      }
      ctx.restore();

      if (camera && line >= 0.5) {
        ctx.save();
        ctx.translate(x, 0);
        M.roundRectPath(ctx, 0, 0, width, height, radius);
        ctx.lineWidth = line;
        ctx.strokeStyle = theme.line;
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();
    return frame;
  }

  // ==========================================
  // EDITING AND VIDEO
  // ==========================================

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
    const frame = at(before, time);
    if (frame.index < 0) return 0;

    const index = Math.min(frame.index, after.clips.length - 1);
    const was = before.clips[frame.index];
    const clip = after.clips[index];
    const resting = !after.loop && index === after.clips.length - 1;
    const { t, exit } = frame.clock;

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

  /**
   * The frame a video of this starts on. A run of clips that loops is recorded
   * from its second pass, which opens mid-move from the last clip, so the file
   * repeats without a seam - the first pass opens on an empty stage instead.
   */
  function videoStart(plan) {
    return plan.loop && plan.travels ? plan.cycle : 0;
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
    EARLY,
    MOVE,
    LAND,
    cleanHold,
    normalize,
    describe,
    plan,
    at,
    render,
    reanchor,
    videoStart,
    videoLength
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = KlndrMotionTimeline;
