// Klndr Motion Scenes
//
// The built-in animated headers: ten short scenes in klndr's own drawing style -
// flat fills, hard lines, offset slabs, ElmsSans Black - that an admin picks
// from a gallery and fills in with their own words, emoji and colours.
//
// That is the Remotion idea without Remotion's runtime. A scene is a function of
// (clock, props), so this one file plays live in the app, scrubs in the Studio,
// and renders to MP4 from motion/, which imports it unchanged.
//
// Every scene comes in three parts. It animates IN over its `intro`; then it is
// IDLE for as long as it is asked to be - still alive, never arriving again;
// then it animates OUT over OUTRO frames. The clock a scene draws from says
// where it is:
//
//   t        frames since the scene began. Entrances and ambient motion read it.
//   idle     frames since the intro finished, 0 until then.
//   exit     frames since the out began, 0 until then - so the first frame of
//            the out draws exactly what idle was drawing, however long that was.
//   ambient  0 to 1, how much idle motion there is. 0 is the rest pose that
//            thumbnails and reduced motion show.
//
// A scene starts and ends on an empty stage, and draws its content only: the
// ground under it is the registry's to paint. test/motion.test.js holds every
// scene to all of that.

const KlndrScenes = (() => {
  const M = typeof KlndrMotionCore !== 'undefined' ? KlndrMotionCore : require('./motion-core');
  const Palette = typeof KlndrPalette !== 'undefined' ? KlndrPalette : require('../palette');

  const FPS = 30;
  const WIDTH = 1200;
  const BASE_HEIGHT = 600;
  // Every out is the same length, so a run of scenes keeps one beat.
  const OUTRO = 18;
  const EPS = 0.001;
  const TAU = Math.PI * 2;
  const HEX = /^#[0-9a-f]{6}$/i;
  const { Easing } = M;

  // Which way an out travels, unless whatever is playing the scene says otherwise.
  const DOWN = { x: 0, y: 1 };
  const UP = { x: 0, y: -1 };

  const deg = (d) => (d * Math.PI) / 180;

  // ==========================================
  // PROPS
  // ==========================================

  function cleanText(value, max, fallback) {
    if (typeof value !== 'string') return fallback;
    return Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, max).join('');
  }

  function sanitizeField(field, value) {
    switch (field.type) {
      case 'text':
        return cleanText(value, field.max, field.default);
      case 'color':
        if (typeof value === 'string' && HEX.test(value)) return value.toLowerCase();
        return field.optional && value === '' ? '' : field.default;
      case 'toggle':
        return typeof value === 'boolean' ? value : field.default;
      case 'list': {
        if (!Array.isArray(value)) return field.default.slice();
        const items = value
          .map((item) => cleanText(item, field.max, ''))
          .filter(Boolean)
          .slice(0, field.maxItems);
        return items.length ? items : field.default.slice();
      }
      default:
        return field.default;
    }
  }

  function wordCount(text) {
    return String(text || '').split(/\s+/).filter(Boolean).length;
  }

  // ==========================================
  // DRAWING HELPERS
  // ==========================================

  // The calendar's own grid, faintly, so a scene reads as klndr before anything
  // has moved. `area` paints another stretch of the same lattice - the board
  // around a clip, seen by a camera travelling between clips - with its lines
  // where the stage's own would carry on to.
  const GRID = 60;

  function paintGround(ctx, env, color, area) {
    const { x = 0, y = 0, width = env.width, height = env.height } = area || {};
    ctx.fillStyle = color;
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = M.alpha(env.theme.ink, 0.07);
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let gx = (Math.floor(x / GRID) + 1) * GRID; gx < x + width; gx += GRID) {
      ctx.moveTo(gx, y);
      ctx.lineTo(gx, y + height);
    }
    for (let gy = (Math.floor(y / GRID) + 1) * GRID; gy < y + height; gy += GRID) {
      ctx.moveTo(x, gy);
      ctx.lineTo(x + width, gy);
    }
    ctx.stroke();
  }

  // Scenes are composed on a 1200x600 stage. A taller or shorter header centres
  // that stage and scales it to fit, rather than every scene doing layout maths
  // for four aspect ratios.
  function onStage(ctx, env, draw) {
    const scale = Math.min(env.width / WIDTH, env.height / BASE_HEIGHT);
    ctx.save();
    ctx.translate(env.width / 2, env.height / 2);
    ctx.scale(scale, scale);
    ctx.translate(-WIDTH / 2, -BASE_HEIGHT / 2);
    draw();
    ctx.restore();
  }

  // Draws nothing at all - not even a save - when the element is invisible. That
  // is what makes an empty stage the same drawing on every frame it happens.
  function place(ctx, { x, y, rotate = 0, scaleX = 1, scaleY = scaleX, alpha = 1 }, draw) {
    if (alpha <= EPS || Math.abs(scaleX) <= EPS || Math.abs(scaleY) <= EPS) return;
    ctx.save();
    ctx.globalAlpha = ctx.globalAlpha * Math.min(1, alpha);
    ctx.translate(x, y);
    if (rotate) ctx.rotate(rotate);
    if (scaleX !== 1 || scaleY !== 1) ctx.scale(scaleX, scaleY);
    draw();
    ctx.restore();
  }

  function flowOf(env, fallback) {
    return env.flow || fallback;
  }

  function inkOn(color, theme) {
    return M.luminance(color) > 0.3 ? theme.onColorInk : '#ffffff';
  }

  function centeredLines(ctx, lines, { x, y, size, color }) {
    const step = size * 1.06;
    const top = y - ((lines.length - 1) * step) / 2;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach((line, i) => ctx.fillText(line, x, top + i * step + size * 0.04));
  }

  function sparklePath(ctx, r) {
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.quadraticCurveTo(0, 0, 0, r);
    ctx.quadraticCurveTo(0, 0, -r, 0);
    ctx.quadraticCurveTo(0, 0, 0, -r);
    ctx.closePath();
  }

  function sealPath(ctx, outer, inner, points, fresh = true) {
    if (fresh) ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? outer : inner;
      const a = (i / (points * 2)) * TAU - Math.PI / 2;
      if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
  }

  function checkPath(ctx, size) {
    ctx.beginPath();
    ctx.moveTo(-size * 0.5, size * 0.02);
    ctx.lineTo(-size * 0.14, size * 0.36);
    ctx.lineTo(size * 0.52, -size * 0.34);
  }

  // ==========================================
  // SCENE: BIG REVEAL
  // ==========================================

  const confettiCache = new Map();
  const CONFETTI_AT = 16;

  function confetti(accent) {
    if (confettiCache.has(accent)) return confettiCache.get(accent);
    const rand = M.random(`pop-reveal:${accent}`);
    const colours = [accent, accent, ...Palette.colors.slice(0, 10)];
    const shapes = ['rect', 'circle', 'tri', 'squiggle'];
    const pieces = Array.from({ length: 44 }, (_, i) => ({
      x: 600 + (rand() - 0.5) * 520,
      y: 300 + (rand() - 0.5) * 90,
      vx: (rand() - 0.5) * 22,
      vy: -10 - rand() * 16,
      spin: (rand() - 0.5) * 0.5,
      size: 14 + rand() * 14,
      shape: shapes[Math.floor(rand() * shapes.length)],
      colour: colours[Math.floor(rand() * colours.length)],
      layer: i % 2
    }));
    confettiCache.set(accent, pieces);
    return pieces;
  }

  // One burst, fallen and gone before the intro is over - confetti is part of
  // arriving, not of idling.
  function drawConfetti(ctx, pieces, t, layer, theme) {
    const local = t - CONFETTI_AT;
    if (local <= 0) return;
    const opacity = 1 - M.progress(local, 40, 58);
    if (opacity <= EPS) return;

    for (const piece of pieces) {
      if (piece.layer !== layer) continue;
      const x = piece.x + piece.vx * local;
      const y = piece.y + piece.vy * local + 0.6 * local * local;
      place(ctx, { x, y, rotate: piece.spin * local, alpha: opacity }, () => {
        const s = piece.size;
        ctx.fillStyle = piece.colour;
        ctx.strokeStyle = theme.line;
        ctx.lineWidth = 3;
        ctx.beginPath();
        if (piece.shape === 'rect') {
          ctx.rect(-s / 2, -s / 3, s, (s * 2) / 3);
        } else if (piece.shape === 'circle') {
          ctx.arc(0, 0, s / 2, 0, TAU);
        } else if (piece.shape === 'tri') {
          ctx.moveTo(0, -s / 2);
          ctx.lineTo(s / 2, s / 2);
          ctx.lineTo(-s / 2, s / 2);
          ctx.closePath();
        } else {
          ctx.moveTo(-s, 0);
          ctx.quadraticCurveTo(-s / 2, -s / 2, 0, 0);
          ctx.quadraticCurveTo(s / 2, s / 2, s, 0);
          ctx.lineWidth = 6;
          ctx.lineCap = 'round';
          ctx.strokeStyle = piece.colour;
          ctx.stroke();
          return;
        }
        ctx.fill();
        ctx.stroke();
      });
    }
  }

  const SPARKS = [
    [170, 120, 26, 0],
    [1045, 165, 34, 0.35],
    [1010, 490, 22, 0.6],
    [200, 480, 30, 0.8]
  ];

  const popReveal = {
    id: 'pop-reveal',
    name: 'Big reveal',
    description: 'Your headline springs onto a card one word at a time, with a burst of confetti.',
    schema: [
      { key: 'eyebrow', type: 'text', label: 'Tag', max: 16, default: 'NEW' },
      { key: 'headline', type: 'text', label: 'Headline', max: 48, default: 'Something fresh just landed' },
      { key: 'accent', type: 'color', label: 'Accent', default: '#9ae659' },
      { key: 'background', type: 'color', label: 'Background', optional: true, default: '' },
      { key: 'confetti', type: 'toggle', label: 'Confetti', default: true }
    ],
    // The last word lands 36 + 3 per word in; the confetti is gone by 74.
    intro: (p) => Math.max(p.confetti ? 76 : 40, 36 + 3 * wordCount(p.headline)),
    ground: (p, theme) => p.background || theme.mint,
    describe: (p) => [p.eyebrow, p.headline].filter(Boolean).join(': '),
    render(ctx, clock, p, env) {
      const { t, ambient } = clock;
      const theme = env.theme;
      const flow = flowOf(env, DOWN);

      onStage(ctx, env, () => {
        const cardIn = M.spring({ frame: t, fps: FPS, delay: 2, config: { damping: 12, stiffness: 120 } });
        // Out: the tag and sparks tuck away, the card lifts a touch, then goes.
        const shrink = M.outOf(clock, 0, 6, Easing.in(Easing.cubic));
        const lift = M.outOf(clock, 0, 4, Easing.out(Easing.quad));
        const go = M.outOf(clock, 4, OUTRO, Easing.in(Easing.cubic));
        const travel = 90 * go - 6 * lift;
        const presence = M.clamp(cardIn * 1.5, 0, 1) * (1 - go);

        const { size, lines } = M.fitText(ctx, p.headline || ' ', {
          maxWidth: 720,
          maxLines: 2,
          max: 92,
          min: 44
        });
        const lineHeight = size * 1.08;
        const cardW = 860;
        const cardH = Math.max(1, lines.length) * lineHeight + 120;
        const pieces = p.confetti ? confetti(p.accent) : [];

        drawConfetti(ctx, pieces, t, 0, theme);

        place(ctx, {
          x: 600 + flow.x * travel,
          y: 312 + M.wave(t, 75) * 7 * ambient + flow.y * travel,
          rotate: deg(M.lerp(-9, -2, cardIn) + M.wave(t, 150, 0.25) * 1.2 * ambient),
          scaleX: (0.6 + 0.4 * cardIn) * M.lerp(1, 0.9, go),
          alpha: presence
        }, () => {
          M.slabBox(ctx, {
            x: -cardW / 2, y: -cardH / 2, w: cardW, h: cardH,
            r: 28, fill: theme.surface, line: theme.line, lineWidth: 5, slab: 12
          });

          ctx.font = M.font(size);
          const space = ctx.measureText(' ').width;
          let index = 0;
          lines.forEach((line, row) => {
            const words = line.split(' ');
            const widths = words.map((word) => ctx.measureText(word).width);
            const total = widths.reduce((sum, w) => sum + w, 0) + space * (words.length - 1);
            const y = -((lines.length - 1) * lineHeight) / 2 + row * lineHeight + size * 0.04;
            let x = -total / 2;
            words.forEach((word, i) => {
              const s = M.spring({ frame: t, fps: FPS, delay: 12 + index * 3, config: { damping: 10, stiffness: 170 } });
              place(ctx, {
                x: x + widths[i] / 2,
                y: y + (1 - s) * 34,
                scaleX: 0.55 + 0.45 * s,
                alpha: M.clamp(s * 1.6, 0, 1)
              }, () => {
                ctx.fillStyle = theme.ink;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(word, 0, 0);
              });
              x += widths[i] + space;
              index += 1;
            });
          });

          if (p.eyebrow) {
            const tagIn = M.spring({ frame: t, fps: FPS, delay: 10, config: { damping: 9, stiffness: 150 } }) * (1 - shrink);
            ctx.font = M.font(30);
            const tagW = ctx.measureText(p.eyebrow).width + 44;
            place(ctx, {
              x: -cardW / 2 + 40 + tagW / 2,
              y: -cardH / 2,
              rotate: deg(-7),
              scaleX: tagIn,
              alpha: M.clamp(tagIn * 2, 0, 1)
            }, () => {
              M.slabBox(ctx, {
                x: -tagW / 2, y: -30, w: tagW, h: 60,
                r: 30, fill: p.accent, line: theme.line, lineWidth: 4, slab: 6
              });
              ctx.font = M.font(30);
              ctx.fillStyle = inkOn(p.accent, theme);
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(p.eyebrow, 0, 2);
            });
          }
        });

        drawConfetti(ctx, pieces, t, 1, theme);

        const sparkle = presence * (1 - shrink);
        SPARKS.forEach(([x, y, r, phase]) => {
          const twinkle = M.lerp(0.8, 0.55 + 0.45 * M.wave(t, 50, phase), ambient);
          place(ctx, { x, y, rotate: t * 0.02 * ambient, scaleX: twinkle * sparkle, alpha: sparkle }, () => {
            sparklePath(ctx, r);
            ctx.fillStyle = p.accent;
            ctx.fill();
            ctx.lineWidth = 4;
            ctx.strokeStyle = theme.line;
            ctx.stroke();
          });
        });
      });
    }
  };

  // ==========================================
  // SCENE: BLOCKS IN MOTION
  // ==========================================

  const LANE_Y = 290;
  const BLOCKS = [
    { x: 120, w: 190, time: '9:00', colour: '#3ba4f6' },
    { x: 330, w: 160, time: '11:30', colour: '#9ae659' },
    { x: 510, w: 230, time: '1:00', colour: '#d985f5' },
    { x: 760, w: 170, time: '4:00', colour: '#fb923c' }
  ];
  // Where the incoming block pushes each one to. The last hits the end of the
  // lane and compresses rather than falling off it - the calendar's own rule.
  const PUSHED = [null, { x: 540, w: 160 }, { x: 720, w: 230 }, { x: 970, w: 110 }];
  const DROP = { x: 320, w: 200, time: '10:30' };
  const BLOCK_LABELS = ['Deep work', 'Gym', 'Physics', 'Read', 'New plan'];
  // The span of the lane the "now" line walks along, in stage pixels.
  const NOW_FROM = 110;
  const NOW_TO = 1090;

  function drawBlock(ctx, { x, y, w, h, colour, label, time, done, theme, alpha, scale = 1, tilt = 0, slab = 6 }) {
    place(ctx, { x: x + w / 2, y: y + h / 2, rotate: deg(tilt), scaleX: scale, alpha }, () => {
      M.slabBox(ctx, {
        x: -w / 2, y: -h / 2, w, h,
        r: 16, fill: M.taskFill(colour, theme), line: theme.onColorLine, lineWidth: 4, slab
      });

      ctx.save();
      M.roundRectPath(ctx, -w / 2, -h / 2, w, h, 16);
      ctx.clip();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = theme.onColorInk;
      ctx.font = M.font(Math.min(28, w / 6.2));
      const labelWidth = ctx.measureText(label).width;
      ctx.fillText(label, -w / 2 + 18, -h / 2 + 48);
      if (done > EPS) {
        ctx.strokeStyle = theme.onColorInk;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(-w / 2 + 16, -h / 2 + 38);
        ctx.lineTo(-w / 2 + 20 + labelWidth * done, -h / 2 + 38);
        ctx.stroke();
      }
      ctx.globalAlpha = ctx.globalAlpha * 0.72;
      ctx.font = M.font(20, 700);
      ctx.fillText(time, -w / 2 + 18, -h / 2 + 80);
      ctx.restore();

      if (done > EPS) {
        place(ctx, { x: w / 2 - 28, y: -h / 2 + 28, scaleX: done }, () => {
          ctx.beginPath();
          ctx.arc(0, 0, 17, 0, TAU);
          ctx.fillStyle = theme.onColorInk;
          ctx.fill();
          checkPath(ctx, 18);
          ctx.strokeStyle = M.taskFill(colour, theme);
          ctx.lineWidth = 4;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.stroke();
        });
      }
    });
  }

  // The order blocks leave in: whichever sits furthest along the way out goes
  // first, so the lane empties from its leading edge.
  function leavingOrder(pieces, flow) {
    const ranked = pieces
      .map((piece, i) => ({ i, along: (piece.x + piece.w / 2) * flow.x + (LANE_Y + 60) * flow.y, x: piece.x }))
      .sort((a, b) => b.along - a.along || a.x - b.x);
    const rank = [];
    ranked.forEach((entry, order) => {
      rank[entry.i] = order;
    });
    return rank;
  }

  const blockShuffle = {
    id: 'block-shuffle',
    name: 'Blocks in motion',
    description: 'A mini week: a new block drops in and nudges the others along, the way the calendar does.',
    schema: [
      { key: 'title', type: 'text', label: 'Title', max: 36, default: 'Your week, rearranged' },
      { key: 'labels', type: 'list', label: 'Block labels', max: 14, maxItems: 5, default: BLOCK_LABELS.slice() },
      { key: 'accent', type: 'color', label: 'New block colour', default: '#fde047' },
      { key: 'background', type: 'color', label: 'Background', optional: true, default: '' }
    ],
    // The pushes settle by 76 and the first block is ticked off by 92.
    intro: 96,
    ground: (p, theme) => p.background || theme.ground,
    describe: (p) => p.title,
    render(ctx, clock, p, env) {
      const { t, idle, ambient } = clock;
      const theme = env.theme;
      const flow = flowOf(env, DOWN);
      const label = (i) => p.labels[i] || BLOCK_LABELS[i];

      onStage(ctx, env, () => {
        const laneIn = M.spring({ frame: t, fps: FPS, config: { damping: 14, stiffness: 120 } });
        const titleOut = M.outOf(clock, 0, 10, Easing.in(Easing.cubic));
        const laneOut = M.outOf(clock, 6, OUTRO, Easing.in(Easing.quad));
        const presence = M.clamp(laneIn * 1.4, 0, 1) * (1 - laneOut);

        const titleIn = M.spring({ frame: t, fps: FPS, delay: 4, config: { damping: 13, stiffness: 130 } });
        const title = M.fitText(ctx, p.title || ' ', { maxWidth: 940, maxLines: 1, max: 58, min: 30 });
        place(ctx, {
          x: 100,
          y: 128 + (1 - titleIn) * 24 - titleOut * 24,
          alpha: M.clamp(titleIn * 1.5, 0, 1) * (1 - titleOut)
        }, () => {
          ctx.font = M.font(title.size);
          ctx.fillStyle = theme.ink;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(title.lines[0] || '', 0, 0);
        });

        place(ctx, {
          x: 600,
          y: 330,
          scaleY: (0.85 + 0.15 * laneIn) * M.lerp(1, 0.85, laneOut),
          alpha: presence
        }, () => {
          M.slabBox(ctx, {
            x: -510, y: -140, w: 1020, h: 280,
            r: 24, fill: theme.surface, line: theme.line, lineWidth: 5, slab: 10
          });
          ctx.font = M.font(22, 800);
          ctx.fillStyle = theme.inkSoft;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ['9', '10', '11', '12', '1', '2', '3', '4'].forEach((hour, i) => {
            const x = -450 + i * 120;
            ctx.fillText(hour, x, -110);
            ctx.strokeStyle = M.alpha(theme.ink, 0.12);
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x, -80);
            ctx.lineTo(x, 130);
            ctx.stroke();
          });
          ctx.strokeStyle = theme.line;
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.moveTo(-510, -80);
          ctx.lineTo(510, -80);
          ctx.stroke();
        });

        // Idle: time passes. A "now" line walks slowly across the hours from
        // where the new block starts, fading out at the ends of the lane.
        const nowX = NOW_FROM + ((DROP.x - NOW_FROM + idle * 1.2) % (NOW_TO - NOW_FROM));
        const edge = M.clamp(Math.min(nowX - NOW_FROM, NOW_TO - nowX) / 40, 0, 1);
        const nowAlpha = M.rampIn(idle, 24) * ambient * edge * presence * (1 - M.outOf(clock, 0, 6));
        place(ctx, { x: nowX, y: 0, alpha: nowAlpha }, () => {
          ctx.strokeStyle = theme.ink;
          ctx.lineWidth = 4;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(0, 258);
          ctx.lineTo(0, 456);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(0, 250, 9, 0, TAU);
          ctx.fillStyle = M.taskFill(p.accent, theme);
          ctx.fill();
          ctx.lineWidth = 3;
          ctx.strokeStyle = theme.line;
          ctx.stroke();
        });

        const resting = [
          ...BLOCKS.map((block, i) => PUSHED[i] || block),
          { x: DROP.x, w: DROP.w }
        ];
        const rank = leavingOrder(resting, flow);
        const leave = (i) => M.outOf(clock, 2 + rank[i] * 1.5, 12 + rank[i] * 1.5, Easing.in(Easing.cubic));
        const away = (i) => 260 * leave(i);

        BLOCKS.forEach((block, i) => {
          const appear = M.spring({ frame: t, fps: FPS, delay: 8 + i * 4, config: { damping: 11, stiffness: 150 } });
          const push = i > 0
            ? M.spring({ frame: t, fps: FPS, delay: 44 + (i - 1) * 5, config: { damping: 13, stiffness: 140 } })
            : 0;
          const target = PUSHED[i] || block;
          const gone = leave(i);
          drawBlock(ctx, {
            x: M.lerp(block.x, target.x, push) + flow.x * away(i),
            y: LANE_Y + flow.y * away(i),
            w: M.lerp(block.w, target.w, push),
            h: 120,
            colour: block.colour,
            label: label(i),
            time: block.time,
            done: i === 0 ? M.progress(t, 80, 92, Easing.out(Easing.cubic)) : 0,
            theme,
            alpha: M.clamp(appear * 1.6, 0, 1) * (1 - gone),
            scale: 0.7 + 0.3 * M.clamp(appear, 0, 1.1),
            tilt: gone * (rank[i] % 2 ? 6 : -6)
          });
        });

        const drop = M.spring({ frame: t, fps: FPS, delay: 34, config: { damping: 9, stiffness: 110 } });
        const dropGone = leave(4);
        const dropAlpha = M.clamp((t - 34) / 6, 0, 1) * (1 - dropGone);
        const near = M.clamp(drop, 0, 1);
        // Idle: the new block hovers a little, lifting off its slab and back.
        const hover = M.rampIn(idle, 20) * M.swell(idle, 80) * ambient;

        if (dropAlpha > EPS && near > EPS) {
          ctx.fillStyle = M.alpha(theme.ink, 0.16 * near * (1 - dropGone));
          ctx.beginPath();
          ctx.ellipse(DROP.x + DROP.w / 2, LANE_Y + 136, DROP.w * 0.45 * near, 10 * near, 0, 0, TAU);
          ctx.fill();
        }

        drawBlock(ctx, {
          x: DROP.x - 3 * hover + flow.x * away(4),
          y: M.lerp(-220, LANE_Y, drop) - 3 * hover + flow.y * away(4),
          w: DROP.w,
          h: 120,
          colour: p.accent,
          label: label(4),
          time: DROP.time,
          done: 0,
          theme,
          alpha: dropAlpha,
          tilt: (1 - near) * -8 + dropGone * (rank[4] % 2 ? 6 : -6),
          slab: 6 + 3 * hover
        });
      });
    }
  };

  // ==========================================
  // SCENE: STICKER PARTY
  // ==========================================

  function stickerSlots(count) {
    const rand = M.random(`stickers:${count}`);
    return Array.from({ length: count }, (_, i) => {
      const angle = -Math.PI / 2 + 0.3 + (i / count) * TAU + (rand() - 0.5) * 0.35;
      return {
        x: 600 + Math.cos(angle) * (420 + (rand() - 0.5) * 40),
        y: 300 + Math.sin(angle) * (205 + (rand() - 0.5) * 30),
        tilt: (rand() - 0.5) * 24
      };
    });
  }

  const stickerBurst = {
    id: 'sticker-burst',
    name: 'Sticker party',
    description: 'Emoji stickers pop out around your headline and wobble along.',
    schema: [
      { key: 'headline', type: 'text', label: 'Headline', max: 36, default: 'Big update!' },
      { key: 'emojis', type: 'list', label: 'Stickers', max: 8, maxItems: 6, default: ['🎉', '⚡', '📅', '✅', '🔥', '✨'] },
      { key: 'accent', type: 'color', label: 'Headline colour', default: '#d985f5' },
      { key: 'background', type: 'color', label: 'Background', optional: true, default: '' }
    ],
    intro: (p) => 49 + 4 * (p.emojis.length - 1),
    ground: (p, theme) => p.background || theme.ground,
    describe: (p) => p.headline,
    render(ctx, clock, p, env) {
      const { t, ambient } = clock;
      const theme = env.theme;

      onStage(ctx, env, () => {
        const slots = stickerSlots(p.emojis.length);

        slots.forEach((slot, i) => {
          const launch = 16 + i * 4;
          const s = M.spring({ frame: t, fps: FPS, delay: launch, config: { damping: 9, stiffness: 120 } });
          const settled = M.clamp(s, 0, 1);
          // Out: flung away from the headline, one after another.
          const fling = M.outOf(clock, i, i + 10, Easing.in(Easing.cubic));

          const ring = M.progress(t, launch + 9, launch + 23, Easing.out(Easing.quad));
          if (ring > EPS && ring < 1 - EPS) {
            ctx.save();
            ctx.globalAlpha = ctx.globalAlpha * (1 - ring);
            ctx.strokeStyle = theme.line;
            ctx.lineWidth = 5;
            ctx.beginPath();
            ctx.arc(slot.x, slot.y, M.lerp(60, 120, ring), 0, TAU);
            ctx.stroke();
            ctx.restore();
          }

          let dx = slot.x - 600;
          let dy = slot.y - 300;
          if (env.flow) {
            const outward = Math.hypot(dx, dy) || 1;
            dx = (dx / outward) * 0.4 + env.flow.x;
            dy = (dy / outward) * 0.4 + env.flow.y;
          }
          const length = Math.hypot(dx, dy) || 1;
          const wobble = settled * ambient;

          place(ctx, {
            x: M.lerp(600, slot.x, s) + M.wave(t, 75, i * 0.13) * 4 * wobble + (dx / length) * 90 * fling,
            y: M.lerp(300, slot.y, s) + M.wave(t, 50, i * 0.21) * 6 * wobble + (dy / length) * 90 * fling,
            rotate: deg(slot.tilt + M.wave(t, 75, i * 0.17) * 7 * wobble + (dx < 0 ? -24 : 24) * fling),
            scaleX: (0.2 + 0.8 * M.clamp(s, 0, 1.2)) * (1 - 0.35 * fling),
            alpha: M.clamp(s * 2, 0, 1) * (1 - fling)
          }, () => {
            M.slabBox(ctx, {
              x: -64, y: -64, w: 128, h: 128,
              r: 32, fill: theme.surface, line: theme.line, lineWidth: 5, slab: 8
            });
            ctx.font = M.emojiFont(74);
            ctx.fillStyle = theme.ink;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(p.emojis[i], 0, 5);
          });
        });

        const plateIn = M.spring({ frame: t, fps: FPS, delay: 4, config: { damping: 11, stiffness: 150 } });
        const plateOut = M.outOf(clock, 4, 16, Easing.back(1.6));
        const { size, lines } = M.fitText(ctx, p.headline || ' ', { maxWidth: 520, maxLines: 2, max: 84, min: 40 });
        ctx.font = M.font(size);
        const textW = Math.max(120, ...lines.map((line) => ctx.measureText(line).width));
        const plateW = Math.min(680, textW + 110);
        const plateH = lines.length * size * 1.06 + 86;

        place(ctx, {
          x: 600,
          y: 300,
          rotate: deg(M.lerp(-16, -3, plateIn) + M.wave(t, 150) * 1.5 * ambient),
          scaleX: plateIn * (1 - plateOut),
          alpha: M.clamp(plateIn * 2, 0, 1)
        }, () => {
          M.slabBox(ctx, {
            x: -plateW / 2, y: -plateH / 2, w: plateW, h: plateH,
            r: 26, fill: p.accent, line: theme.line, lineWidth: 5, slab: 12
          });
          ctx.font = M.font(size);
          centeredLines(ctx, lines, { x: 0, y: 0, size, color: inkOn(p.accent, theme) });
        });
      });
    }
  };

  // ==========================================
  // SCENE: CHECKLIST
  // ==========================================

  const CHECKLIST_FLOW = { x: 0.35, y: 0.937 };

  // Every five seconds of idle, a small bump runs down the tick boxes.
  function tickRipple(idle, row) {
    const { local } = M.beat(idle, 150);
    const at = local - 90 - row * 5;
    return at > 0 && at < 10 ? Math.sin((Math.PI * at) / 10) : 0;
  }

  const checklist = {
    id: 'checklist',
    name: 'Checklist',
    description: 'A card of tasks that tick off one by one, with a little celebration at the end.',
    schema: [
      { key: 'title', type: 'text', label: 'Title', max: 28, default: "Today's wins" },
      { key: 'items', type: 'list', label: 'Items', max: 30, maxItems: 4, default: ['Plan the week', 'Split the big task', 'Drag blocks around', 'Tick things off'] },
      { key: 'accent', type: 'color', label: 'Tick colour', default: '#9ae659' },
      { key: 'badge', type: 'text', label: 'Finish badge', max: 12, default: 'Done!' },
      { key: 'background', type: 'color', label: 'Background', optional: true, default: '' }
    ],
    intro: (p) => (p.badge ? 81 : 56) + 16 * (p.items.length - 1),
    ground: (p, theme) => p.background || theme.mint,
    describe: (p) => [p.title, p.items.join(', ')].filter(Boolean).join(': '),
    render(ctx, clock, p, env) {
      const { t, idle, ambient } = clock;
      const theme = env.theme;
      const flow = flowOf(env, CHECKLIST_FLOW);

      onStage(ctx, env, () => {
        const items = p.items;
        const n = items.length;
        const rowH = 76;
        const cardW = 740;
        const cardH = 36 + 84 + n * rowH + 60 + 24;
        const tickAt = (i) => 36 + i * 16;
        const finished = tickAt(n - 1) + 18;
        const calm = M.rampIn(idle, 24) * ambient;
        const badgeOff = M.outOf(clock, 0, 6, Easing.back(1.8));
        const go = M.outOf(clock, 2, OUTRO, Easing.in(Easing.cubic));
        const cardIn = M.spring({ frame: t, fps: FPS, delay: 2, config: { damping: 13, stiffness: 120 } });
        const title = M.fitText(ctx, p.title || ' ', { maxWidth: 520, maxLines: 1, max: 46, min: 28 });

        place(ctx, {
          x: 600 + flow.x * 90 * go,
          y: 300 + (1 - cardIn) * 40 + M.wave(idle, 90) * 4 * calm + flow.y * 90 * go,
          rotate: deg((1 - cardIn) * 4 + (flow.x < 0 ? -7 : 7) * go),
          scaleX: 0.88 + 0.12 * cardIn,
          alpha: M.clamp(cardIn * 1.5, 0, 1) * (1 - go)
        }, () => {
          const left = -cardW / 2;
          const top = -cardH / 2;
          M.slabBox(ctx, {
            x: left, y: top, w: cardW, h: cardH,
            r: 28, fill: theme.surface, line: theme.line, lineWidth: 5, slab: 12
          });

          const doneCount = items.filter((_, i) => t >= tickAt(i) + 4).length;
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'left';
          ctx.fillStyle = theme.ink;
          ctx.font = M.font(title.size);
          ctx.fillText(title.lines[0] || '', left + 44, top + 74);
          ctx.textAlign = 'right';
          ctx.fillStyle = theme.inkSoft;
          ctx.font = M.font(30, 800);
          ctx.fillText(`${doneCount}/${n}`, -left - 44, top + 74);

          items.forEach((item, i) => {
            const rowY = top + 120 + i * rowH + rowH / 2;
            const slide = M.spring({ frame: t, fps: FPS, delay: 10 + i * 5, config: { damping: 12, stiffness: 150 } });
            const tick = M.progress(t, tickAt(i), tickAt(i) + 8, Easing.out(Easing.cubic));
            const strike = M.progress(t, tickAt(i) + 4, tickAt(i) + 16, Easing.inOut(Easing.quad));
            const bump = Math.sin(Math.PI * M.progress(t, tickAt(i), tickAt(i) + 10));
            const burst = M.progress(t, tickAt(i) + 2, tickAt(i) + 16);
            const ripple = tickRipple(idle, i) * ambient;

            place(ctx, {
              x: left + 44 - (1 - slide) * 50,
              y: rowY,
              alpha: M.clamp(slide * 1.6, 0, 1)
            }, () => {
              if (burst > EPS && burst < 1 - EPS) {
                ctx.save();
                ctx.globalAlpha = ctx.globalAlpha * (1 - burst);
                ctx.translate(24, 0);
                ctx.strokeStyle = theme.ink;
                ctx.lineWidth = 5;
                ctx.lineCap = 'round';
                ctx.beginPath();
                for (let k = 0; k < 8; k++) {
                  const a = (k / 8) * TAU;
                  ctx.moveTo(Math.cos(a) * (34 + burst * 18), Math.sin(a) * (34 + burst * 18));
                  ctx.lineTo(Math.cos(a) * (34 + burst * 40), Math.sin(a) * (34 + burst * 40));
                }
                ctx.stroke();
                ctx.restore();
              }

              place(ctx, { x: 24, y: 0, scaleX: 1 + bump * 0.22 + ripple * 0.12 }, () => {
                M.slabBox(ctx, {
                  x: -24, y: -24, w: 48, h: 48,
                  r: 12, fill: tick > EPS ? p.accent : theme.surface, line: theme.line, lineWidth: 4, slab: 0
                });
                if (tick > EPS) {
                  checkPath(ctx, 34);
                  ctx.setLineDash([46, 46]);
                  ctx.lineDashOffset = 46 * (1 - tick);
                  ctx.strokeStyle = inkOn(p.accent, theme);
                  ctx.lineWidth = 6;
                  ctx.lineCap = 'round';
                  ctx.lineJoin = 'round';
                  ctx.stroke();
                  ctx.setLineDash([]);
                }
              });

              ctx.font = M.font(34, 800);
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillStyle = theme.ink;
              ctx.globalAlpha = ctx.globalAlpha * (1 - strike * 0.5);
              ctx.fillText(item, 76, 2);
              if (strike > EPS) {
                ctx.strokeStyle = theme.ink;
                ctx.lineWidth = 5;
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.moveTo(72, 2);
                ctx.lineTo(80 + ctx.measureText(item).width * strike, 2);
                ctx.stroke();
              }
            });
          });

          const barY = top + 120 + n * rowH + 20;
          const barW = cardW - 88;
          let filled = 0;
          for (let i = 0; i < n; i++) {
            filled += M.clamp(
              M.spring({ frame: t, fps: FPS, delay: tickAt(i) + 2, config: { damping: 15, stiffness: 140 } }),
              0,
              1
            );
          }
          const fraction = n ? filled / n : 0;
          M.slabBox(ctx, {
            x: left + 44, y: barY, w: barW, h: 26,
            r: 13, fill: theme.tray, line: theme.line, lineWidth: 3, slab: 0
          });
          if (fraction > EPS) {
            M.slabBox(ctx, {
              x: left + 48, y: barY + 4, w: Math.max(18, (barW - 8) * fraction), h: 18,
              r: 9, fill: p.accent, line: theme.line, lineWidth: 0, slab: 0
            });
          }

          if (p.badge) {
            const pop = M.spring({ frame: t, fps: FPS, delay: finished, config: { damping: 8, stiffness: 160 } }) * (1 - badgeOff);
            ctx.font = M.font(32);
            const badgeW = ctx.measureText(p.badge).width + 50;
            place(ctx, {
              x: -left - 36,
              y: top + 2,
              rotate: deg(12 + M.wave(idle, 64) * 4 * calm),
              scaleX: pop,
              alpha: M.clamp(pop * 2, 0, 1)
            }, () => {
              M.slabBox(ctx, {
                x: -badgeW / 2, y: -32, w: badgeW, h: 64,
                r: 32, fill: p.accent, line: theme.line, lineWidth: 5, slab: 6
              });
              ctx.font = M.font(32);
              ctx.fillStyle = inkOn(p.accent, theme);
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(p.badge, 0, 2);
            });
          }
        });
      });
    }
  };

  // ==========================================
  // SCENE: STAMP
  // ==========================================

  const RAY_SPIN = TAU / 1500;

  const stamp = {
    id: 'stamp',
    name: 'Stamp',
    description: 'A big badge slams down with a shake, a puff of dust and a spinning sunburst.',
    schema: [
      { key: 'label', type: 'text', label: 'Badge text', max: 10, default: 'NEW' },
      { key: 'sublabel', type: 'text', label: 'Caption', max: 32, default: 'Fresh in klndr' },
      { key: 'color', type: 'color', label: 'Badge colour', default: '#fde047' },
      { key: 'background', type: 'color', label: 'Background', optional: true, default: '' }
    ],
    intro: (p) => (p.sublabel ? 50 : 42),
    ground: (p, theme) => p.background || theme.ground,
    describe: (p) => [p.label, p.sublabel].filter(Boolean).join(': '),
    render(ctx, clock, p, env) {
      const { t, idle, ambient } = clock;
      const theme = env.theme;
      // Standalone, the seal lifts off towards you rather than travelling.
      const flow = env.flow;

      onStage(ctx, env, () => {
        const cx = 600;
        const cy = 268;
        const calm = M.rampIn(idle, 24) * ambient;
        const retract = M.outOf(clock, 0, 10, Easing.in(Easing.quad));
        const sink = M.outOf(clock, 0, 12, Easing.in(Easing.cubic));
        const lift = M.outOf(clock, 4, OUTRO, Easing.in(Easing.cubic));
        const driftX = flow ? flow.x * 140 * lift : 0;
        const driftY = flow ? flow.y * 140 * lift : 0;

        const slam = M.progress(t, 4, 16, Easing.in(Easing.cubic));
        const since = t - 16;
        const impact = since >= 0 ? Math.exp(-since / 4.5) * Math.cos(since / 1.8) : 0;
        const shake = since >= 0 && since < 22 ? Math.exp(-since / 5) : 0;
        const shakeX = shake * 16 * Math.sin(t * 1.9);
        const shakeY = shake * 10 * Math.cos(t * 1.3);

        const rays = M.progress(t, 12, 30) * (1 - retract);
        if (rays > EPS) {
          ctx.save();
          ctx.globalAlpha = ctx.globalAlpha * rays;
          ctx.translate(cx + driftX, cy + driftY);
          ctx.rotate(t * RAY_SPIN * ambient);
          ctx.fillStyle = M.alpha(p.color, 0.35);
          ctx.beginPath();
          const reach = M.lerp(900, 420, retract);
          for (let i = 0; i < 20; i += 2) {
            const a0 = (i / 20) * TAU;
            const a1 = ((i + 1) / 20) * TAU;
            ctx.moveTo(0, 0);
            ctx.lineTo(Math.cos(a0) * reach, Math.sin(a0) * reach);
            ctx.lineTo(Math.cos(a1) * reach, Math.sin(a1) * reach);
            ctx.closePath();
          }
          ctx.fill();
          ctx.restore();
        }

        const dust = M.progress(t, 16, 42, Easing.out(Easing.quad));
        if (dust > EPS && dust < 1 - EPS) {
          ctx.save();
          ctx.globalAlpha = ctx.globalAlpha * (1 - dust);
          ctx.fillStyle = theme.surface;
          ctx.strokeStyle = theme.line;
          ctx.lineWidth = 4;
          for (let i = 0; i < 10; i++) {
            const a = Math.PI * (0.05 + (i / 9) * 0.9);
            const dist = M.lerp(150, 270, dust);
            ctx.beginPath();
            ctx.arc(
              cx + shakeX + Math.cos(a) * dist,
              cy + shakeY + 60 + Math.sin(a) * dist * 0.7,
              M.lerp(10, 40, dust) * (i % 2 ? 0.8 : 1),
              0,
              TAU
            );
            ctx.fill();
            ctx.stroke();
          }
          ctx.restore();
        }

        const scale = M.lerp(2.6, 1, slam) * (1 + lift * 0.35) * (1 + M.wave(t, 75) * 0.012 * ambient);
        place(ctx, {
          x: cx + shakeX + driftX,
          y: cy + shakeY + driftY,
          rotate: deg(M.lerp(-26, -8, slam) + M.wave(t, 150) * 2 * ambient),
          scaleX: scale * (1 + impact * 0.16),
          scaleY: scale * (1 - impact * 0.16),
          alpha: M.progress(t, 4, 9) * (1 - lift)
        }, () => {
          M.slabUnder(ctx, (fresh) => sealPath(ctx, 196, 176, 24, fresh), 12, 12, theme.line, {
            x: -200, y: -200, w: 414, h: 414
          });
          sealPath(ctx, 196, 176, 24);
          ctx.fillStyle = p.color;
          ctx.fill();
          ctx.lineWidth = 6;
          ctx.strokeStyle = theme.line;
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(0, 0, 138, 0, TAU);
          ctx.setLineDash([14, 12]);
          ctx.lineDashOffset = -t * 0.6 * ambient;
          ctx.lineWidth = 5;
          ctx.strokeStyle = inkOn(p.color, theme);
          ctx.stroke();
          ctx.setLineDash([]);

          const text = M.fitText(ctx, p.label || ' ', { maxWidth: 240, maxLines: 1, max: 118, min: 40 });
          ctx.font = M.font(text.size);
          centeredLines(ctx, text.lines, { x: 0, y: 0, size: text.size, color: inkOn(p.color, theme) });
        });

        if (p.sublabel) {
          const rise = M.spring({ frame: t, fps: FPS, delay: 26, config: { damping: 12, stiffness: 130 } });
          const way = flow || DOWN;
          ctx.font = M.font(32, 800);
          const w = ctx.measureText(p.sublabel).width + 56;
          place(ctx, {
            x: cx + way.x * 60 * sink,
            y: 530 + (1 - rise) * 50 + M.wave(idle, 90) * 3 * calm + way.y * 60 * sink,
            alpha: M.clamp(rise * 1.5, 0, 1) * (1 - sink)
          }, () => {
            M.slabBox(ctx, {
              x: -w / 2, y: -34, w, h: 68,
              r: 34, fill: theme.surface, line: theme.line, lineWidth: 5, slab: 7
            });
            ctx.font = M.font(32, 800);
            ctx.fillStyle = theme.ink;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(p.sublabel, 0, 2);
          });
        }
      });
    }
  };

  // ==========================================
  // SCENE: TICKER
  // ==========================================

  const TICKER_ROWS = [0.2, 0.5, 0.8];

  const ticker = {
    id: 'ticker',
    name: 'Ticker',
    description: 'Rows of chunky word pills scroll past behind your headline.',
    schema: [
      { key: 'headline', type: 'text', label: 'Headline', max: 32, default: "What's new in klndr" },
      { key: 'words', type: 'list', label: 'Words', max: 16, maxItems: 10, default: ['Faster', 'Smoother', 'Dark mode', 'Stories', 'Reactions', 'Studio', 'Motion', 'Polish'] },
      { key: 'accent', type: 'color', label: 'Headline colour', default: '#9ae659' },
      { key: 'background', type: 'color', label: 'Background', optional: true, default: '' }
    ],
    // The last row is in by 28; the plate settles by 30.
    intro: 32,
    ground: (p, theme) => p.background || theme.ground,
    describe: (p) => p.headline,
    // Laid out across the whole canvas rather than on the stage: a ticker that
    // stopped short of the edges on a wide header would not be a ticker.
    render(ctx, clock, p, env) {
      const { t, exit, ambient } = clock;
      const theme = env.theme;
      const W = env.width;
      const s = M.clamp(env.height / BASE_HEIGHT, 0.6, 1.3);

      // Each row is a strip of pills with a front end and, once it is leaving,
      // a back end. In, it slides on from its own side, front first; idle, it
      // cruises; out, it races off the other way. Worked out as if every row
      // travelled leftwards, then mirrored for the rows that travel right.
      const rows = TICKER_ROWS.map((fraction, row) => ({
        fraction,
        row,
        enter: M.progress(t, row * 4, row * 4 + 20, Easing.out(Easing.cubic)),
        leave: M.outOf(clock, 2 + row * 3, 12 + row * 3, Easing.in(Easing.cubic))
      })).filter((r) => r.enter > EPS && r.leave < 1 - EPS);

      if (rows.length) {
        ctx.save();
        ctx.translate(W / 2, env.height / 2);
        ctx.rotate(deg(-5));
        ctx.translate(-W / 2, -env.height / 2);

        rows.forEach(({ fraction, row, enter, leave }) => {
          const y = env.height * fraction;
          const h = 84 * s;
          const words = p.words.map((_, k) => p.words[(k + row * 3) % p.words.length]);
          ctx.font = M.font(42 * s);

          const tiles = [];
          let cursor = 0;
          words.forEach((word, k) => {
            const w = ctx.measureText(word).width + 64 * s;
            tiles.push({ word, x: cursor, w, colour: Palette.colors[(k * 2 + row * 5) % Palette.colors.length] });
            cursor += w + 24 * s;
          });

          const period = Math.max(cursor, 1);
          const leftwards = row % 2 === 0;
          // Today's pace: one whole row every five seconds.
          const scrollAt = (frame) => (frame * period * ambient) / 150;
          const scroll = scrollAt(t);
          const slide = (1 - enter) * (W + 1000);
          const race = leave * (W + 1400);
          const front = scrollAt(row * 4 + 20) - 700;
          const back = exit > 0 ? scrollAt(t - exit) + W + 500 : Infinity;
          const shift = scroll - slide + race;

          const first = Math.floor((shift - 600 - period) / period);
          const last = Math.ceil((shift + W + 600) / period);
          for (let rep = first; rep <= last; rep++) {
            for (const tile of tiles) {
              const base = rep * period + tile.x;
              if (base < front || base > back) continue;
              const along = base - 200 - shift;
              if (along > W + 40 || along + tile.w < -40) continue;
              const x = leftwards ? along : W - along - tile.w;
              M.slabBox(ctx, {
                x, y: y - h / 2, w: tile.w, h,
                r: h / 2, fill: M.taskFill(tile.colour, theme), line: theme.onColorLine, lineWidth: 4 * s, slab: 6 * s
              });
              ctx.font = M.font(42 * s);
              ctx.fillStyle = theme.onColorInk;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(tile.word, x + tile.w / 2, y + 2 * s);
            }
          }
        });
        ctx.restore();
      }

      const plateIn = M.spring({ frame: t, fps: FPS, delay: 8, config: { damping: 11, stiffness: 150 } });
      const plateOut = M.outOf(clock, 0, 10, Easing.back(1.6));
      const { size, lines } = M.fitText(ctx, p.headline || ' ', {
        maxWidth: 620 * s,
        maxLines: 2,
        max: 70 * s,
        min: 34 * s,
        step: 2
      });
      ctx.font = M.font(size);
      const textW = Math.max(120, ...lines.map((line) => ctx.measureText(line).width));
      const plateW = textW + 100 * s;
      const plateH = lines.length * size * 1.06 + 70 * s;

      place(ctx, {
        x: W / 2,
        y: env.height / 2,
        rotate: deg(M.lerp(-12, -3, M.clamp(plateIn, 0, 1)) + M.wave(t, 150) * 1.5 * ambient),
        scaleX: plateIn * (1 - plateOut) * (1 + M.wave(t, 75) * 0.025 * ambient),
        alpha: M.clamp(plateIn * 2, 0, 1)
      }, () => {
        M.slabBox(ctx, {
          x: -plateW / 2, y: -plateH / 2, w: plateW, h: plateH,
          r: 26 * s, fill: p.accent, line: theme.line, lineWidth: 5, slab: 12 * s
        });
        ctx.font = M.font(size);
        centeredLines(ctx, lines, { x: 0, y: 0, size, color: inkOn(p.accent, theme) });
      });
    }
  };

  // ==========================================
  // SCENE: FLIP BOARD
  // ==========================================

  const FLAP_GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789&?!';
  const FLAP_FRAMES = 2;
  // Idle re-flips: the first a second and a half in, then one every 2.5 seconds.
  const REFLIP_FIRST = 45;
  const REFLIP_EVERY = 75;
  const flipPlans = new Map();

  // Words into tiles, a row at a time. A word longer than a row is cut across
  // rows, as a real board would have to.
  function wrapTiles(words, cols) {
    const rows = [];
    let row = [];
    for (const word of words) {
      if (row.length && row.length + 1 + word.length > cols) {
        rows.push(row);
        row = [];
      }
      if (row.length) row.push(' ');
      for (const char of word) {
        if (row.length >= cols) {
          rows.push(row);
          row = [];
        }
        row.push(char);
      }
    }
    if (row.length) rows.push(row);
    return rows;
  }

  // The fewest columns that fit the headline in two rows, so a short headline
  // gets big tiles and a long one still fits.
  function boardLayout(text) {
    const words = text.toUpperCase().split(' ').filter(Boolean).map((word) => Array.from(word));
    if (!words.length) return { rows: [[]], cols: 8 };
    const total = words.reduce((sum, word) => sum + word.length, 0) + words.length - 1;
    const longest = Math.max(...words.map((word) => word.length));
    for (let cols = M.clamp(Math.max(longest, Math.ceil(total / 2)), 6, 20); cols <= 20; cols++) {
      const rows = wrapTiles(words, cols);
      if (rows.length <= 2) return { rows, cols };
    }
    return { rows: wrapTiles(words, 20).slice(0, 2), cols: 20 };
  }

  // Every tile's letter, and the seeded run of letters it flips through first.
  function flipPlan(text) {
    if (flipPlans.has(text)) return flipPlans.get(text);
    if (flipPlans.size > 64) flipPlans.clear();
    const { rows, cols } = boardLayout(text);
    const rand = M.random(`flip-board:${text}`);
    const tiles = [];
    let count = 0;
    let landed = 0;
    rows.forEach((row, r) => {
      const lead = Math.floor((cols - row.length) / 2);
      for (let c = 0; c < cols; c++) {
        const char = row[c - lead] && row[c - lead] !== ' ' ? row[c - lead] : '';
        const spins = Array.from({ length: 8 }, () => FLAP_GLYPHS[Math.floor(rand() * FLAP_GLYPHS.length)]);
        const tile = { r, c, char, order: char ? count++ : -1, flips: 3 + Math.floor(rand() * 6), spins };
        if (char) landed = Math.max(landed, flipStart(tile) + tile.flips * FLAP_FRAMES + 6);
        tiles.push(tile);
      }
    });
    const plan = { rows: rows.length, cols, tiles, count, landed };
    flipPlans.set(text, plan);
    return plan;
  }

  function flipStart(tile) {
    return 18 + tile.order * 2.5;
  }

  // What a tile shows: nothing, a letter mid-flip - squashed while its flap
  // falls - or its own letter, landing with a little bounce. On the way out the
  // letters flip away, last one first; while idle, now and then one tile
  // shuffles through two letters and lands back on its own.
  function flapFace(tile, t, exit, count, reflip) {
    const blank = { glyph: '', squash: 1 };
    if (!tile.char) return blank;
    const squash = (elapsed) => 1 - 0.5 * Math.sin((Math.PI * (elapsed % FLAP_FRAMES)) / FLAP_FRAMES);

    const outAt = 1 + (count - 1 - tile.order) * Math.min(1, 7 / Math.max(1, count - 1));
    if (exit >= outAt) {
      const elapsed = exit - outAt;
      return elapsed < FLAP_FRAMES ? { glyph: tile.spins[0], squash: squash(elapsed) } : blank;
    }

    const start = flipStart(tile);
    if (t < start) return blank;
    const step = Math.floor((t - start) / FLAP_FRAMES);
    if (step < tile.flips) return { glyph: tile.spins[step], squash: squash(t - start) };
    const landed = t - start - tile.flips * FLAP_FRAMES;
    if (landed < 6) return { glyph: tile.char, squash: 1 + 0.12 * Math.sin((Math.PI * landed) / 6) };

    if (reflip && reflip.order === tile.order) {
      const local = reflip.local;
      if (local < 2 * FLAP_FRAMES) {
        return { glyph: tile.spins[(reflip.index + Math.floor(local / FLAP_FRAMES)) % tile.spins.length], squash: squash(local) };
      }
      const back = local - 2 * FLAP_FRAMES;
      if (back < 6) return { glyph: tile.char, squash: 1 + 0.12 * Math.sin((Math.PI * back) / 6) };
    }
    return { glyph: tile.char, squash: 1 };
  }

  function pickReflip(text, idle, count) {
    if (idle < REFLIP_FIRST || !count) return null;
    const { index, local } = M.beat(idle - REFLIP_FIRST, REFLIP_EVERY);
    const order = Math.floor(M.random(`flip-idle:${text}:${index}`)() * count);
    return { order, index, local };
  }

  const flipBoard = {
    id: 'flip-board',
    name: 'Flip board',
    description: 'Your headline clatters in letter by letter on a split-flap board, like a departures sign.',
    schema: [
      { key: 'eyebrow', type: 'text', label: 'Tag', max: 18, default: 'NOW ARRIVING' },
      { key: 'headline', type: 'text', label: 'Headline', max: 28, default: 'Fresh features' },
      { key: 'accent', type: 'color', label: 'Board colour', default: '#fde047' },
      { key: 'background', type: 'color', label: 'Background', optional: true, default: '' }
    ],
    intro: (p) => Math.max(44, flipPlan(p.headline).landed),
    ground: (p, theme) => p.background || theme.ground,
    describe: (p) => [p.eyebrow, p.headline].filter(Boolean).join(': '),
    render(ctx, clock, p, env) {
      const { t, idle, exit, ambient } = clock;
      const theme = env.theme;
      const flow = flowOf(env, DOWN);

      onStage(ctx, env, () => {
        const plan = flipPlan(p.headline);
        const gap = 8;
        const rowGap = 14;
        const pad = 34;
        const tileW = Math.min(92, (940 - (plan.cols - 1) * gap) / plan.cols);
        const tileH = tileW * 1.32;
        const boardW = plan.cols * tileW + (plan.cols - 1) * gap + pad * 2;
        const boardH = plan.rows * tileH + (plan.rows - 1) * rowGap + pad * 2;
        const boardFill = M.taskFill(p.accent, theme);

        const drop = M.outOf(clock, 6, OUTRO, Easing.in(Easing.cubic));
        const boardIn = M.spring({ frame: t, fps: FPS, delay: 2, config: { damping: 12, stiffness: 120 } });
        const tagIn = M.spring({ frame: t, fps: FPS, delay: 12, config: { damping: 9, stiffness: 150 } });
        const reflip = ambient > 0.5 && exit === 0 ? pickReflip(p.headline, idle, plan.count) : null;

        place(ctx, {
          x: 600 + flow.x * 80 * drop,
          y: 330 + M.wave(t, 90) * 5 * ambient + flow.y * 80 * drop,
          rotate: deg(M.lerp(5, -1.5, boardIn) + (flow.x < 0 ? -6 : 6) * drop),
          scaleX: 0.7 + 0.3 * boardIn,
          alpha: M.clamp(boardIn * 1.5, 0, 1) * (1 - drop)
        }, () => {
          const left = -boardW / 2;
          const top = -boardH / 2;
          M.slabBox(ctx, {
            x: left, y: top, w: boardW, h: boardH,
            r: 26, fill: boardFill, line: theme.line, lineWidth: 5, slab: 12
          });
          ctx.fillStyle = theme.line;
          for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
            ctx.beginPath();
            ctx.arc(sx * (boardW / 2 - 16), sy * (boardH / 2 - 16), 5, 0, TAU);
            ctx.fill();
          }

          ctx.font = M.font(tileH * 0.6);
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          for (const tile of plan.tiles) {
            const x = left + pad + tile.c * (tileW + gap) + tileW / 2;
            const y = top + pad + tile.r * (tileH + rowGap) + tileH / 2;
            M.roundRectPath(ctx, x - tileW / 2, y - tileH / 2, tileW, tileH, 8);
            ctx.fillStyle = theme.ink;
            ctx.fill();
            const face = flapFace(tile, t, exit, plan.count, reflip);
            if (face.glyph) {
              place(ctx, { x, y, scaleY: face.squash }, () => {
                ctx.fillStyle = theme.surface;
                ctx.fillText(face.glyph, 0, tileH * 0.04);
              });
            }
            // The seam between a tile's two flaps.
            ctx.strokeStyle = boardFill;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(x - tileW / 2, y);
            ctx.lineTo(x + tileW / 2, y);
            ctx.stroke();
          }

          if (p.eyebrow) {
            place(ctx, {
              x: left + 30,
              y: top,
              rotate: deg(-4),
              scaleX: tagIn,
              alpha: M.clamp(tagIn * 2, 0, 1)
            }, () => {
              ctx.font = M.font(26);
              const w = ctx.measureText(p.eyebrow).width + 78;
              M.slabBox(ctx, {
                x: 0, y: -28, w, h: 56,
                r: 28, fill: theme.surface, line: theme.line, lineWidth: 4, slab: 6
              });
              place(ctx, { x: 30, y: 0, alpha: 0.3 + 0.7 * M.lerp(1, M.swell(t, 30), ambient) }, () => {
                ctx.beginPath();
                ctx.arc(0, 0, 9, 0, TAU);
                ctx.fillStyle = boardFill;
                ctx.fill();
                ctx.lineWidth = 3;
                ctx.strokeStyle = theme.line;
                ctx.stroke();
              });
              ctx.font = M.font(26);
              ctx.fillStyle = theme.ink;
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText(p.eyebrow, 50, 2);
            });
          }
        });
      });
    }
  };

  // ==========================================
  // SCENE: SHORTCUT KEYS
  // ==========================================

  const KEY_H = 150;
  const KEY_SLAB = 14;
  const KEY_PLUS = 84;
  const KEY_SPARKS = [
    [140, 110, 28, 0],
    [1065, 120, 34, 0.3],
    [1095, 370, 24, 0.55],
    [110, 350, 30, 0.8]
  ];

  const keycaps = {
    id: 'keycaps',
    name: 'Shortcut keys',
    description: 'Chunky keys drop in and press down together, then your caption pops up. Made for shortcut news.',
    schema: [
      { key: 'keys', type: 'list', label: 'Keys', max: 8, maxItems: 4, default: ['Ctrl', 'K'] },
      { key: 'headline', type: 'text', label: 'Caption', max: 36, default: 'Jump to anything' },
      { key: 'accent', type: 'color', label: 'Pressed colour', default: '#9ae659' },
      { key: 'background', type: 'color', label: 'Background', optional: true, default: '' }
    ],
    // The caption and the sparkles have both landed 28 frames after the combo.
    intro: (p) => 78 + 10 * (p.keys.length - 1),
    ground: (p, theme) => p.background || theme.mint,
    describe: (p) => [p.keys.join(' + '), p.headline].filter(Boolean).join(': '),
    render(ctx, clock, p, env) {
      const { t, idle, ambient } = clock;
      const theme = env.theme;
      const flow = env.flow;

      onStage(ctx, env, () => {
        const keys = p.keys;
        const n = keys.length;
        const accent = M.taskFill(p.accent, theme);
        ctx.font = M.font(60);
        const widths = keys.map((label) => Math.max(150, ctx.measureText(label).width + 84));
        const total = widths.reduce((sum, w) => sum + w, 0) + KEY_PLUS * (n - 1);
        const fit = Math.min(1, 1040 / total);

        // One key after another goes down and stays down; the combo lands when
        // the last one does.
        const pressAt = (i) => 44 + i * 10;
        const combo = pressAt(n - 1) + 6;
        const calm = M.rampIn(idle, 20) * ambient;
        const release = M.outOf(clock, 0, 4, Easing.out(Easing.cubic));

        const ring = M.progress(t, combo, combo + 20, Easing.out(Easing.quad));
        if (ring > EPS && ring < 1 - EPS) {
          ctx.save();
          ctx.globalAlpha = ctx.globalAlpha * (1 - ring);
          ctx.strokeStyle = theme.line;
          ctx.lineWidth = 6;
          ctx.beginPath();
          ctx.ellipse(600, 250, (total * fit) / 2 + M.lerp(30, 140, ring), M.lerp(96, 180, ring), 0, 0, TAU);
          ctx.stroke();
          ctx.restore();
        }

        place(ctx, { x: 600, y: 240, scaleX: fit }, () => {
          let x = -total / 2;
          keys.forEach((label, i) => {
            const w = widths[i];
            const drop = M.spring({ frame: t, fps: FPS, delay: 4 + i * 6, config: { damping: 10, stiffness: 140 } });
            // Idle: the held keys breathe on their slabs, one after another.
            const breathe = calm * M.swell(idle, 70, -i * 0.15);
            const press = M.progress(t, pressAt(i), pressAt(i) + 5, Easing.out(Easing.cubic)) *
              (1 - 0.15 * breathe) * (1 - release);
            const out = M.outOf(clock, 4 + i * 2, 12 + i * 2, Easing.back(1.4));

            place(ctx, {
              x: x + w / 2 + (flow ? flow.x * 70 * out : 0),
              y: M.lerp(-420, 0, drop) + (flow ? flow.y * 70 * out : 0),
              rotate: deg((1 - M.clamp(drop, 0, 1)) * (i % 2 ? 12 : -12)),
              scaleX: 1 - out,
              alpha: M.clamp(drop * 3, 0, 1) * (1 - out)
            }, () => {
              // Pressing slides the key down onto its own slab.
              const shift = KEY_SLAB * press;
              M.slabBox(ctx, {
                x: -w / 2 + shift, y: -KEY_H / 2 + shift, w, h: KEY_H,
                r: 24, fill: M.mix(accent, theme.surface, press), line: theme.line, lineWidth: 5, slab: KEY_SLAB - shift
              });
              // The dish a fingertip rests in.
              M.roundRectPath(ctx, -w / 2 + shift + 14, -KEY_H / 2 + shift + 12, w - 28, KEY_H - 36, 16);
              ctx.strokeStyle = M.alpha(theme.ink, 0.14);
              ctx.lineWidth = 3;
              ctx.stroke();
              ctx.font = M.font(60);
              ctx.fillStyle = press > 0.5 ? inkOn(accent, theme) : theme.ink;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(label, shift, shift - 2);
            });

            if (i < n - 1) {
              const plusIn = M.spring({ frame: t, fps: FPS, delay: 10 + i * 6, config: { damping: 9, stiffness: 160 } });
              const plusOut = M.outOf(clock, 0, 6);
              place(ctx, {
                x: x + w + KEY_PLUS / 2,
                y: 0,
                scaleX: plusIn * (1 - plusOut),
                alpha: M.clamp(plusIn * 2, 0, 1) * (1 - plusOut)
              }, () => {
                ctx.font = M.font(64);
                ctx.fillStyle = theme.inkSoft;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('+', 0, 4);
              });
            }
            x += w + KEY_PLUS;
          });
        });

        const sparkle = M.spring({ frame: t, fps: FPS, delay: combo, config: { damping: 8, stiffness: 150 } }) *
          (1 - M.outOf(clock, 0, 8));
        KEY_SPARKS.forEach(([x, y, r, phase]) => {
          place(ctx, {
            x,
            y,
            rotate: t * 0.03 * ambient,
            scaleX: sparkle * M.lerp(0.9, 0.8 + 0.2 * M.wave(t, 60, phase), ambient),
            alpha: M.clamp(sparkle * 2, 0, 1)
          }, () => {
            sparklePath(ctx, r);
            ctx.fillStyle = accent;
            ctx.fill();
            ctx.lineWidth = 4;
            ctx.strokeStyle = theme.line;
            ctx.stroke();
          });
        });

        if (p.headline) {
          const rise = M.spring({ frame: t, fps: FPS, delay: combo + 4, config: { damping: 11, stiffness: 140 } });
          const sink = M.outOf(clock, 0, 12, Easing.in(Easing.cubic));
          const way = flow || DOWN;
          place(ctx, {
            x: 600 + way.x * 90 * sink,
            y: 480 + (1 - rise) * 60 + M.wave(idle, 90) * 3 * calm + way.y * 90 * sink,
            rotate: deg(M.lerp(-6, -2, M.clamp(rise, 0, 1))),
            scaleX: 0.8 + 0.2 * rise,
            alpha: M.clamp(rise * 1.6, 0, 1) * (1 - sink)
          }, () => {
            const caption = M.fitText(ctx, p.headline, { maxWidth: 860, maxLines: 1, max: 52, min: 28 });
            const text = caption.lines[0] || '';
            ctx.font = M.font(caption.size);
            const w = ctx.measureText(text).width + 84;
            M.slabBox(ctx, {
              x: -w / 2, y: -44, w, h: 88,
              r: 44, fill: theme.surface, line: theme.line, lineWidth: 5, slab: 8
            });
            ctx.font = M.font(caption.size);
            ctx.fillStyle = theme.ink;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, 0, 3);
          });
        }
      });
    }
  };

  // ==========================================
  // SCENE: CHAT
  // ==========================================

  const CHAT_GAP = 18;
  const TYPING_W = 124;
  const TYPING_H = 64;

  // A speech bubble: round, but for the bottom corner its tail leaves from.
  function bubblePath(ctx, x, y, w, h, tailRight, fresh = true) {
    const r = Math.min(26, h / 2);
    if (fresh) ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, tailRight ? 4 : r);
    ctx.arcTo(x, y + h, x, y, tailRight ? r : 4);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function bubble(ctx, { x, y, w, h, tailRight, fill, line }) {
    M.slabUnder(ctx, (fresh) => bubblePath(ctx, x, y, w, h, tailRight, fresh), 6, 6, line, {
      x: x - 1, y: y - 1, w: w + 8, h: h + 8
    });
    bubblePath(ctx, x, y, w, h, tailRight);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = line;
    ctx.stroke();
  }

  const chat = {
    id: 'chat',
    name: 'Chat',
    description: 'Messages pop up one after another, typing dots and all, like a chat about your news.',
    schema: [
      {
        key: 'messages', type: 'list', label: 'Messages', max: 44, maxItems: 4,
        default: ['Did you see the update?', 'Dark mode is finally here 🌙', 'Trying it right now 🎉']
      },
      { key: 'accent', type: 'color', label: 'Reply colour', default: '#3ba4f6' },
      { key: 'background', type: 'color', label: 'Background', optional: true, default: '' }
    ],
    intro: (p) => 44 + 26 * (p.messages.length - 1),
    ground: (p, theme) => p.background || theme.ground,
    describe: (p) => p.messages.join(' / '),
    render(ctx, clock, p, env) {
      const { t, idle, ambient } = clock;
      const theme = env.theme;
      const flow = flowOf(env, UP);

      onStage(ctx, env, () => {
        const calm = M.rampIn(idle, 24) * ambient;
        // Every other message is the reply: on the right, in the accent.
        const bubbles = p.messages.map((text, i) => {
          const fit = M.fitText(ctx, text, { maxWidth: 560, maxLines: 2, max: 36, min: 24, step: 2, weight: 800 });
          ctx.font = M.font(fit.size, 800);
          const lineH = fit.size * 1.2;
          const textW = Math.max(40, ...fit.lines.map((line) => ctx.measureText(line).width));
          const mine = i % 2 === 1;
          const at = 18 + i * 26;
          return {
            lines: fit.lines,
            size: fit.size,
            lineH,
            w: textW + 56,
            h: fit.lines.length * lineH + 36,
            mine,
            at,
            speaks: at - (mine ? 4 : 14)
          };
        });
        // The stack grows up from a baseline that leaves the finished chat centred.
        const finalH = bubbles.reduce((sum, b) => sum + b.h, 0) + CHAT_GAP * (bubbles.length - 1);
        const base = Math.min(566, 300 + finalH / 2);
        const soft = { damping: 14, stiffness: 170 };

        // The room each message has taken so far: none, a typing bubble's, its own.
        const room = bubbles.map((b) => {
          const push = M.clamp(M.spring({ frame: t, fps: FPS, delay: b.speaks, config: soft }), 0, 1);
          const grow = M.clamp(M.spring({ frame: t, fps: FPS, delay: b.at, config: soft }), 0, 1);
          return ((b.mine ? b.h : M.lerp(TYPING_H, b.h, grow)) + CHAT_GAP) * push;
        });

        bubbles.forEach((b, i) => {
          const bottom = base - room.slice(i + 1).reduce((sum, h) => sum + h, 0);
          // Out: oldest first, each one popping away.
          const gone = M.outOf(clock, i * 2, 12 + i * 2, Easing.back(1.5));
          // Idle: the conversation floats, each bubble a beat behind the last.
          const float = M.wave(idle, 100, -i * 0.15) * 3 * calm;

          if (!b.mine) {
            const typing = M.spring({ frame: t, fps: FPS, delay: b.speaks, config: { damping: 12, stiffness: 180 } });
            const done = M.progress(t, b.at - 2, b.at + 3);
            place(ctx, {
              x: 150,
              y: bottom,
              scaleX: M.clamp(typing, 0, 1.2) * (1 - done),
              alpha: M.clamp(typing * 2.5, 0, 1) * (1 - done)
            }, () => {
              bubble(ctx, { x: 0, y: -TYPING_H, w: TYPING_W, h: TYPING_H, tailRight: false, fill: theme.surface, line: theme.line });
              ctx.fillStyle = theme.inkSoft;
              for (let k = 0; k < 3; k++) {
                const hop = Math.max(0, Math.sin((t - b.speaks) * 0.5 - k * 0.9));
                ctx.beginPath();
                ctx.arc(34 + k * 28, -TYPING_H / 2 - hop * 8, 8, 0, TAU);
                ctx.fill();
              }
            });
          }

          // Pops from its tail's corner, the way a message arrives.
          const pop = M.spring({ frame: t, fps: FPS, delay: b.at, config: { damping: 11, stiffness: 170 } });
          place(ctx, {
            x: (b.mine ? 1050 : 150) + flow.x * 30 * gone,
            y: bottom + float + flow.y * 30 * gone,
            scaleX: M.clamp(pop, 0, 1.2) * (1 - gone),
            alpha: M.clamp(pop * 2.5, 0, 1) * (1 - gone)
          }, () => {
            const x = b.mine ? -b.w : 0;
            bubble(ctx, {
              x, y: -b.h, w: b.w, h: b.h,
              tailRight: b.mine,
              fill: b.mine ? M.taskFill(p.accent, theme) : theme.surface,
              line: b.mine ? theme.onColorLine : theme.line
            });
            ctx.font = M.font(b.size, 800);
            ctx.fillStyle = b.mine ? theme.onColorInk : theme.ink;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            b.lines.forEach((text, k) => ctx.fillText(text, x + 28, -b.h + 18 + b.lineH * (k + 0.5) + 2));
          });
        });
      });
    }
  };

  // ==========================================
  // SCENE: POINT AND CLICK
  // ==========================================

  // The pointer from motion/src/klndr/brand.tsx, on its 32x45 grid, with the tip
  // at the origin.
  const CURSOR = [[2, 2], [2, 36], [11, 28], [17.5, 42], [24, 39], [17.5, 25.5], [29, 25.5]];
  const CLICK_SPARKS = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

  function cursorPath(ctx, scale) {
    ctx.beginPath();
    CURSOR.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo((x - 2) * scale, (y - 2) * scale);
      else ctx.lineTo((x - 2) * scale, (y - 2) * scale);
    });
    ctx.closePath();
  }

  // A callout's box and the tail pointing down out of it as one outline, with
  // the tip of the tail at the origin.
  function calloutPath(ctx, w, h, tail, fresh = true) {
    const x = -w / 2;
    const y = -tail - h;
    const r = Math.min(24, h / 2);
    if (fresh) ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.lineTo(tail, y + h);
    ctx.lineTo(0, 0);
    ctx.lineTo(-tail, y + h);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  const pointClick = {
    id: 'point-click',
    name: 'Point and click',
    description: 'A cursor glides over and clicks your button, then a callout with your headline pops out.',
    schema: [
      { key: 'button', type: 'text', label: 'Button', max: 16, default: 'Try it' },
      { key: 'headline', type: 'text', label: 'Callout', max: 40, default: 'One click away' },
      { key: 'accent', type: 'color', label: 'Button colour', default: '#9ae659' },
      { key: 'background', type: 'color', label: 'Background', optional: true, default: '' }
    ],
    // The callout has landed and the cursor has stepped aside by 94.
    intro: 94,
    ground: (p, theme) => p.background || theme.ground,
    describe: (p) => [p.headline, p.button].filter(Boolean).join(': '),
    render(ctx, clock, p, env) {
      const { t, idle, ambient } = clock;
      const theme = env.theme;
      const flow = flowOf(env, DOWN);

      onStage(ctx, env, () => {
        const W = 800;
        const H = 380;
        const CX = 600;
        const CY = 330;
        const BUTTON_Y = 84;
        const CLICK = 60;
        const accent = M.taskFill(p.accent, theme);
        const calm = M.rampIn(idle, 24) * ambient;

        const drop = M.outOf(clock, 4, OUTRO, Easing.in(Easing.cubic));
        const unpop = M.outOf(clock, 0, 8, Easing.back(1.6));
        const flick = M.outOf(clock, 0, 12, Easing.in(Easing.cubic));
        const paneIn = M.spring({ frame: t, fps: FPS, delay: 2, config: { damping: 13, stiffness: 130 } });
        const buttonIn = M.spring({ frame: t, fps: FPS, delay: 10, config: { damping: 9, stiffness: 150 } });
        const glide = M.progress(t, 16, 52, Easing.inOut(Easing.cubic));
        // After the click the cursor steps aside, so the button reads.
        const aside = M.progress(t, 72, 90, Easing.inOut(Easing.cubic));
        const hover = M.progress(t, 46, 54) * (1 - M.progress(t, 72, 80));
        // Idle: the button breathes on its slab, asking to be clicked again.
        const breathe = M.swell(idle, 90) * calm;
        const press = M.progress(t, CLICK, CLICK + 4, Easing.out(Easing.quad)) *
          (1 - M.progress(t, CLICK + 5, CLICK + 11, Easing.out(Easing.quad)));
        const pop = M.spring({ frame: t, fps: FPS, delay: CLICK + 6, config: { damping: 10, stiffness: 160 } });
        const spark = M.spring({ frame: t, fps: FPS, delay: CLICK, config: { damping: 8, stiffness: 150 } }) *
          (1 - M.outOf(clock, 0, 6));

        ctx.font = M.font(44);
        const label = p.button || ' ';
        const bw = Math.max(200, ctx.measureText(label).width + 90);
        const bh = 92;

        place(ctx, {
          x: CX + flow.x * 60 * drop,
          y: CY + flow.y * 60 * drop,
          scaleX: 0.85 + 0.15 * paneIn,
          alpha: M.clamp(paneIn * 1.5, 0, 1) * (1 - drop)
        }, () => {
          const left = -W / 2;
          const top = -H / 2;
          M.slabBox(ctx, {
            x: left, y: top, w: W, h: H,
            r: 26, fill: theme.surface, line: theme.line, lineWidth: 5, slab: 12
          });

          // A little klndr window: the strip with its plate, the calendar's
          // faint grid below.
          ctx.save();
          M.roundRectPath(ctx, left, top, W, H, 26);
          ctx.clip();
          ctx.fillStyle = theme.tray;
          ctx.fillRect(left, top, W, 64);
          ctx.strokeStyle = M.alpha(theme.ink, 0.08);
          ctx.lineWidth = 2;
          ctx.beginPath();
          for (let gx = left + 100; gx < -left; gx += 100) {
            ctx.moveTo(gx, top + 64);
            ctx.lineTo(gx, -top);
          }
          ctx.stroke();
          ctx.restore();
          ctx.strokeStyle = theme.line;
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.moveTo(left, top + 64);
          ctx.lineTo(-left, top + 64);
          ctx.stroke();

          M.slabBox(ctx, {
            x: left + 20, y: top + 13, w: 38, h: 38,
            r: 9, fill: theme.mint, line: theme.line, lineWidth: 4, slab: 0
          });
          ctx.font = M.font(26);
          ctx.fillStyle = theme.ink;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('k', left + 39, top + 33);
          [[76, 120], [212, 80]].forEach(([dx, w]) => {
            M.slabBox(ctx, {
              x: left + dx, y: top + 20, w, h: 24,
              r: 12, fill: theme.surface, line: M.alpha(theme.ink, 0.3), lineWidth: 3, slab: 0
            });
          });

          const ring = M.progress(t, CLICK, CLICK + 18, Easing.out(Easing.quad));
          if (ring > EPS && ring < 1 - EPS) {
            ctx.save();
            ctx.globalAlpha = ctx.globalAlpha * (1 - ring);
            ctx.strokeStyle = theme.line;
            ctx.lineWidth = 5;
            M.roundRectPath(
              ctx,
              -bw / 2 - ring * 40, BUTTON_Y - bh / 2 - ring * 40,
              bw + ring * 80, bh + ring * 80,
              20 + ring * 40
            );
            ctx.stroke();
            ctx.restore();
          }

          const raised = (hover * 4 + breathe * 2) * (1 - press);
          place(ctx, {
            x: 0,
            y: BUTTON_Y - raised,
            scaleX: buttonIn,
            alpha: M.clamp(buttonIn * 2, 0, 1)
          }, () => {
            // Lifts a little under the pointer, and goes down onto its slab when clicked.
            const shift = 8 * press;
            M.slabBox(ctx, {
              x: -bw / 2 + shift, y: -bh / 2 + shift, w: bw, h: bh,
              r: 20, fill: accent, line: theme.line, lineWidth: 5, slab: 8 - shift + raised * 0.75
            });
            ctx.font = M.font(44);
            ctx.fillStyle = inkOn(accent, theme);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, shift, shift + 2);
          });

          CLICK_SPARKS.forEach(([sx, sy], i) => {
            place(ctx, {
              x: sx * (bw / 2 + 46),
              y: BUTTON_Y + sy * (bh / 2 + 30),
              rotate: t * 0.04 * sx * ambient,
              scaleX: spark * M.lerp(0.9, 0.8 + 0.2 * M.wave(t, 75, i * 0.25), ambient),
              alpha: M.clamp(spark * 2, 0, 1)
            }, () => {
              sparklePath(ctx, 18);
              ctx.fillStyle = accent;
              ctx.fill();
              ctx.lineWidth = 4;
              ctx.strokeStyle = theme.line;
              ctx.stroke();
            });
          });

          if (p.headline) {
            place(ctx, {
              x: 0,
              y: BUTTON_Y - bh / 2 - 10 + M.wave(idle, 90) * 3 * calm,
              scaleX: M.clamp(pop, 0, 1.3) * (1 - unpop),
              alpha: M.clamp(pop * 2, 0, 1) * (1 - unpop)
            }, () => {
              const tail = 22;
              const text = M.fitText(ctx, p.headline, { maxWidth: 600, maxLines: 2, max: 44, min: 28 });
              ctx.font = M.font(text.size);
              const w = Math.max(160, ...text.lines.map((line) => ctx.measureText(line).width)) + 70;
              const h = text.lines.length * text.size * 1.08 + 40;
              M.slabUnder(ctx, (fresh) => calloutPath(ctx, w, h, tail, fresh), 8, 8, theme.line, {
                x: -w / 2 - 1, y: -tail - h - 1, w: w + 10, h: h + tail + 10
              });
              calloutPath(ctx, w, h, tail);
              ctx.fillStyle = theme.ink;
              ctx.fill();
              ctx.lineWidth = 4;
              ctx.strokeStyle = theme.line;
              ctx.stroke();
              ctx.font = M.font(text.size);
              centeredLines(ctx, text.lines, { x: 0, y: -tail - h / 2, size: text.size, color: theme.surface });
            });
          }
        });

        // In along a curve to rest on the button, then a step aside to wait.
        const tipX = CX + bw * 0.18;
        const tipY = CY + BUTTON_Y + 18;
        const u = 1 - glide;
        const inX = u * u * 1180 + 2 * u * glide * 1080 + glide * glide * tipX;
        const inY = u * u * 700 + 2 * u * glide * 300 + glide * glide * tipY;
        const hereX = M.lerp(inX, CX + bw / 2 + 64, aside) + Math.sin((idle / 110) * TAU) * 6 * calm;
        const hereY = M.lerp(inY, CY + BUTTON_Y + 64, aside) + Math.sin((idle / 55) * TAU) * 4 * calm;
        const awayX = env.flow ? hereX + env.flow.x * 700 : 1190;
        const awayY = env.flow ? hereY + env.flow.y * 700 : 680;
        place(ctx, {
          x: M.lerp(hereX, awayX, flick),
          y: M.lerp(hereY, awayY, flick),
          rotate: deg(M.lerp(-14, 0, glide)),
          scaleX: 1 - 0.16 * press,
          alpha: M.progress(t, 16, 21) * (1 - flick)
        }, () => {
          cursorPath(ctx, 2.6);
          ctx.fillStyle = theme.ink;
          ctx.fill();
          ctx.lineWidth = 6;
          ctx.lineJoin = 'round';
          ctx.strokeStyle = theme.surface;
          ctx.stroke();
        });
      });
    }
  };

  // ==========================================
  // REGISTRY
  // ==========================================

  const SCENES = [popReveal, blockShuffle, stickerBurst, checklist, stamp, ticker, flipBoard, keycaps, chat, pointClick];
  const byId = new Map(SCENES.map((scene) => [scene.id, scene]));

  function get(id) {
    return byId.get(id) || null;
  }

  function defaultsOf(scene) {
    return Object.fromEntries(
      scene.schema.map((f) => [f.key, Array.isArray(f.default) ? f.default.slice() : f.default])
    );
  }

  function sanitizeProps(id, props) {
    const scene = get(id);
    if (!scene) return {};
    const source = props && typeof props === 'object' ? props : {};
    return Object.fromEntries(scene.schema.map((f) => [f.key, sanitizeField(f, source[f.key])]));
  }

  function introOf(scene, props) {
    const frames = typeof scene.intro === 'function' ? scene.intro(props) : scene.intro;
    return Math.max(1, Math.ceil(frames));
  }

  /**
   * How long a scene takes to arrive, and to leave, with these props. The idle
   * in between is not the scene's to decide.
   */
  function timing(id, props) {
    const scene = get(id);
    if (!scene) return null;
    return { intro: introOf(scene, sanitizeProps(id, props)), outro: OUTRO };
  }

  function list() {
    return SCENES.map((scene) => {
      const defaults = defaultsOf(scene);
      return {
        id: scene.id,
        name: scene.name,
        description: scene.description,
        fps: FPS,
        intro: introOf(scene, defaults),
        outro: OUTRO,
        schema: scene.schema,
        defaults
      };
    });
  }

  /** Words a screen reader can say in place of the animation. */
  function describe(id, props) {
    const scene = get(id);
    return scene ? scene.describe(sanitizeProps(id, props)) : '';
  }

  /** Canvas size for a width-over-height ratio. Width is always the stage's. */
  function sizeFor(ratio) {
    const r = Number(ratio) > 0 ? Number(ratio) : 2;
    return { width: WIDTH, height: Math.round(WIDTH / r) };
  }

  /** The colour under a scene: its own background, or the theme's. */
  function ground(id, props, theme) {
    const scene = get(id);
    const palette = theme || M.readTheme('light');
    return scene ? scene.ground(props, palette) : palette.ground;
  }

  /** A clock completed from whatever the caller knows: at least `t`. */
  function clockFor(scene, props, clock) {
    const source = typeof clock === 'number' ? { t: clock } : clock || {};
    const t = Math.max(0, Number(source.t) || 0);
    const intro = introOf(scene, props);
    return {
      t,
      intro,
      idle: Math.max(0, t - intro),
      exit: Math.max(0, Number(source.exit) || 0),
      ambient: source.ambient == null ? 1 : M.clamp(Number(source.ambient) || 0, 0, 1)
    };
  }

  function envFor(env) {
    const size = env.width && env.height ? env : sizeFor(2);
    return {
      width: size.width,
      height: size.height,
      theme: env.theme || M.readTheme('light'),
      flow: env.flow || null
    };
  }

  /**
   * A scene's content for one moment, over whatever is already on the canvas.
   * `props` should already be sanitized - the player and the Remotion
   * composition do that once, not sixty times a second.
   */
  function renderContent(ctx, id, clock, props, env = {}) {
    const scene = get(id);
    if (!scene) return;
    scene.render(ctx, clockFor(scene, props, clock), props, envFor(env));
  }

  /** One whole frame: the scene's ground, then its content. */
  function render(ctx, id, clock, props, env = {}) {
    const scene = get(id);
    if (!scene) return;
    const full = envFor(env);
    paintGround(ctx, full, scene.ground(props, full.theme));
    scene.render(ctx, clockFor(scene, props, clock), props, full);
  }

  return {
    FPS,
    WIDTH,
    BASE_HEIGHT,
    OUTRO,
    list,
    get,
    sanitizeProps,
    describe,
    sizeFor,
    timing,
    ground,
    paintGround,
    render,
    renderContent
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = KlndrScenes;
