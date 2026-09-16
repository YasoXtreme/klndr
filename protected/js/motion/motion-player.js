// Klndr Motion Player
//
// Plays a header's motion in a <canvas> - the live counterpart of rendering it a
// frame at a time in the Remotion workspace. It knows nothing about what a
// scene draws, only the clock, the canvas and the manners.
//
// The clock is a single count of frames since playback began. The motion
// timeline turns that into which clip is on screen and where it is: coming in,
// idling, going out and round again, or resting on its last clip for good. A
// header that plays once never stops drawing - its idle state keeps moving.
//
// The manners are most of this file. A header animates only while it can be
// seen, never for someone who has asked for reduced motion unless they press
// play, and redraws the moment the theme changes instead of waiting for its
// next frame.

const KlndrMotion = (() => {
  const Timeline = KlndrMotionTimeline;
  const FPS = KlndrScenes.FPS;

  const reducedMotionQuery = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

  function prefersReducedMotion() {
    return Boolean(reducedMotionQuery && reducedMotionQuery.matches);
  }

  // ElmsSans has to be in the page before a scene draws text, or the first
  // frames fall back to a system face and the headline visibly swaps. Capped,
  // because a scene that never draws is worse than one in the wrong font.
  let fontReady = null;
  function whenFontReady() {
    if (!fontReady) {
      const cap = new Promise((resolve) => setTimeout(resolve, 1500));
      const load = document.fonts && document.fonts.load
        ? Promise.all(['900 48px ElmsSans', '800 32px ElmsSans', '700 20px ElmsSans']
          .map((spec) => document.fonts.load(spec))).catch(() => {})
        : Promise.resolve();
      fontReady = Promise.race([load, cap]);
    }
    return fontReady;
  }

  function sizeCanvas(canvas, cssWidth, width, height) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round((w * height) / width));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      return true;
    }
    return false;
  }

  /**
   * A header's first clip, arrived and at rest, into a canvas - then stop. For
   * thumbnails and gallery tiles.
   */
  function renderStill(canvas, { scene, ratio = 2, theme }) {
    const plan = Timeline.plan(scene);
    if (!plan.clips.length) return;
    const { width, height } = KlndrScenes.sizeFor(ratio);
    sizeCanvas(canvas, canvas.clientWidth || 320, width, height);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    ctx.clearRect(0, 0, width, height);
    Timeline.render(ctx, plan, plan.still, {
      width,
      height,
      theme: theme || KlndrMotionCore.readTheme(),
      ambient: 0
    });
  }

  function iconButton(className, icon, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.setAttribute('aria-label', label);
    const glyph = document.createElement('span');
    glyph.className = 'material-symbols-outlined';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = icon;
    button.appendChild(glyph);
    return button;
  }

  /**
   * Mount a playing header into `container`.
   *
   * options.scene     the header's motion - { loop, clips }, or an old { id, props }
   * options.autoplay  start playing (reduced motion overrides it)
   * options.label     what a screen reader says instead of the animation
   */
  function mount(container, { scene, ratio = 2, autoplay = true, label = '' } = {}) {
    let plan = Timeline.plan(scene);
    const { width, height } = KlndrScenes.sizeFor(ratio);
    const describe = () => label || Timeline.describe(plan.scene);

    const root = document.createElement('div');
    root.className = 'ann-motion';
    const canvas = document.createElement('canvas');
    canvas.className = 'ann-motion-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', describe());
    root.appendChild(canvas);
    container.appendChild(root);

    const ctx = canvas.getContext('2d');
    let theme = KlndrMotionCore.readTheme();
    let wantsPlay = Boolean(autoplay) && !prefersReducedMotion();
    // Until someone asks for the motion, reduced motion gets the resting pose.
    let resting = !wantsPlay;
    let time = resting ? plan.still : 0;
    let playing = false;
    let visible = true;
    let raf = 0;
    let startedAt = 0;
    let drawn = null;
    let destroyed = false;
    let overlay = null;

    const playable = () => plan.clips.length > 0;
    const now = () => Timeline.at(plan, time);

    function draw(force) {
      if (!playable() || destroyed || (!force && time === drawn)) return;
      ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
      ctx.clearRect(0, 0, width, height);
      Timeline.render(ctx, plan, time, { width, height, theme, ambient: resting ? 0 : 1 });
      drawn = time;
    }

    function rebase() {
      startedAt = performance.now() - (time / FPS) * 1000;
    }

    function tick(stamp) {
      raf = 0;
      if (!playing) return;
      // A loop's count is folded back a pass at a time, so it never grows
      // without end - but once past its first pass, it stays past it.
      if (plan.loop && plan.cycle > 0) {
        const cycleMs = (plan.cycle / FPS) * 1000;
        while (stamp - startedAt >= 2 * cycleMs) startedAt += cycleMs;
      }
      time = Math.max(0, Math.floor(((stamp - startedAt) / 1000) * FPS));
      draw();
      raf = requestAnimationFrame(tick);
    }

    // Plays only while it is wanted, on screen, and in a tab that is in front.
    function reconcile() {
      const shouldPlay = wantsPlay && visible && !document.hidden && playable() && !destroyed;
      if (shouldPlay && !playing) {
        playing = true;
        rebase();
        raf = requestAnimationFrame(tick);
      } else if (!shouldPlay && playing) {
        playing = false;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      }
    }

    function wake() {
      if (overlay) {
        overlay.remove();
        overlay = null;
      }
      if (!resting) return;
      resting = false;
      time = 0;
    }

    function play() {
      wake();
      wantsPlay = true;
      draw(true);
      reconcile();
    }

    function pause() {
      wantsPlay = false;
      reconcile();
    }

    /** Jump to a frame count since playback began. */
    function setTime(frame) {
      wake();
      time = Math.max(0, Math.round(frame));
      if (playing) rebase();
      draw(true);
    }

    /** Jump to a point on the bar: a frame from 0 to `length`. */
    function seek(position) {
      const last = plan.loop ? Math.max(0, plan.cycle - 1) : plan.settle;
      const pass = plan.loop && plan.cycle > 0 && time >= plan.cycle ? plan.cycle : 0;
      setTime(Math.min(last, Math.max(0, Math.round(position))) + pass);
    }

    if (autoplay && !wantsPlay) {
      // Reduced motion: the resting pose, and a way to ask for the motion anyway.
      overlay = iconButton('ann-media-play', 'play_arrow', 'Play animation');
      overlay.addEventListener('click', (event) => {
        event.stopPropagation();
        play();
      });
      root.appendChild(overlay);
    }

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
        if (sizeCanvas(canvas, root.clientWidth || container.clientWidth || 600, width, height)) draw(true);
      })
      : null;
    if (resizeObserver) resizeObserver.observe(root);

    const intersection = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => {
        visible = entries.some((entry) => entry.isIntersecting);
        reconcile();
      })
      : null;
    if (intersection) intersection.observe(root);

    const onVisibility = () => reconcile();
    document.addEventListener('visibilitychange', onVisibility);

    const onTheme = () => {
      theme = KlndrMotionCore.readTheme();
      draw(true);
    };
    window.addEventListener('klndr:themechange', onTheme);

    sizeCanvas(canvas, root.clientWidth || container.clientWidth || 600, width, height);
    draw(true);
    whenFontReady().then(() => {
      if (destroyed) return;
      draw(true);
      reconcile();
    });

    return {
      element: root,
      play,
      pause,
      seek,
      setTime,
      get plan() {
        return plan;
      },
      /** Frames since playback began, never wrapped. */
      get time() {
        return time;
      },
      /** Where on the bar playback is, as a frame from 0 to `length`. */
      get position() {
        return now().position;
      },
      /** The frames the bar spans: a whole loop, or the way in. */
      get length() {
        return plan.length;
      },
      /** How full the bar is, 0 to 1. A header that plays once stays full once it has arrived. */
      get progress() {
        return resting ? 1 : now().progress;
      },
      get loop() {
        return plan.loop;
      },
      /** Showing the rest pose because nobody has asked for the motion yet. */
      get resting() {
        return resting;
      },
      /** Played once and arrived: idling for good. */
      get settled() {
        return !resting && now().settled;
      },
      get playing() {
        return playing;
      },
      /** Paused on purpose - not merely scrolled away or in a background tab. */
      get paused() {
        return !wantsPlay;
      },
      /**
       * New motion without remounting, so an edit in the Studio keeps playing
       * from where it was.
       */
      update(nextScene) {
        const next = Timeline.plan(nextScene);
        time = resting ? next.still : Timeline.reanchor(plan, next, time);
        plan = next;
        canvas.setAttribute('aria-label', describe());
        if (playing) rebase();
        draw(true);
        reconcile();
      },
      destroy() {
        destroyed = true;
        wantsPlay = false;
        reconcile();
        if (resizeObserver) resizeObserver.disconnect();
        if (intersection) intersection.disconnect();
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('klndr:themechange', onTheme);
        root.remove();
      }
    };
  }

  return { mount, renderStill, whenFontReady, prefersReducedMotion };
})();
