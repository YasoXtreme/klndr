// Klndr Motion Player
//
// Plays a motion scene in a <canvas> - the live counterpart of rendering it a
// frame at a time in the Remotion workspace. It knows nothing about what a
// scene draws, only the clock, the canvas and the manners.
//
// The manners are most of this file. A header animates only while it can be
// seen, never for someone who has asked for reduced motion unless they press
// play, and redraws the moment the theme changes instead of waiting for its
// next frame.

const KlndrMotion = (() => {
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
   * One frame into a canvas, then stop. For thumbnails and gallery tiles.
   */
  function renderStill(canvas, { sceneId, props, frame, ratio = 2, theme }) {
    const scene = KlndrScenes.get(sceneId);
    if (!scene) return;
    const { width, height } = KlndrScenes.sizeFor(ratio);
    sizeCanvas(canvas, canvas.clientWidth || 320, width, height);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    ctx.clearRect(0, 0, width, height);
    KlndrScenes.render(
      ctx,
      sceneId,
      frame == null ? scene.stillFrame : frame,
      KlndrScenes.sanitizeProps(sceneId, props),
      { width, height, theme: theme || KlndrMotionCore.readTheme() }
    );
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
   * Mount a playing scene into `container`.
   *
   * options.autoplay  start playing (reduced motion overrides it)
   * options.controls  play/pause and a scrubber, for the Studio
   * options.label     what a screen reader says instead of the animation
   */
  function mount(container, { sceneId, props, ratio = 2, autoplay = true, loop = true, controls = false, label = '' } = {}) {
    const scene = KlndrScenes.get(sceneId);
    const fps = KlndrScenes.FPS;
    const duration = scene ? scene.durationInFrames : 1;
    const { width, height } = KlndrScenes.sizeFor(ratio);
    let clean = KlndrScenes.sanitizeProps(sceneId, props);

    const root = document.createElement('div');
    root.className = 'ann-motion';
    const canvas = document.createElement('canvas');
    canvas.className = 'ann-motion-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', label || KlndrScenes.describe(sceneId, clean));
    root.appendChild(canvas);
    container.appendChild(root);

    const ctx = canvas.getContext('2d');
    let theme = KlndrMotionCore.readTheme();
    let wantsPlay = Boolean(autoplay) && (controls || !prefersReducedMotion());
    let frame = wantsPlay ? 0 : (scene ? scene.stillFrame : 0);
    let playing = false;
    let visible = true;
    let raf = 0;
    let startedAt = 0;
    let drawn = -1;
    let destroyed = false;

    let playButton = null;
    let scrubber = null;
    let clock = null;
    let overlay = null;

    function draw(force) {
      if (!scene || destroyed || (!force && frame === drawn)) return;
      ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
      ctx.clearRect(0, 0, width, height);
      KlndrScenes.render(ctx, sceneId, frame, clean, { width, height, theme });
      drawn = frame;
      if (scrubber) {
        scrubber.value = String(frame);
        clock.textContent = `${(frame / fps).toFixed(1)}s`;
      }
    }

    function tick(now) {
      raf = 0;
      if (!playing) return;
      const elapsed = Math.floor(((now - startedAt) / 1000) * fps);
      if (!loop && elapsed >= duration - 1) {
        frame = duration - 1;
        draw();
        pause();
        return;
      }
      frame = ((elapsed % duration) + duration) % duration;
      draw();
      raf = requestAnimationFrame(tick);
    }

    function syncButton() {
      if (!playButton) return;
      playButton.firstChild.textContent = wantsPlay ? 'pause' : 'play_arrow';
      playButton.setAttribute('aria-label', wantsPlay ? 'Pause' : 'Play');
    }

    // Plays only while it is wanted, on screen, and in a tab that is in front.
    function reconcile() {
      const shouldPlay = wantsPlay && visible && !document.hidden && Boolean(scene) && !destroyed;
      if (shouldPlay && !playing) {
        playing = true;
        startedAt = performance.now() - (frame / fps) * 1000;
        raf = requestAnimationFrame(tick);
      } else if (!shouldPlay && playing) {
        playing = false;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      }
      syncButton();
    }

    function play() {
      wantsPlay = true;
      if (overlay) {
        overlay.remove();
        overlay = null;
      }
      reconcile();
    }

    function pause() {
      wantsPlay = false;
      reconcile();
    }

    function seek(to) {
      frame = Math.min(duration - 1, Math.max(0, Math.round(to)));
      if (playing) startedAt = performance.now() - (frame / fps) * 1000;
      draw(true);
    }

    if (controls) {
      const bar = document.createElement('div');
      bar.className = 'ann-motion-controls';
      playButton = iconButton('ann-motion-play', 'play_arrow', 'Play');
      playButton.addEventListener('click', () => (wantsPlay ? pause() : play()));
      scrubber = document.createElement('input');
      scrubber.type = 'range';
      scrubber.className = 'ann-motion-scrubber';
      scrubber.min = '0';
      scrubber.max = String(duration - 1);
      scrubber.step = '1';
      scrubber.setAttribute('aria-label', 'Scrub through the animation');
      scrubber.addEventListener('input', () => {
        pause();
        seek(Number(scrubber.value));
      });
      clock = document.createElement('span');
      clock.className = 'ann-motion-clock';
      bar.append(playButton, scrubber, clock);
      root.appendChild(bar);
    } else if (autoplay && !wantsPlay) {
      // Reduced motion: a still, and a way to ask for the motion anyway.
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
      get frame() {
        return frame;
      },
      get playing() {
        return playing;
      },
      /** Paused on purpose - not merely scrolled away or in a background tab. */
      get paused() {
        return !wantsPlay;
      },
      get duration() {
        return duration;
      },
      /** New props without remounting, so an edit in the Studio keeps playing. */
      update(nextProps) {
        clean = KlndrScenes.sanitizeProps(sceneId, nextProps);
        canvas.setAttribute('aria-label', label || KlndrScenes.describe(sceneId, clean));
        draw(true);
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
