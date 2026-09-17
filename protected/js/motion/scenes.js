// Klndr Motion Scenes
//
// The built-in animated headers: fifteen short scenes in klndr's own drawing style -
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
  // SCENE: SWITCH ON
  // ==========================================

  const SWITCH_W = 680;
  const SWITCH_H = 176;
  const TRACK_W = 168;
  const TRACK_H = 92;
  const KNOB_R = 34;
  const KNOB_TRAVEL = TRACK_W / 2 - TRACK_H / 2;
  // The switch, on the stage.
  const SWITCH_X = 600 + SWITCH_W / 2 - 48 - TRACK_W / 2;
  const SWITCH_Y = 300;
  const SWITCH_CLICK = 50;
  const SWITCH_FLOOD = 56;
  const SWITCH_POP = 68;
  // Where the cursor waits once it has flipped the switch.
  const SWITCH_REST = { x: 1000, y: 292 };
  // Where what the switch turns on lands, for one to four things.
  const SWITCH_SLOTS = [
    [{ x: 600, y: 112, tilt: -4 }],
    [{ x: 300, y: 116, tilt: -7 }, { x: 880, y: 486, tilt: 5 }],
    [{ x: 290, y: 116, tilt: -7 }, { x: 910, y: 110, tilt: 6 }, { x: 420, y: 490, tilt: 4 }],
    [{ x: 270, y: 118, tilt: -8 }, { x: 930, y: 110, tilt: 7 }, { x: 250, y: 486, tilt: 6 }, { x: 900, y: 492, tilt: -5 }]
  ];
  const SWITCH_SPARKS = [
    [110, 300, 24, 0],
    [1100, 240, 20, 0.35],
    [660, 556, 18, 0.7]
  ];

  const switchOn = {
    id: 'switch-on',
    name: 'Switch on',
    description: 'A cursor flips a big switch, colour floods out from it, and everything it turns on pops up.',
    schema: [
      { key: 'headline', type: 'text', label: 'Setting', max: 22, default: 'Focus mode' },
      { key: 'items', type: 'list', label: 'What it turns on', max: 18, maxItems: 4, default: ['🔕 No pings', '🌿 Calm colours', '⏱️ Timer on', '🧠 Deep work'] },
      { key: 'accent', type: 'color', label: 'Switch colour', default: '#9ae659' },
      { key: 'background', type: 'color', label: 'Background', optional: true, default: '' }
    ],
    // The last thing to pop up has landed 30 frames after it set off.
    intro: (p) => SWITCH_POP + 6 * (p.items.length - 1) + 30,
    ground: (p, theme) => p.background || theme.ground,
    describe: (p) => [p.headline ? `${p.headline}, switched on` : 'Switched on', p.items.join(', ')].join(': '),
    render(ctx, clock, p, env) {
      const { t, idle, ambient } = clock;
      const theme = env.theme;
      const flow = flowOf(env, DOWN);
      const accent = M.taskFill(p.accent, theme);
      const calm = M.rampIn(idle, 24) * ambient;
      // Far enough from the switch to cover every corner of the canvas, and
      // the edge of a panel the camera carries.
      const scale = Math.min(env.width / WIDTH, env.height / BASE_HEIGHT);
      const reach = Math.hypot(
        env.width / 2 / scale + Math.abs(SWITCH_X - 600),
        env.height / 2 / scale + Math.abs(SWITCH_Y - 300)
      ) + 90;

      // The flood: a ring of the switch's own colour, and a softer wash a beat
      // behind it that stays. Each is a new ground, grid and all, so it is
      // painted on the canvas rather than the stage.
      const lead = M.progress(t, SWITCH_FLOOD, SWITCH_FLOOD + 20, Easing.out(Easing.cubic)) *
        (1 - M.outOf(clock, 4, 15, Easing.in(Easing.cubic)));
      const wash = M.progress(t, SWITCH_FLOOD + 4, SWITCH_FLOOD + 26, Easing.out(Easing.cubic)) *
        (1 - M.outOf(clock, 1, 12, Easing.in(Easing.cubic)));
      const floodColour = M.mix(p.accent, theme.ground, theme.name === 'dark' ? 0.42 : 0.6);
      [[lead, accent], [wash, floodColour]].forEach(([amount, colour]) => {
        if (amount <= EPS) return;
        ctx.save();
        ctx.beginPath();
        ctx.arc(
          env.width / 2 + (SWITCH_X - 600) * scale,
          env.height / 2 + (SWITCH_Y - 300) * scale,
          reach * scale * amount,
          0,
          TAU
        );
        ctx.clip();
        paintGround(ctx, env, colour);
        ctx.restore();
      });

      onStage(ctx, env, () => {
        const cardIn = M.spring({ frame: t, fps: FPS, delay: 2, config: { damping: 13, stiffness: 130 } });
        const glide = M.progress(t, 12, SWITCH_CLICK - 2, Easing.inOut(Easing.cubic));
        const press = M.progress(t, SWITCH_CLICK, SWITCH_CLICK + 3, Easing.out(Easing.quad)) *
          (1 - M.progress(t, SWITCH_CLICK + 4, SWITCH_CLICK + 9, Easing.out(Easing.quad)));
        const flip = M.spring({ frame: t, fps: FPS, delay: SWITCH_CLICK + 3, config: { damping: 11, stiffness: 210 } });
        // Out: the switch goes back off, the colour drains back into it, and
        // the card leaves last.
        const unflip = M.outOf(clock, 0, 7, Easing.inOut(Easing.cubic));
        const knob = flip * (1 - unflip);
        const on = M.clamp(knob, 0, 1);
        const go = M.outOf(clock, 8, OUTRO, Easing.in(Easing.cubic));
        const flick = M.outOf(clock, 0, 10, Easing.in(Easing.cubic));

        // Idle: the switch keeps sending ripples out across the colour.
        const ripple = calm * (1 - M.outOf(clock, 0, 4));
        if (ripple > EPS) {
          ctx.save();
          ctx.lineWidth = 8;
          for (let k = 0; k < 2; k++) {
            const q = M.beat(idle + k * 50, 100).local / 100;
            ctx.strokeStyle = M.alpha(theme.surface, 0.5 * (1 - q) * ripple);
            ctx.beginPath();
            ctx.arc(SWITCH_X, SWITCH_Y, M.lerp(TRACK_W * 0.6, reach, Easing.out(Easing.quad)(q)), 0, TAU);
            ctx.stroke();
          }
          ctx.restore();
        }

        const label = M.fitText(ctx, p.headline || ' ', { maxWidth: SWITCH_W - 96 - TRACK_W - 36, maxLines: 1, max: 54, min: 26 });
        place(ctx, {
          x: 600 + flow.x * 100 * go,
          y: SWITCH_Y + (1 - cardIn) * 50 + M.wave(idle, 110) * 3 * calm + flow.y * 100 * go,
          rotate: deg((1 - cardIn) * -5 + (flow.x < 0 ? -6 : 6) * go),
          scaleX: (0.8 + 0.2 * cardIn) * M.lerp(1, 0.9, go),
          alpha: M.clamp(cardIn * 1.5, 0, 1) * (1 - go)
        }, () => {
          const left = -SWITCH_W / 2;
          M.slabBox(ctx, {
            x: left, y: -SWITCH_H / 2, w: SWITCH_W, h: SWITCH_H,
            r: 30, fill: theme.surface, line: theme.line, lineWidth: 5, slab: 12
          });
          ctx.font = M.font(label.size);
          ctx.fillStyle = theme.ink;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(label.lines[0] || '', left + 48, -18);

          // Off, then On: the word turns over as the switch does.
          place(ctx, { x: left + 48, y: 40, scaleY: Math.abs(Math.cos(on * Math.PI)) }, () => {
            const lit = on >= 0.5;
            ctx.beginPath();
            ctx.arc(10, 0, 10, 0, TAU);
            ctx.fillStyle = lit ? accent : theme.tray;
            ctx.fill();
            ctx.lineWidth = 3;
            ctx.strokeStyle = theme.line;
            ctx.stroke();
            ctx.font = M.font(28, 800);
            ctx.fillStyle = lit ? theme.ink : theme.inkSoft;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(lit ? 'On' : 'Off', 32, 2);
          });

          place(ctx, { x: SWITCH_X - 600, y: 0 }, () => {
            const ring = M.progress(t, SWITCH_CLICK + 3, SWITCH_CLICK + 20, Easing.out(Easing.quad));
            if (ring > EPS && ring < 1 - EPS) {
              ctx.save();
              ctx.globalAlpha = ctx.globalAlpha * (1 - ring);
              ctx.strokeStyle = theme.line;
              ctx.lineWidth = 5;
              M.roundRectPath(
                ctx,
                -TRACK_W / 2 - ring * 36, -TRACK_H / 2 - ring * 36,
                TRACK_W + ring * 72, TRACK_H + ring * 72,
                TRACK_H / 2 + ring * 36
              );
              ctx.stroke();
              ctx.restore();
            }

            M.slabBox(ctx, {
              x: -TRACK_W / 2, y: -TRACK_H / 2, w: TRACK_W, h: TRACK_H,
              r: TRACK_H / 2, fill: M.mix(accent, theme.tray, on), line: theme.line, lineWidth: 5, slab: 6
            });
            // The knob squashes under the click and stretches as it runs across.
            const stretch = Math.sin(Math.PI * on) * 0.3;
            place(ctx, {
              x: M.lerp(-KNOB_TRAVEL, KNOB_TRAVEL, knob),
              y: 0,
              scaleX: 1 + stretch + 0.12 * press,
              scaleY: 1 - 0.12 * press - stretch * 0.25
            }, () => {
              ctx.beginPath();
              ctx.arc(0, 0, KNOB_R, 0, TAU);
              ctx.fillStyle = theme.surface;
              ctx.fill();
              ctx.lineWidth = 5;
              ctx.strokeStyle = theme.line;
              ctx.stroke();
            });
          });
        });

        // What the switch turns on shoots out of it and lands around the card.
        const slots = SWITCH_SLOTS[Math.min(p.items.length, SWITCH_SLOTS.length) - 1];
        p.items.forEach((item, i) => {
          const slot = slots[i];
          const at = SWITCH_POP + i * 6;
          const pop = M.spring({ frame: t, fps: FPS, delay: at, config: { damping: 13, stiffness: 170 } });
          const fling = M.outOf(clock, i * 1.5, 9 + i * 1.5, Easing.in(Easing.cubic));
          let dx = slot.x - SWITCH_X;
          let dy = slot.y - SWITCH_Y;
          if (env.flow) {
            const outward = Math.hypot(dx, dy) || 1;
            dx = (dx / outward) * 0.4 + env.flow.x;
            dy = (dy / outward) * 0.4 + env.flow.y;
          }
          const length = Math.hypot(dx, dy) || 1;
          ctx.font = M.font(34);
          const w = Math.max(100, ctx.measureText(item).width + 64);
          const h = 76;
          const x = M.lerp(SWITCH_X, slot.x, pop) + (dx / length) * 120 * fling;
          const y = M.lerp(SWITCH_Y, slot.y, pop) + M.wave(idle, 80, i * 0.23) * 6 * calm + (dy / length) * 120 * fling;
          const tilt = deg(slot.tilt * M.clamp(pop, 0, 1) + M.wave(idle, 120, i * 0.31) * 2 * calm + (dx < 0 ? -20 : 20) * fling);

          // A ring goes out from it as it lands.
          const ring = M.progress(t, at + 9, at + 24, Easing.out(Easing.quad));
          if (ring > EPS && ring < 1 - EPS) {
            place(ctx, { x, y, rotate: tilt, alpha: 1 - ring }, () => {
              ctx.strokeStyle = theme.line;
              ctx.lineWidth = 4;
              M.roundRectPath(ctx, -w / 2 - ring * 28, -h / 2 - ring * 28, w + ring * 56, h + ring * 56, h / 2 + ring * 28);
              ctx.stroke();
            });
          }

          place(ctx, {
            x,
            y,
            rotate: tilt,
            scaleX: (0.3 + 0.7 * pop) * (1 - 0.4 * fling),
            alpha: M.clamp(pop * 2, 0, 1) * (1 - fling)
          }, () => {
            M.slabBox(ctx, {
              x: -w / 2, y: -h / 2, w, h,
              r: h / 2, fill: theme.surface, line: theme.line, lineWidth: 4, slab: 7
            });
            ctx.font = M.font(34);
            ctx.fillStyle = theme.ink;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(item, 0, 2);
          });
        });

        const sparkle = M.spring({ frame: t, fps: FPS, delay: SWITCH_FLOOD + 10, config: { damping: 8, stiffness: 150 } }) *
          (1 - M.outOf(clock, 0, 7));
        SWITCH_SPARKS.forEach(([x, y, r, phase]) => {
          place(ctx, {
            x,
            y,
            rotate: t * 0.03 * ambient,
            scaleX: sparkle * M.lerp(0.9, 0.75 + 0.25 * M.wave(t, 60, phase), ambient),
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

        // In along a curve to the knob, along with it as it flips, then aside to watch.
        const clickX = SWITCH_X - KNOB_TRAVEL + 8;
        const clickY = SWITCH_Y + 12;
        const u = 1 - glide;
        const inX = u * u * 1190 + 2 * u * glide * 1130 + glide * glide * clickX;
        const inY = u * u * 720 + 2 * u * glide * 470 + glide * glide * clickY;
        const ride = M.clamp(flip, 0, 1) * KNOB_TRAVEL * 2;
        const aside = M.progress(t, SWITCH_CLICK + 14, SWITCH_CLICK + 32, Easing.inOut(Easing.cubic));
        const hereX = M.lerp(inX + ride, SWITCH_REST.x, aside) + Math.sin((idle / 110) * TAU) * 6 * calm;
        const hereY = M.lerp(inY, SWITCH_REST.y, aside) + Math.sin((idle / 55) * TAU) * 4 * calm;
        const awayX = env.flow ? hereX + env.flow.x * 700 : 1190;
        const awayY = env.flow ? hereY + env.flow.y * 700 : 700;
        place(ctx, {
          x: M.lerp(hereX, awayX, flick),
          y: M.lerp(hereY, awayY, flick),
          rotate: deg(M.lerp(-14, 0, glide)),
          scaleX: 1 - 0.16 * press,
          alpha: M.progress(t, 12, 17) * (1 - flick)
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
  // SCENE: SAVE THE DATE
  // ==========================================

  const PAD_W = 300;
  const PAD_H = 340;
  const PAD_BIND = 76;
  const PAD_TOP = -PAD_H / 2 + PAD_BIND;
  // The pad is drawn at this size on the stage.
  const PAD_SCALE = 1.2;
  // The pages before the day tear off quicker and quicker, each lifting at its
  // corner for PAGE_CURL frames before it lets go.
  const PAGE_TEARS = [32, 42, 50, 56];
  const PAGE_CURL = 4;
  const DATE_LANDS = PAGE_TEARS[PAGE_TEARS.length - 1] + PAGE_CURL;
  const MARKER_AT = DATE_LANDS + 4;

  // What the pages before the day say: the days counting up to it, wrapping
  // back through the month before, or nothing when the day is not a number.
  function pagesBefore(day) {
    if (!/^\d+$/.test(day)) return PAGE_TEARS.map(() => '');
    const n = Number(day);
    return PAGE_TEARS.map((_, k) => {
      const d = n - PAGE_TEARS.length + k;
      return String(d < 1 ? d + 30 : d);
    });
  }

  function pageFace(ctx, { number, weekday, size, theme }) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = M.font(size);
    ctx.fillStyle = theme.ink;
    ctx.fillText(number, 0, PAD_TOP + 104);
    if (weekday) {
      ctx.font = M.font(30, 800);
      ctx.fillStyle = theme.inkSoft;
      ctx.fillText(weekday, 0, PAD_H / 2 - 42);
    } else {
      M.roundRectPath(ctx, -45, PAD_H / 2 - 47, 90, 10, 5);
      ctx.fillStyle = M.alpha(theme.ink, 0.14);
      ctx.fill();
    }
  }

  // One page. Still on the pad, its top is tucked under the binding.
  function pageSheet(ctx, { number, size, theme, tucked }) {
    const tuck = tucked ? 24 : 0;
    M.roundRectPath(ctx, -PAD_W / 2, PAD_TOP - tuck, PAD_W, PAD_H / 2 - PAD_TOP + tuck, tucked ? 22 : 16);
    ctx.fillStyle = theme.surface;
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = theme.line;
    ctx.stroke();
    pageFace(ctx, { number, weekday: '', size, theme });
  }

  // A marker ring drawn by hand: a little more than once round, wider on the
  // second pass. Returns roughly how long the stroke is.
  function markerPath(ctx, rx, ry) {
    const steps = 48;
    const sweep = TAU * 1.12;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const a = -2.2 + (i / steps) * sweep;
      const grow = 1 + 0.07 * (i / steps);
      const x = Math.cos(a) * rx * grow;
      const y = Math.sin(a) * ry * grow;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    return TAU * Math.sqrt((rx * rx + ry * ry) / 2) * 1.12 * 1.07 + 20;
  }

  const saveTheDate = {
    id: 'save-the-date',
    name: 'Save the date',
    description: 'Pages tear off a desk calendar until your date lands, then a marker circles it.',
    schema: [
      { key: 'month', type: 'text', label: 'Month', max: 9, default: 'OCT' },
      { key: 'day', type: 'text', label: 'Day', max: 3, default: '1' },
      { key: 'weekday', type: 'text', label: 'Weekday', max: 12, default: 'Thursday' },
      { key: 'headline', type: 'text', label: 'Headline', max: 30, default: 'Save the date' },
      { key: 'detail', type: 'text', label: 'Detail', max: 32, default: 'Studio 2.0 goes live' },
      { key: 'accent', type: 'color', label: 'Binding colour', default: '#fb923c' },
      { key: 'background', type: 'color', label: 'Background', optional: true, default: '' }
    ],
    // The detail line on the card has settled by 100.
    intro: (p) => (p.headline || p.detail ? 100 : MARKER_AT + 20),
    ground: (p, theme) => p.background || theme.ground,
    describe: (p) => [[p.headline, p.detail].filter(Boolean).join(', '), [p.weekday, p.day, p.month].filter(Boolean).join(' ')]
      .filter(Boolean)
      .join(': '),
    render(ctx, clock, p, env) {
      const { t, idle, ambient } = clock;
      const theme = env.theme;
      const flow = flowOf(env, DOWN);

      onStage(ctx, env, () => {
        const accent = M.taskFill(p.accent, theme);
        const calm = M.rampIn(idle, 24) * ambient;
        const hasCard = Boolean(p.headline || p.detail);
        const padX = hasCard ? 320 : 600;
        const padY = 300;
        const numbers = pagesBefore(p.day);
        const number = M.fitText(ctx, p.day || ' ', { maxWidth: 210, maxLines: 1, max: 150, min: 60 });
        const month = M.fitText(ctx, p.month || ' ', { maxWidth: 230, maxLines: 1, max: 44, min: 20 });

        const padIn = M.spring({ frame: t, fps: FPS, delay: 2, config: { damping: 12, stiffness: 110 } });
        const unmark = M.outOf(clock, 0, 8, Easing.in(Easing.quad));
        const cardOut = M.outOf(clock, 0, 12, Easing.in(Easing.cubic));
        const drop = M.outOf(clock, 6, OUTRO, Easing.in(Easing.cubic));
        // Every page that lets go gives the pad a little knock; the day lands with a thump.
        const knock = PAGE_TEARS.reduce((sum, at) => {
          const since = t - at - PAGE_CURL;
          return since >= 0 ? sum + Math.exp(-since / 3) * Math.sin(since / 1.2) : sum;
        }, 0);
        const since = t - DATE_LANDS;
        const thump = since >= 0 ? Math.exp(-since / 4) * Math.cos(since / 1.6) : 0;

        place(ctx, {
          x: padX + flow.x * 110 * drop,
          y: M.lerp(-360, padY, padIn) + flow.y * 110 * drop,
          rotate: deg(M.lerp(-10, -3, padIn) + knock * 1.4 + M.wave(idle, 140) * 1.2 * calm + (flow.x < 0 ? -8 : 8) * drop),
          scaleX: PAD_SCALE * (1 + thump * 0.04),
          scaleY: PAD_SCALE * (1 - thump * 0.05),
          alpha: M.clamp(padIn * 3, 0, 1) * (1 - drop)
        }, () => {
          M.slabBox(ctx, {
            x: -PAD_W / 2, y: -PAD_H / 2, w: PAD_W, h: PAD_H,
            r: 24, fill: theme.surface, line: theme.line, lineWidth: 5, slab: 12
          });

          // The page on top, and whatever is under it - the next day, or the day.
          const top = PAGE_TEARS.findIndex((at) => t < at + PAGE_CURL);
          if (top < 0 || top === PAGE_TEARS.length - 1) {
            pageFace(ctx, { number: p.day, weekday: p.weekday, size: number.size, theme });
          } else {
            pageFace(ctx, { number: numbers[top + 1], weekday: '', size: number.size, theme });
          }
          if (top >= 0) {
            const curl = M.progress(t, PAGE_TEARS[top], PAGE_TEARS[top] + PAGE_CURL, Easing.in(Easing.quad));
            ctx.save();
            ctx.translate(-PAD_W / 2, PAD_TOP);
            ctx.rotate(deg(8 * curl));
            ctx.translate(PAD_W / 2, -PAD_TOP);
            pageSheet(ctx, { number: numbers[top], size: number.size, theme, tucked: true });
            ctx.restore();
          }

          ctx.save();
          M.roundRectPath(ctx, -PAD_W / 2, -PAD_H / 2, PAD_W, PAD_H, 24);
          ctx.clip();
          ctx.fillStyle = accent;
          ctx.fillRect(-PAD_W / 2, -PAD_H / 2, PAD_W, PAD_BIND);
          ctx.restore();
          ctx.lineWidth = 5;
          ctx.strokeStyle = theme.line;
          ctx.beginPath();
          ctx.moveTo(-PAD_W / 2, PAD_TOP);
          ctx.lineTo(PAD_W / 2, PAD_TOP);
          ctx.stroke();
          M.roundRectPath(ctx, -PAD_W / 2, -PAD_H / 2, PAD_W, PAD_H, 24);
          ctx.stroke();
          ctx.font = M.font(month.size);
          ctx.fillStyle = inkOn(accent, theme);
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(month.lines[0] || '', 0, -PAD_H / 2 + PAD_BIND / 2 + 4);
          [-84, 84].forEach((x) => {
            M.slabBox(ctx, {
              x: x - 11, y: -PAD_H / 2 - 20, w: 22, h: 42,
              r: 11, fill: theme.tray, line: theme.line, lineWidth: 4, slab: 0
            });
          });

          const mark = M.progress(t, MARKER_AT, MARKER_AT + 18, Easing.inOut(Easing.quad)) * (1 - unmark);
          place(ctx, {
            x: 0,
            y: PAD_TOP + 100,
            rotate: deg(-8),
            scaleX: 1 + 0.035 * M.swell(idle, 70) * calm,
            alpha: mark > EPS ? 1 : 0
          }, () => {
            const length = markerPath(ctx, 118, 82);
            ctx.setLineDash([length, length]);
            ctx.lineDashOffset = length * (1 - mark);
            ctx.strokeStyle = accent;
            ctx.lineWidth = 10;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.stroke();
            ctx.setLineDash([]);
          });

          // The pages that have let go fall away in front of the pad, carrying
          // on from where their curl left them.
          PAGE_TEARS.forEach((at, k) => {
            const loose = t - at - PAGE_CURL;
            const fade = 1 - M.progress(loose, 6, 18);
            if (loose < 0 || fade <= EPS) return;
            ctx.save();
            ctx.globalAlpha = ctx.globalAlpha * fade;
            ctx.translate(-PAD_W / 2 + loose * (k % 2 ? 5 : 3), PAD_TOP + loose * 3 + 0.9 * loose * loose);
            ctx.rotate(deg(8 + loose * (3 + k)));
            ctx.translate(PAD_W / 2, -PAD_TOP);
            pageSheet(ctx, { number: numbers[k], size: number.size, theme, tucked: false });
            ctx.restore();
          });
        });

        if (hasCard) {
          const cardIn = M.spring({ frame: t, fps: FPS, delay: MARKER_AT + 2, config: { damping: 12, stiffness: 130 } });
          const detailIn = M.spring({ frame: t, fps: FPS, delay: MARKER_AT + 8, config: { damping: 12, stiffness: 140 } });
          const headline = M.fitText(ctx, p.headline || ' ', { maxWidth: 430, maxLines: 2, max: 64, min: 32 });
          const detail = M.fitText(ctx, p.detail || ' ', { maxWidth: 430, maxLines: 1, max: 36, min: 22, step: 2, weight: 800 });
          const headH = p.headline ? headline.lines.length * headline.size * 1.06 : 0;
          const detailH = p.detail ? detail.size * 1.2 : 0;
          const cardW = 520;
          const cardH = 88 + headH + detailH + (p.headline && p.detail ? 14 : 0);
          place(ctx, {
            x: 810 + (1 - cardIn) * 140 + flow.x * 80 * cardOut,
            y: padY + M.wave(idle, 95) * 4 * calm + flow.y * 80 * cardOut,
            rotate: deg(M.lerp(7, 2, cardIn)),
            scaleX: 0.85 + 0.15 * cardIn,
            alpha: M.clamp(cardIn * 1.6, 0, 1) * (1 - cardOut)
          }, () => {
            const left = -cardW / 2;
            const top = -cardH / 2;
            M.slabBox(ctx, {
              x: left, y: top, w: cardW, h: cardH,
              r: 26, fill: theme.surface, line: theme.line, lineWidth: 5, slab: 12
            });
            // A strip of the binding's colour down its left edge, like a diary tab.
            ctx.save();
            M.roundRectPath(ctx, left, top, cardW, cardH, 26);
            ctx.clip();
            ctx.fillStyle = accent;
            ctx.fillRect(left, top, 20, cardH);
            ctx.restore();
            M.roundRectPath(ctx, left, top, cardW, cardH, 26);
            ctx.lineWidth = 5;
            ctx.strokeStyle = theme.line;
            ctx.stroke();
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            if (p.headline) {
              ctx.font = M.font(headline.size);
              ctx.fillStyle = theme.ink;
              headline.lines.forEach((line, i) => {
                ctx.fillText(line, left + 50, top + 44 + headline.size * (i * 1.06 + 0.53));
              });
            }
            if (p.detail) {
              place(ctx, {
                x: left + 50,
                y: top + cardH - 44 - detailH / 2 + (1 - detailIn) * 16,
                alpha: M.clamp(detailIn * 1.6, 0, 1)
              }, () => {
                ctx.font = M.font(detail.size, 800);
                ctx.fillStyle = theme.inkSoft;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(detail.lines[0] || '', 0, 2);
              });
            }
          });
        }
      });
    }
  };

  // ==========================================
  // SCENE: MILESTONE
  // ==========================================

  // A chart climbing to its best bar yet, peeking out around the card.
  const MILESTONE_BARS = [0.28, 0.4, 0.34, 0.5, 0.46, 0.62, 0.56, 0.72, 0.8, 0.76, 1];
  const BAR_W = 70;
  const BAR_MAX = 420;
  const COUNT_FROM = 18;
  const COUNT_TO = 60;
  // Picks up speed, then glides in, so the count spends its time on numbers you can read.
  const countEase = Easing.bezier(0.4, 0, 0.2, 1);
  const MILESTONE_SPARKS = [
    [150, 120, 36, 0],
    [1050, 104, 32, 0.3],
    [1004, 226, 26, 0.6],
    [190, 360, 28, 0.8]
  ];

  /**
   * `text` part of the way to the number in it: its digits counted up from 0,
   * leading zeros and the separators between them left off, so "10,000" reads
   * 0, 7, 480, 3,125 and then 10,000. Words around the number stay put.
   */
  function countedTo(text, fraction) {
    const digits = text.replace(/\D/g, '');
    if (!digits || fraction >= 1) return text;
    const shown = String(Math.round(Number(digits) * Math.max(0, fraction))).padStart(digits.length, '0');
    const chars = Array.from(text);
    const lastDigit = chars.reduce((last, c, i) => (/\d/.test(c) ? i : last), -1);
    let d = 0;
    let started = false;
    let seenDigit = false;
    let out = '';
    chars.forEach((c, i) => {
      if (/\d/.test(c)) {
        const digit = shown[d++];
        seenDigit = true;
        if (started || digit !== '0' || i === lastDigit) {
          out += digit;
          started = true;
        }
      } else if (!(seenDigit && !started && i < lastDigit)) {
        out += c;
      }
    });
    return out;
  }

  // A ribbon banner's two tails, cut into a V at the ends.
  function ribbonTailPath(ctx, bw, side) {
    const edge = side * (bw / 2);
    ctx.beginPath();
    ctx.moveTo(edge - side * 20, -18);
    ctx.lineTo(edge + side * 56, -18);
    ctx.lineTo(edge + side * 36, 19);
    ctx.lineTo(edge + side * 56, 56);
    ctx.lineTo(edge - side * 20, 56);
    ctx.closePath();
  }

  const milestone = {
    id: 'milestone',
    name: 'Milestone',
    description: 'A big number counts up over a climbing chart, then a ribbon unfurls across it.',
    schema: [
      { key: 'number', type: 'text', label: 'Number', max: 12, default: '10,000' },
      { key: 'headline', type: 'text', label: 'Of what', max: 32, default: 'blocks planned in klndr' },
      { key: 'banner', type: 'text', label: 'Ribbon', max: 16, default: 'Thank you!' },
      { key: 'accent', type: 'color', label: 'Chart colour', default: '#3ba4f6' },
      { key: 'background', type: 'color', label: 'Background', optional: true, default: '' }
    ],
    // The ribbon and the sparkles have settled by 90.
    intro: 90,
    ground: (p, theme) => p.background || theme.mint,
    describe: (p) => [p.banner, [p.number, p.headline].filter(Boolean).join(' ')].filter(Boolean).join(' '),
    render(ctx, clock, p, env) {
      const { t, idle, ambient } = clock;
      const theme = env.theme;
      const flow = flowOf(env, DOWN);

      onStage(ctx, env, () => {
        const accent = M.taskFill(p.accent, theme);
        const soft = M.mix(accent, theme.surface, 0.45);
        const calm = M.rampIn(idle, 24) * ambient;
        const n = MILESTONE_BARS.length;
        const pitch = (1080 - BAR_W) / (n - 1);

        MILESTONE_BARS.forEach((share, i) => {
          const grow = M.spring({ frame: t, fps: FPS, delay: 4 + i * 3, config: { damping: 14, stiffness: 120 } });
          const sink = M.outOf(clock, i * 0.8, 10 + i * 0.8, Easing.in(Easing.cubic));
          const breathe = 1 + 0.05 * M.wave(idle, 90, -i * 0.09) * calm;
          const h = BAR_MAX * share * grow * breathe * (1 - sink);
          if (h <= 0.5) return;
          const x = 60 + i * pitch;
          const best = i === n - 1;
          M.slabBox(ctx, {
            x, y: 600 - h, w: BAR_W, h: h + 400,
            r: 16, fill: best ? accent : soft, line: theme.line, lineWidth: 5, slab: 8
          });
        });

        const cardIn = M.spring({ frame: t, fps: FPS, delay: 6, config: { damping: 12, stiffness: 130 } });
        const go = M.outOf(clock, 6, OUTRO, Easing.in(Easing.cubic));
        const roll = M.outOf(clock, 0, 8, Easing.in(Easing.cubic));
        const count = countEase(M.progress(t, COUNT_FROM, COUNT_TO));
        const since = t - COUNT_TO;
        const land = since >= 0 ? Math.exp(-since / 5) * Math.sin(since / 2) : 0;

        const number = M.fitText(ctx, p.number || ' ', { maxWidth: 600, maxLines: 1, max: 160, min: 60 });
        const label = M.fitText(ctx, p.headline || ' ', { maxWidth: 600, maxLines: 1, max: 44, min: 24, step: 2, weight: 800 });
        const labelH = p.headline ? label.size + 18 : 0;
        const cardW = 720;
        const cardH = 110 + number.size + labelH;

        place(ctx, {
          x: 600 + flow.x * 100 * go,
          y: 300 + (1 - cardIn) * 60 + M.wave(idle, 100) * 4 * calm + flow.y * 100 * go,
          rotate: deg(M.lerp(-6, -1.5, cardIn) + (flow.x < 0 ? -6 : 6) * go),
          scaleX: (0.75 + 0.25 * cardIn) * M.lerp(1, 0.9, go),
          alpha: M.clamp(cardIn * 1.5, 0, 1) * (1 - go)
        }, () => {
          M.slabBox(ctx, {
            x: -cardW / 2, y: -cardH / 2, w: cardW, h: cardH,
            r: 30, fill: theme.surface, line: theme.line, lineWidth: 5, slab: 12
          });
          const numberY = -cardH / 2 + 62 + number.size / 2;
          place(ctx, { x: 0, y: numberY, scaleX: 1 + 0.12 * land, scaleY: 1 + 0.12 * land }, () => {
            ctx.font = M.font(number.size);
            ctx.fillStyle = theme.ink;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(countedTo(p.number, count), 0, number.size * 0.04);
          });
          if (p.headline) {
            ctx.font = M.font(label.size, 800);
            ctx.fillStyle = theme.inkSoft;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label.lines[0] || '', 0, numberY + number.size / 2 + 12 + label.size / 2);
          }

          if (p.banner) {
            const unfurl = M.spring({ frame: t, fps: FPS, delay: COUNT_TO + 4, config: { damping: 10, stiffness: 160 } }) * (1 - roll);
            ctx.font = M.font(40);
            const bw = ctx.measureText(p.banner).width + 100;
            place(ctx, {
              x: 0,
              y: -cardH / 2 - 4,
              rotate: deg(-3 + M.wave(idle, 120) * 1.5 * calm),
              scaleX: unfurl,
              alpha: M.clamp(unfurl * 3, 0, 1)
            }, () => {
              const tails = M.mix(accent, theme.line, 0.7);
              [-1, 1].forEach((side) => {
                ribbonTailPath(ctx, bw, side);
                ctx.fillStyle = tails;
                ctx.fill();
                ctx.lineWidth = 4;
                ctx.lineJoin = 'round';
                ctx.strokeStyle = theme.line;
                ctx.stroke();
              });
              M.slabBox(ctx, {
                x: -bw / 2, y: -38, w: bw, h: 76,
                r: 12, fill: accent, line: theme.line, lineWidth: 5, slab: 6
              });
              ctx.font = M.font(40);
              ctx.fillStyle = inkOn(accent, theme);
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(p.banner, 0, 2);
            });
          }
        });

        const sparkle = M.spring({ frame: t, fps: FPS, delay: COUNT_TO, config: { damping: 8, stiffness: 150 } }) *
          (1 - M.outOf(clock, 0, 6));
        MILESTONE_SPARKS.forEach(([x, y, r, phase]) => {
          place(ctx, {
            x,
            y,
            rotate: t * 0.025 * ambient,
            scaleX: sparkle * M.lerp(0.9, 0.7 + 0.3 * M.wave(t, 55, phase), ambient),
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
      });
    }
  };

  // ==========================================
  // SCENE: HEADS UP
  // ==========================================

  // The sign hangs from a string off the top of the stage and swings about
  // where the string is tied, SIGN_PIVOT_Y. Everything else is measured down
  // from there.
  const SIGN_PIVOT_Y = -104;
  const SIGN_RING = 160;
  const SIGN_TOP = 262;
  const SIGN_W = 680;
  const SIGN_H = 210;
  const SIGN_LANDS = 16;
  const TAPE_ANGLE = deg(-30);

  function warningPath(ctx, size) {
    const h = size * 0.87;
    ctx.beginPath();
    ctx.moveTo(0, -h * 0.6);
    ctx.lineTo(size / 2, h * 0.4);
    ctx.lineTo(-size / 2, h * 0.4);
    ctx.closePath();
  }

  const headsUp = {
    id: 'heads-up',
    name: 'Heads up',
    description: 'A warning sign drops in on a string and swings, with caution tape across the corners. For maintenance and changes.',
    schema: [
      { key: 'label', type: 'text', label: 'Sign', max: 12, default: 'Heads up' },
      { key: 'headline', type: 'text', label: 'Message', max: 48, default: 'Short maintenance on Sunday, 2 to 3 am' },
      { key: 'color', type: 'color', label: 'Sign colour', default: '#fde047' },
      { key: 'background', type: 'color', label: 'Background', optional: true, default: '' }
    ],
    // The swing has died down and the message has risen by 62.
    intro: 62,
    ground: (p, theme) => p.background || theme.ground,
    describe: (p) => [p.label, p.headline].filter(Boolean).join(': '),
    render(ctx, clock, p, env) {
      const { t, idle, ambient } = clock;
      const theme = env.theme;
      const flow = env.flow;
      const colour = M.taskFill(p.color, theme);
      const calm = M.rampIn(idle, 24) * ambient;

      // Caution tape pulled across two corners of the whole canvas, behind the
      // sign; in, it runs on from one end, and out, it runs off the other.
      const W = env.width;
      const H = env.height;
      const s = M.clamp(H / BASE_HEIGHT, 0.6, 1.3);
      const band = 60 * s;
      const period = 80 * s;
      const reach = Math.hypot(W, H);
      [[0.08, 0.08], [0.92, 0.94]].forEach(([fx, fy], k) => {
        const from = M.outOf(clock, k * 2, 10 + k * 2, Easing.in(Easing.cubic));
        const to = M.progress(t, 2 + k * 5, 20 + k * 5, Easing.out(Easing.cubic));
        if (to - from <= EPS) return;
        const side = k === 0 ? 1 : -1;
        const start = side * (-reach + 2 * reach * from);
        const end = side * (-reach + 2 * reach * to);
        const x0 = Math.min(start, end);
        const x1 = Math.max(start, end);
        ctx.save();
        ctx.translate(W * fx, H * fy);
        ctx.rotate(TAPE_ANGLE);
        ctx.fillStyle = theme.line;
        ctx.fillRect(x0 + 6 * s, -band / 2 + 6 * s, x1 - x0, band);
        ctx.beginPath();
        ctx.rect(x0, -band / 2, x1 - x0, band);
        ctx.fillStyle = colour;
        ctx.fill();
        ctx.save();
        ctx.clip();
        const scroll = (t * 1.2 * ambient * side) % period;
        ctx.beginPath();
        for (let x = Math.floor((x0 - band) / period) * period + scroll; x < x1 + band; x += period) {
          ctx.moveTo(x, -band / 2);
          ctx.lineTo(x + period / 2, -band / 2);
          ctx.lineTo(x + period / 2 - band, band / 2);
          ctx.lineTo(x - band, band / 2);
          ctx.closePath();
        }
        ctx.fillStyle = theme.onColorLine;
        ctx.fill();
        ctx.restore();
        ctx.lineWidth = 4 * s;
        ctx.strokeStyle = theme.line;
        ctx.strokeRect(x0, -band / 2, x1 - x0, band);
        ctx.restore();
      });

      onStage(ctx, env, () => {
        const ink = inkOn(colour, theme);
        const drop = M.spring({ frame: t, fps: FPS, delay: 8, config: { damping: 10, stiffness: 100 } });
        const since = t - SIGN_LANDS;
        const swing = since > 0 ? 7 * Math.exp(-since / 13) * Math.sin(since / 3.4) : 0;
        const sway = M.wave(idle, 130) * 1.8 * calm;
        // Out: yanked back up on its string, or swung away the way a run of
        // clips is travelling.
        const lift = M.outOf(clock, 4, OUTRO, Easing.in(Easing.cubic));
        const sink = M.outOf(clock, 0, 10, Easing.in(Easing.cubic));
        const away = flow
          ? { x: flow.x * 900 * lift, y: flow.y * 900 * lift, turn: -(flow.x || 0) * 24 * lift }
          : { x: 0, y: -640 * lift, turn: 0 };

        place(ctx, {
          x: 600 + away.x,
          y: SIGN_PIVOT_Y - 560 * (1 - drop) + away.y,
          rotate: deg(swing + sway + away.turn),
          alpha: M.progress(t, 8, 11) * (1 - lift)
        }, () => {
          ctx.strokeStyle = theme.line;
          ctx.lineWidth = 5;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(0, -700);
          ctx.lineTo(0, SIGN_RING - 14);
          ctx.stroke();

          const grommetX = SIGN_W / 2 - 64;
          const grommetY = SIGN_TOP + 30;
          M.slabBox(ctx, {
            x: -SIGN_W / 2, y: SIGN_TOP, w: SIGN_W, h: SIGN_H,
            r: 28, fill: colour, line: theme.line, lineWidth: 6, slab: 12
          });
          M.roundRectPath(ctx, -SIGN_W / 2 + 16, SIGN_TOP + 16, SIGN_W - 32, SIGN_H - 32, 18);
          ctx.lineWidth = 4;
          ctx.strokeStyle = ink;
          ctx.stroke();

          ctx.strokeStyle = theme.line;
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.moveTo(-grommetX, grommetY);
          ctx.lineTo(0, SIGN_RING);
          ctx.lineTo(grommetX, grommetY);
          ctx.stroke();
          [-grommetX, grommetX].forEach((x) => {
            ctx.beginPath();
            ctx.arc(x, grommetY, 11, 0, TAU);
            ctx.fillStyle = theme.surface;
            ctx.fill();
            ctx.lineWidth = 4;
            ctx.strokeStyle = theme.line;
            ctx.stroke();
          });
          ctx.beginPath();
          ctx.arc(0, SIGN_RING, 14, 0, TAU);
          ctx.lineWidth = 6;
          ctx.strokeStyle = theme.line;
          ctx.stroke();

          // Idle: the warning blinks - a quick bump every two seconds.
          const { local } = M.beat(idle, 60);
          const blink = (local < 10 ? Math.sin((Math.PI * local) / 10) : 0) * calm;
          const iconX = p.label ? -SIGN_W / 2 + 132 : 0;
          const middle = SIGN_TOP + SIGN_H / 2;
          place(ctx, { x: iconX, y: middle + 6, scaleX: 1 + 0.14 * blink }, () => {
            warningPath(ctx, 124);
            ctx.fillStyle = ink;
            ctx.fill();
            ctx.lineWidth = 14;
            ctx.lineJoin = 'round';
            ctx.strokeStyle = ink;
            ctx.stroke();
            ctx.font = M.font(72);
            ctx.fillStyle = colour;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('!', 0, 8);
          });

          if (p.label) {
            const label = M.fitText(ctx, p.label, { maxWidth: 400, maxLines: 1, max: 100, min: 40 });
            ctx.font = M.font(label.size);
            ctx.fillStyle = ink;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label.lines[0] || '', 100, middle + label.size * 0.04);
          }
        });

        if (p.headline) {
          const rise = M.spring({ frame: t, fps: FPS, delay: 36, config: { damping: 12, stiffness: 140 } });
          const way = flow || DOWN;
          const caption = M.fitText(ctx, p.headline, { maxWidth: 880, maxLines: 1, max: 44, min: 24, step: 2, weight: 800 });
          ctx.font = M.font(caption.size, 800);
          const w = ctx.measureText(caption.lines[0] || '').width + 84;
          place(ctx, {
            x: 600 + way.x * 80 * sink,
            y: 492 + (1 - rise) * 60 + M.wave(idle, 90) * 3 * calm + way.y * 80 * sink,
            rotate: deg(M.lerp(-4, -1, M.clamp(rise, 0, 1))),
            scaleX: 0.85 + 0.15 * rise,
            alpha: M.clamp(rise * 1.6, 0, 1) * (1 - sink)
          }, () => {
            M.slabBox(ctx, {
              x: -w / 2, y: -44, w, h: 88,
              r: 44, fill: theme.surface, line: theme.line, lineWidth: 5, slab: 8
            });
            ctx.font = M.font(caption.size, 800);
            ctx.fillStyle = theme.ink;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(caption.lines[0] || '', 0, 2);
          });
        }
      });
    }
  };

  // ==========================================
  // SCENE: FEEDBACK
  // ==========================================

  const STAR_OUTER = 64;
  const STAR_INNER = 30;
  const STAR_GAP = 150;
  const STAR_FILL = 34;
  const STAR_EVERY = 6;
  // After the last star fills, a hop runs along the row.
  const STAR_HOP = STAR_FILL + 4 * STAR_EVERY + 8;
  // Idle reactions: one every FLOAT_EVERY frames, each rising for FLOAT_LIFE.
  const FLOAT_EVERY = 18;
  const FLOAT_LIFE = 84;

  const feedback = {
    id: 'feedback',
    name: 'Feedback',
    description: 'Five stars fill in one by one, a button pops up, and reactions float by. For asking what people think.',
    schema: [
      { key: 'headline', type: 'text', label: 'Question', max: 34, default: 'How is the new Studio?' },
      { key: 'button', type: 'text', label: 'Button', max: 16, default: 'Tell us' },
      { key: 'emojis', type: 'list', label: 'Reactions', max: 8, maxItems: 4, default: ['❤️', '🎉', '🔥', '👏'] },
      { key: 'accent', type: 'color', label: 'Star colour', default: '#fde047' },
      { key: 'background', type: 'color', label: 'Background', optional: true, default: '' }
    ],
    // The hop along the stars is over by 90; the button has settled by 98.
    intro: (p) => (p.button ? 98 : 92),
    ground: (p, theme) => p.background || theme.mint,
    describe: (p) => [p.headline, p.button].filter(Boolean).join(' '),
    render(ctx, clock, p, env) {
      const { t, idle, ambient } = clock;
      const theme = env.theme;
      const flow = flowOf(env, DOWN);

      onStage(ctx, env, () => {
        const accent = M.taskFill(p.accent, theme);
        const calm = M.rampIn(idle, 24) * ambient;

        // Reactions rise up the gutters either side of the card, behind it.
        const floating = calm * (1 - M.outOf(clock, 0, 6));
        if (floating > EPS && p.emojis.length) {
          const first = Math.max(0, Math.floor((idle - FLOAT_LIFE) / FLOAT_EVERY) + 1);
          for (let k = first; k <= Math.floor(idle / FLOAT_EVERY); k++) {
            const age = idle - k * FLOAT_EVERY;
            if (age < 0 || age >= FLOAT_LIFE) continue;
            const rand = M.random(`feedback-float:${k}`);
            const side = k % 2 ? 1 : -1;
            const x = 600 + side * (470 + rand() * 80) + Math.sin(age / 12 + rand() * TAU) * 14;
            place(ctx, {
              x,
              y: 520 - age * 4.6,
              rotate: deg(Math.sin(age / 15) * 12),
              scaleX: 0.6 + 0.4 * M.progress(age, 0, 10, Easing.pop),
              alpha: M.progress(age, 0, 8) * (1 - M.progress(age, FLOAT_LIFE - 24, FLOAT_LIFE)) * floating
            }, () => {
              ctx.font = M.emojiFont(64);
              ctx.fillStyle = theme.ink;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(p.emojis[k % p.emojis.length], 0, 0);
            });
          }
        }

        const cardIn = M.spring({ frame: t, fps: FPS, delay: 2, config: { damping: 13, stiffness: 130 } });
        const go = M.outOf(clock, 6, OUTRO, Easing.in(Easing.cubic));
        const cardW = 860;
        const cardH = p.button ? 390 : 300;
        const question = M.fitText(ctx, p.headline || ' ', { maxWidth: 740, maxLines: 1, max: 56, min: 30 });
        const starsY = p.button ? -8 : 36;

        place(ctx, {
          x: 600 + flow.x * 100 * go,
          y: 300 + (1 - cardIn) * 50 + M.wave(idle, 110) * 3 * calm + flow.y * 100 * go,
          rotate: deg((1 - cardIn) * 4 + (flow.x < 0 ? -6 : 6) * go),
          scaleX: (0.85 + 0.15 * cardIn) * M.lerp(1, 0.9, go),
          alpha: M.clamp(cardIn * 1.5, 0, 1) * (1 - go)
        }, () => {
          const top = -cardH / 2;
          M.slabBox(ctx, {
            x: -cardW / 2, y: top, w: cardW, h: cardH,
            r: 30, fill: theme.surface, line: theme.line, lineWidth: 5, slab: 12
          });
          const askIn = M.spring({ frame: t, fps: FPS, delay: 8, config: { damping: 13, stiffness: 150 } });
          place(ctx, { x: 0, y: top + 76 + (1 - askIn) * 20, alpha: M.clamp(askIn * 1.6, 0, 1) }, () => {
            ctx.font = M.font(question.size);
            ctx.fillStyle = theme.ink;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(question.lines[0] || '', 0, 2);
          });

          for (let i = 0; i < 5; i++) {
            const x = (i - 2) * STAR_GAP;
            const fillAt = STAR_FILL + i * STAR_EVERY;
            const appear = M.spring({ frame: t, fps: FPS, delay: 12 + i * 3, config: { damping: 10, stiffness: 170 } });
            const lit = M.progress(t, fillAt, fillAt + 3);
            const bump = Math.sin(Math.PI * M.progress(t, fillAt, fillAt + 10));
            const hop = Math.sin(Math.PI * M.progress(t, STAR_HOP + i * 3, STAR_HOP + i * 3 + 10));
            // Idle: every four seconds a shimmer runs along the row.
            const shimmerAt = M.beat(idle, 120).local - 60 - i * 4;
            const shimmer = (shimmerAt > 0 && shimmerAt < 10 ? Math.sin((Math.PI * shimmerAt) / 10) : 0) * calm;
            const gone = M.outOf(clock, 2 + i * 1.5, 11 + i * 1.5, Easing.back(1.5));

            const spark = M.progress(t, fillAt + 2, fillAt + 14, Easing.out(Easing.quad));
            if (spark > EPS && spark < 1 - EPS) {
              ctx.save();
              ctx.globalAlpha = ctx.globalAlpha * (1 - spark);
              ctx.translate(x, starsY);
              ctx.strokeStyle = theme.ink;
              ctx.lineWidth = 5;
              ctx.lineCap = 'round';
              ctx.beginPath();
              for (let k = 0; k < 5; k++) {
                const a = ((k + 0.5) / 5) * TAU - Math.PI / 2;
                ctx.moveTo(Math.cos(a) * (58 + spark * 16), Math.sin(a) * (58 + spark * 16));
                ctx.lineTo(Math.cos(a) * (58 + spark * 38), Math.sin(a) * (58 + spark * 38));
              }
              ctx.stroke();
              ctx.restore();
            }

            place(ctx, {
              x,
              y: starsY - 22 * hop - 10 * shimmer,
              rotate: deg(shimmer * 10 - hop * 8),
              scaleX: M.clamp(appear, 0, 1.2) * (1 + 0.3 * bump) * (1 - gone),
              alpha: M.clamp(appear * 2, 0, 1) * (1 - M.clamp(gone, 0, 1))
            }, () => {
              M.slabUnder(ctx, (fresh) => sealPath(ctx, STAR_OUTER, STAR_INNER, 5, fresh), 6, 6, theme.line, {
                x: -STAR_OUTER - 4, y: -STAR_OUTER - 4, w: STAR_OUTER * 2 + 14, h: STAR_OUTER * 2 + 14
              });
              sealPath(ctx, STAR_OUTER, STAR_INNER, 5);
              ctx.fillStyle = M.mix(accent, theme.tray, lit);
              ctx.fill();
              ctx.lineWidth = 5;
              ctx.lineJoin = 'round';
              ctx.strokeStyle = theme.line;
              ctx.stroke();
            });
          }

          if (p.button) {
            const pop = M.spring({ frame: t, fps: FPS, delay: STAR_HOP + 4, config: { damping: 10, stiffness: 160 } });
            const unpop = M.outOf(clock, 0, 8, Easing.back(1.6));
            const breathe = M.swell(idle, 90) * calm;
            ctx.font = M.font(38);
            const bw = Math.max(180, ctx.measureText(p.button).width + 96);
            place(ctx, {
              x: 0,
              y: cardH / 2 - 78 - 3 * breathe,
              scaleX: M.clamp(pop, 0, 1.3) * (1 - unpop),
              alpha: M.clamp(pop * 2, 0, 1) * (1 - M.clamp(unpop, 0, 1))
            }, () => {
              M.slabBox(ctx, {
                x: -bw / 2, y: -38, w: bw, h: 76,
                r: 38, fill: theme.ink, line: theme.line, lineWidth: 4, slab: 7 + 3 * breathe, slabColor: accent
              });
              ctx.font = M.font(38);
              ctx.fillStyle = theme.surface;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(p.button, 0, 2);
            });
          }
        });
      });
    }
  };

  // ==========================================
  // REGISTRY
  // ==========================================

  const SCENES = [
    popReveal, blockShuffle, stickerBurst, checklist, stamp, ticker, flipBoard, keycaps, chat, pointClick,
    switchOn, saveTheDate, milestone, headsUp, feedback
  ];
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
