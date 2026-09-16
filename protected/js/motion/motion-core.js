// Klndr Motion Core
//
// The primitives the header animations are built from, in plain JavaScript:
// interpolate, spring and easing in the shape Remotion gives them, a seeded
// random, colour arithmetic, and the drawing helpers every scene shares.
//
// Everything a scene draws is a pure function of where it is in time. That is
// what lets one scene play live inside klndr, jump to any frame in the Studio's
// scrubber, and render to video from the Remotion workspace in motion/ - there
// is no wall clock anywhere in here, only frame counts.
//
// Browser global and CommonJS module, like palette.js: the Remotion project and
// the unit tests require it.

const KlndrMotionCore = (() => {
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const lerp = (from, to, t) => from + (to - from) * t;

  // ---- Easing ----------------------------------------------------------------

  function bezier(x1, y1, x2, y2) {
    const curve = (a1, a2) => (t) =>
      3 * a1 * t * (1 - t) * (1 - t) + 3 * a2 * t * t * (1 - t) + t * t * t;
    const x = curve(x1, x2);
    const y = curve(y1, y2);
    const slope = (t) =>
      3 * x1 * (1 - t) * (1 - t) + 6 * (x2 - x1) * t * (1 - t) + 3 * (1 - x2) * t * t;
    return (progress) => {
      if (progress <= 0 || progress >= 1) return progress;
      // Newton's method, with bisection as the fallback on a flat stretch.
      let t = progress;
      for (let i = 0; i < 8; i++) {
        const error = x(t) - progress;
        if (Math.abs(error) < 1e-6) return y(t);
        const d = slope(t);
        if (Math.abs(d) < 1e-6) break;
        t -= error / d;
      }
      let lo = 0;
      let hi = 1;
      t = progress;
      for (let i = 0; i < 30; i++) {
        const value = x(t);
        if (Math.abs(value - progress) < 1e-6) break;
        if (value < progress) lo = t;
        else hi = t;
        t = (lo + hi) / 2;
      }
      return y(t);
    };
  }

  const Easing = {
    linear: (t) => t,
    quad: (t) => t * t,
    cubic: (t) => t * t * t,
    sin: (t) => 1 - Math.cos((t * Math.PI) / 2),
    circle: (t) => 1 - Math.sqrt(1 - t * t),
    back: (s = 1.70158) => (t) => t * t * ((s + 1) * t - s),
    bounce: (t) => {
      if (t < 1 / 2.75) return 7.5625 * t * t;
      if (t < 2 / 2.75) return 7.5625 * (t -= 1.5 / 2.75) * t + 0.75;
      if (t < 2.5 / 2.75) return 7.5625 * (t -= 2.25 / 2.75) * t + 0.9375;
      return 7.5625 * (t -= 2.625 / 2.75) * t + 0.984375;
    },
    bezier,
    in: (easing) => easing,
    out: (easing) => (t) => 1 - easing(1 - t),
    inOut: (easing) => (t) => (t < 0.5 ? easing(t * 2) / 2 : 1 - easing((1 - t) * 2) / 2)
  };

  // klndr's own entrance curve - the overshoot the logo lands with.
  Easing.pop = bezier(0.34, 1.56, 0.64, 1);

  // ---- interpolate -------------------------------------------------------------

  /**
   * Map `input` through piecewise-linear ranges, the way Remotion's interpolate
   * does. inputRange must ascend; the easing applies within each segment.
   */
  function interpolate(input, inputRange, outputRange, options = {}) {
    const {
      easing = Easing.linear,
      extrapolateLeft = 'clamp',
      extrapolateRight = 'clamp'
    } = options;
    if (inputRange.length < 2 || inputRange.length !== outputRange.length) {
      throw new Error('interpolate needs two matching ranges of at least two values');
    }

    let segment = 1;
    while (segment < inputRange.length - 1 && input > inputRange[segment]) segment += 1;

    const inMin = inputRange[segment - 1];
    const inMax = inputRange[segment];
    let t = inMax === inMin ? 1 : (input - inMin) / (inMax - inMin);

    if (t < 0) {
      if (extrapolateLeft === 'clamp') t = 0;
      else if (extrapolateLeft === 'identity') return input;
    }
    if (t > 1) {
      if (extrapolateRight === 'clamp') t = 1;
      else if (extrapolateRight === 'identity') return input;
    }

    const eased = t >= 0 && t <= 1 ? easing(t) : t;
    return lerp(outputRange[segment - 1], outputRange[segment], eased);
  }

  /** 0 before `start`, 1 after `end`, eased in between. */
  function progress(frame, start, end, easing = Easing.linear) {
    return interpolate(frame, [start, end], [0, 1], { easing });
  }

  // ---- spring --------------------------------------------------------------------

  /**
   * A damped spring from `from` to `to`, `frame - delay` frames after release.
   *
   * Solved in closed form rather than stepped frame by frame, so any frame can
   * be asked for on its own: the scrubber jumps straight to frame 90 and gets
   * exactly what playback would have drawn there.
   */
  function spring({ frame, fps = 30, delay = 0, from = 0, to = 1, config = {} }) {
    const { mass = 1, stiffness = 100, damping = 10, overshootClamping = false } = config;
    const t = (frame - delay) / fps;
    if (t <= 0) return from;

    const omega = Math.sqrt(stiffness / mass);
    const zeta = damping / (2 * Math.sqrt(stiffness * mass));
    let x;
    if (zeta < 1) {
      const omegaD = omega * Math.sqrt(1 - zeta * zeta);
      x = Math.exp(-zeta * omega * t) *
        (Math.cos(omegaD * t) + ((zeta * omega) / omegaD) * Math.sin(omegaD * t));
    } else if (zeta === 1) {
      x = Math.exp(-omega * t) * (1 + omega * t);
    } else {
      const root = Math.sqrt(zeta * zeta - 1);
      const r1 = -omega * (zeta - root);
      const r2 = -omega * (zeta + root);
      x = (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
    }

    const value = to + (from - to) * x;
    if (!overshootClamping) return value;
    return from < to ? Math.min(value, to) : Math.max(value, to);
  }

  // ---- random ----------------------------------------------------------------------

  function hashSeed(seed) {
    if (typeof seed === 'number') return seed >>> 0;
    let h = 2166136261;
    for (const ch of String(seed)) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /**
   * mulberry32. Seeded, so confetti falls the same way on every play, in every
   * browser, and in the Remotion render.
   */
  function random(seed) {
    let a = hashSeed(seed);
    return function next() {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- time ------------------------------------------------------------------------

  /**
   * A sine over time, one cycle every `period` frames. A scene's idle state has
   * no loop length to fit into - it lasts as long as the admin asks - so waves
   * are pure time, and nothing about them needs to meet up with frame 0.
   */
  function wave(t, period, phase = 0) {
    return Math.sin((t / period + phase) * Math.PI * 2);
  }

  /** 0 to 1 and back, once every `period` frames, starting from rest at 0. */
  function swell(t, period, phase = 0) {
    return (1 - Math.cos((t / period + phase) * Math.PI * 2)) / 2;
  }

  /**
   * 0 to 1 over `frames`, leaving 0 at no speed. Motion that only exists once a
   * scene has arrived is scaled by this, so it grows out of stillness instead of
   * starting mid-swing.
   */
  function rampIn(t, frames) {
    return interpolate(t, [0, frames], [0, 1], { easing: Easing.inOut(Easing.sin) });
  }

  /** Which repetition of an every-`every`-frames event `t` is in, and how far into it. */
  function beat(t, every) {
    const index = Math.floor(Math.max(0, t) / every);
    return { index, local: Math.max(0, t) - index * every };
  }

  /**
   * How far through a stretch of its out a scene is: 0 until the out begins, and
   * exactly 0 on its first frame, so the out starts from precisely what the idle
   * state was drawing.
   */
  function outOf(clock, start, end, easing = Easing.linear) {
    return progress(clock.exit || 0, start, end, easing);
  }

  // ---- colour ----------------------------------------------------------------------

  function parseHex(hex) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!match) return null;
    const n = parseInt(match[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function toHex({ r, g, b }) {
    return '#' + [r, g, b]
      .map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0'))
      .join('');
  }

  /** `amount` of `a` over `b` - the same sum CSS color-mix does in srgb. */
  function mix(a, b, amount) {
    const ca = parseHex(a);
    const cb = parseHex(b);
    if (!ca || !cb) return a;
    return toHex({
      r: lerp(cb.r, ca.r, amount),
      g: lerp(cb.g, ca.g, amount),
      b: lerp(cb.b, ca.b, amount)
    });
  }

  function alpha(hex, opacity) {
    const c = parseHex(hex) || { r: 0, g: 0, b: 0 };
    return `rgba(${c.r}, ${c.g}, ${c.b}, ${clamp(opacity, 0, 1)})`;
  }

  function luminance(hex) {
    const c = parseHex(hex);
    if (!c) return 0;
    const channel = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  }

  // ---- theme -------------------------------------------------------------------------

  // The tokens a scene paints with, keyed by the CSS custom property each one is.
  const TOKEN_VARS = {
    ground: '--surface-page',
    surface: '--surface-1',
    tray: '--surface-2',
    ink: '--ink-strong',
    inkSoft: '--ink-soft',
    line: '--color-border',
    slab: '--shadow-slab',
    accent: '--accent-active',
    accentInk: '--accent-active-ink',
    mint: '--accent-mint',
    onColorInk: '--on-color-ink',
    onColorLine: '--on-color-border'
  };

  // Static copies for where there is no stylesheet to read: node, the tests and
  // the Remotion renderer. scripts/check-design-tokens.js fails if these stop
  // matching public/css/theme.css.
  const THEMES = {
    light: {
      ground: '#f2ffec',
      surface: '#ffffff',
      tray: '#f9fafb',
      ink: '#000000',
      inkSoft: '#4b5563',
      line: '#000000',
      slab: '#000000',
      accent: '#f2ffec',
      accentInk: '#000000',
      mint: '#f2ffec',
      onColorInk: '#000000',
      onColorLine: '#000000',
      taskMix: 100,
      taskMixInto: null
    },
    dark: {
      ground: '#14140f',
      surface: '#2a2a2a',
      tray: '#323232',
      ink: '#eef7e4',
      inkSoft: '#b4b8a8',
      line: '#eef7e4',
      slab: '#eef7e4',
      accent: '#9ae659',
      accentInk: '#14140f',
      mint: '#334026',
      onColorInk: '#14140f',
      onColorLine: '#14140f',
      taskMix: 88,
      taskMixInto: '#14140f'
    }
  };

  function themeName() {
    if (typeof window === 'undefined') return 'light';
    if (window.KlndrTheme && typeof window.KlndrTheme.resolved === 'function') {
      return window.KlndrTheme.resolved();
    }
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  /**
   * The theme in force, read off the page's own custom properties, so a scene
   * wears whatever theme.css says today. Falls back to the static copy for
   * anything that does not resolve to a plain hex.
   */
  function readTheme(name) {
    const resolved = name || themeName();
    const base = THEMES[resolved] || THEMES.light;
    if (name || typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
      return { name: resolved, ...base };
    }

    const style = getComputedStyle(document.documentElement);
    const theme = { name: resolved };
    for (const [key, cssVar] of Object.entries(TOKEN_VARS)) {
      const value = style.getPropertyValue(cssVar).trim().toLowerCase();
      theme[key] = /^#[0-9a-f]{6}$/.test(value) ? value : base[key];
    }
    const taskMix = parseFloat(style.getPropertyValue('--task-mix'));
    theme.taskMix = Number.isFinite(taskMix) ? taskMix : 100;
    const into = style.getPropertyValue('--task-mix-into').trim().toLowerCase();
    theme.taskMixInto = /^#[0-9a-f]{6}$/.test(into) ? into : null;
    return theme;
  }

  /**
   * A category colour as the theme draws it. Same rule app.css applies to task
   * blocks: untouched in the light, mixed toward the page ground in the dark.
   */
  function taskFill(hex, theme) {
    if (!theme || !theme.taskMixInto || theme.taskMix >= 100) return hex;
    return mix(hex, theme.taskMixInto, theme.taskMix / 100);
  }

  // ---- drawing -----------------------------------------------------------------------

  const FONT_STACK = "ElmsSans, -apple-system, 'Segoe UI', Roboto, sans-serif";
  const EMOJI_STACK = "'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif";

  function font(size, weight = 900) {
    return `${weight} ${Math.round(size * 10) / 10}px ${FONT_STACK}`;
  }

  function emojiFont(size) {
    return `${Math.round(size)}px ${EMOJI_STACK}`;
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  /**
   * klndr's one box: a flat fill, a hard line, and the offset slab it casts in
   * the colour of that line - the same drawing as a pane or a task block.
   */
  function slabBox(ctx, { x, y, w, h, r = 18, fill, line, lineWidth = 4, slab = 8, slabColor }) {
    // A slab thinner than half a pixel hides behind the box's own line - a key
    // pressed all the way down has none.
    if (slab >= 0.5) {
      roundRectPath(ctx, x + slab, y + slab, w, h, r);
      ctx.fillStyle = slabColor || line;
      ctx.fill();
    }
    roundRectPath(ctx, x, y, w, h, r);
    ctx.fillStyle = fill;
    ctx.fill();
    if (lineWidth) {
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = line;
      ctx.stroke();
    }
  }

  function wrapLines(ctx, text, maxWidth) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  /**
   * The largest size, stepping down, at which `text` fits in `maxLines` lines of
   * `maxWidth`. Leaves ctx.font set to that size.
   */
  function fitText(ctx, text, { maxWidth, maxLines = 2, max = 96, min = 28, step = 4, weight = 900 }) {
    for (let size = max; size >= min; size -= step) {
      ctx.font = font(size, weight);
      const lines = wrapLines(ctx, text, maxWidth);
      if (lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= maxWidth)) {
        return { size, lines };
      }
    }
    ctx.font = font(min, weight);
    return { size: min, lines: wrapLines(ctx, text, maxWidth).slice(0, maxLines) };
  }

  return {
    clamp,
    lerp,
    Easing,
    interpolate,
    progress,
    spring,
    random,
    wave,
    swell,
    rampIn,
    beat,
    outOf,
    parseHex,
    toHex,
    mix,
    alpha,
    luminance,
    TOKEN_VARS,
    THEMES,
    readTheme,
    taskFill,
    FONT_STACK,
    EMOJI_STACK,
    font,
    emojiFont,
    roundRectPath,
    slabBox,
    wrapLines,
    fitText
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = KlndrMotionCore;
