// Klndr Motion Scenes
//
// The built-in animated headers: six short loops in klndr's own drawing style -
// flat fills, hard lines, offset slabs, ElmsSans Black - that an admin picks
// from a gallery and fills in with their own words, emoji and colours.
//
// That is the Remotion idea without Remotion's runtime. A scene is a function of
// (frame, props), so this one file plays live in the app, scrubs in the Studio,
// and renders to MP4 from motion/, which imports it unchanged.
//
// Every scene starts and ends on an empty stage - the ticker instead scrolls
// exactly one period - so a loop never jumps. test/motion.test.js holds each of
// them to that.

const KlndrScenes = (() => {
  const M = typeof KlndrMotionCore !== 'undefined' ? KlndrMotionCore : require('./motion-core');
  const Palette = typeof KlndrPalette !== 'undefined' ? KlndrPalette : require('../palette');

  const FPS = 30;
  const WIDTH = 1200;
  const BASE_HEIGHT = 600;
  const EPS = 0.001;
  const TAU = Math.PI * 2;
  const HEX = /^#[0-9a-f]{6}$/i;
  const { Easing } = M;

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

  // ==========================================
  // DRAWING HELPERS
  // ==========================================

  // The calendar's own grid, faintly, so a scene reads as klndr before anything
  // has moved.
  function paintGround(ctx, env, color) {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, env.width, env.height);
    ctx.strokeStyle = M.alpha(env.theme.ink, 0.07);
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 60; x < env.width; x += 60) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, env.height);
    }
    for (let y = 60; y < env.height; y += 60) {
      ctx.moveTo(0, y);
      ctx.lineTo(env.width, y);
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

  function sealPath(ctx, outer, inner, points) {
    ctx.beginPath();
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

  function drawConfetti(ctx, pieces, frame, exit, layer, theme) {
    const t = frame - 16;
    if (t <= 0) return;
    const opacity = (1 - M.progress(t, 44, 76)) * exit;
    if (opacity <= EPS) return;

    for (const piece of pieces) {
      if (piece.layer !== layer) continue;
      const x = piece.x + piece.vx * t;
      const y = piece.y + piece.vy * t + 0.45 * t * t;
      place(ctx, { x, y, rotate: piece.spin * t, alpha: opacity }, () => {
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
    durationInFrames: 150,
    stillFrame: 72,
    schema: [
      { key: 'eyebrow', type: 'text', label: 'Tag', max: 16, default: 'NEW' },
      { key: 'headline', type: 'text', label: 'Headline', max: 48, default: 'Something fresh just landed' },
      { key: 'accent', type: 'color', label: 'Accent', default: '#9ae659' },
      { key: 'background', type: 'color', label: 'Background', optional: true, default: '' },
      { key: 'confetti', type: 'toggle', label: 'Confetti', default: true }
    ],
    describe: (p) => [p.eyebrow, p.headline].filter(Boolean).join(': '),
    render(ctx, frame, p, env) {
      const t = env.theme;
      paintGround(ctx, env, p.background || t.mint);

      onStage(ctx, env, () => {
        const exit = 1 - M.progress(frame, 124, 146, Easing.inOut(Easing.cubic));
        const cardIn = M.spring({ frame, fps: FPS, delay: 2, config: { damping: 12, stiffness: 120 } });
        const presence = M.clamp(cardIn * 1.5, 0, 1) * exit;

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

        drawConfetti(ctx, pieces, frame, exit, 0, t);

        place(ctx, {
          x: 600,
          y: 312 + M.loopWave(frame, 150, 2) * 7 + (1 - exit) * 50,
          rotate: deg(M.lerp(-9, -2, cardIn) + M.loopWave(frame, 150, 1, 0.25) * 1.2),
          scaleX: (0.6 + 0.4 * cardIn) * M.lerp(0.9, 1, exit),
          alpha: presence
        }, () => {
          M.slabBox(ctx, {
            x: -cardW / 2, y: -cardH / 2, w: cardW, h: cardH,
            r: 28, fill: t.surface, line: t.line, lineWidth: 5, slab: 12
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
              const s = M.spring({ frame, fps: FPS, delay: 12 + index * 3, config: { damping: 10, stiffness: 170 } });
              place(ctx, {
                x: x + widths[i] / 2,
                y: y + (1 - s) * 34,
                scaleX: 0.55 + 0.45 * s,
                alpha: M.clamp(s * 1.6, 0, 1)
              }, () => {
                ctx.fillStyle = t.ink;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(word, 0, 0);
              });
              x += widths[i] + space;
              index += 1;
            });
          });

          if (p.eyebrow) {
            const tagIn = M.spring({ frame, fps: FPS, delay: 10, config: { damping: 9, stiffness: 150 } });
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
                r: 30, fill: p.accent, line: t.line, lineWidth: 4, slab: 6
              });
              ctx.font = M.font(30);
              ctx.fillStyle = inkOn(p.accent, t);
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(p.eyebrow, 0, 2);
            });
          }
        });

        drawConfetti(ctx, pieces, frame, exit, 1, t);

        SPARKS.forEach(([x, y, r, phase]) => {
          const twinkle = Math.max(0, M.loopWave(frame, 150, 3, phase));
          place(ctx, { x, y, rotate: frame * 0.02, scaleX: twinkle * presence, alpha: presence }, () => {
            sparklePath(ctx, r);
            ctx.fillStyle = p.accent;
            ctx.fill();
            ctx.lineWidth = 4;
            ctx.strokeStyle = t.line;
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

  function drawBlock(ctx, { x, y, w, h, colour, label, time, done, theme, alpha, scale = 1, tilt = 0 }) {
    place(ctx, { x: x + w / 2, y: y + h / 2, rotate: deg(tilt), scaleX: scale, alpha }, () => {
      M.slabBox(ctx, {
        x: -w / 2, y: -h / 2, w, h,
        r: 16, fill: M.taskFill(colour, theme), line: theme.onColorLine, lineWidth: 4, slab: 6
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

  const blockShuffle = {
    id: 'block-shuffle',
    name: 'Blocks in motion',
    description: 'A mini week: a new block drops in and nudges the others along, the way the calendar does.',
    durationInFrames: 180,
    stillFrame: 104,
    schema: [
      { key: 'title', type: 'text', label: 'Title', max: 36, default: 'Your week, rearranged' },
      { key: 'labels', type: 'list', label: 'Block labels', max: 14, maxItems: 5, default: BLOCK_LABELS.slice() },
      { key: 'accent', type: 'color', label: 'New block colour', default: '#fde047' },
      { key: 'background', type: 'color', label: 'Background', optional: true, default: '' }
    ],
    describe: (p) => p.title,
    render(ctx, frame, p, env) {
      const t = env.theme;
      const label = (i) => p.labels[i] || BLOCK_LABELS[i];
      paintGround(ctx, env, p.background || t.ground);

      onStage(ctx, env, () => {
        const exit = 1 - M.progress(frame, 158, 176, Easing.inOut(Easing.cubic));
        const laneIn = M.spring({ frame, fps: FPS, config: { damping: 14, stiffness: 120 } });
        const presence = M.clamp(laneIn * 1.4, 0, 1) * exit;

        const titleIn = M.spring({ frame, fps: FPS, delay: 4, config: { damping: 13, stiffness: 130 } });
        const title = M.fitText(ctx, p.title || ' ', { maxWidth: 940, maxLines: 1, max: 58, min: 30 });
        place(ctx, {
          x: 100,
          y: 128 + (1 - titleIn) * 24,
          alpha: M.clamp(titleIn * 1.5, 0, 1) * exit
        }, () => {
          ctx.font = M.font(title.size);
          ctx.fillStyle = t.ink;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(title.lines[0] || '', 0, 0);
        });

        place(ctx, { x: 600, y: 330, scaleY: 0.85 + 0.15 * laneIn, alpha: presence }, () => {
          M.slabBox(ctx, {
            x: -510, y: -140, w: 1020, h: 280,
            r: 24, fill: t.surface, line: t.line, lineWidth: 5, slab: 10
          });
          ctx.font = M.font(22, 800);
          ctx.fillStyle = t.inkSoft;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ['9', '10', '11', '12', '1', '2', '3', '4'].forEach((hour, i) => {
            const x = -450 + i * 120;
            ctx.fillText(hour, x, -110);
            ctx.strokeStyle = M.alpha(t.ink, 0.12);
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x, -80);
            ctx.lineTo(x, 130);
            ctx.stroke();
          });
          ctx.strokeStyle = t.line;
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.moveTo(-510, -80);
          ctx.lineTo(510, -80);
          ctx.stroke();
        });

        BLOCKS.forEach((block, i) => {
          const appear = M.spring({ frame, fps: FPS, delay: 8 + i * 4, config: { damping: 11, stiffness: 150 } });
          const push = i > 0
            ? M.spring({ frame, fps: FPS, delay: 44 + (i - 1) * 5, config: { damping: 13, stiffness: 140 } })
            : 0;
          const back = i > 0
            ? M.spring({ frame, fps: FPS, delay: 136 + (3 - i) * 4, config: { damping: 14, stiffness: 120 } })
            : 0;
          const target = PUSHED[i] || block;
          const x = M.lerp(M.lerp(block.x, target.x, push), block.x, back);
          const w = M.lerp(M.lerp(block.w, target.w, push), block.w, back);
          const done = i === 0
            ? M.progress(frame, 100, 112, Easing.out(Easing.cubic)) * (1 - M.progress(frame, 132, 142))
            : 0;
          drawBlock(ctx, {
            x, y: LANE_Y, w, h: 120,
            colour: block.colour,
            label: label(i),
            time: block.time,
            done,
            theme: t,
            alpha: M.clamp(appear * 1.6, 0, 1) * exit,
            scale: 0.7 + 0.3 * M.clamp(appear, 0, 1.1)
          });
        });

        const drop = M.spring({ frame, fps: FPS, delay: 34, config: { damping: 9, stiffness: 110 } });
        const lift = M.progress(frame, 130, 150, Easing.in(Easing.cubic));
        const dropAlpha = M.clamp((frame - 34) / 6, 0, 1) * (1 - lift) * exit;
        const near = M.clamp(drop, 0, 1) * (1 - lift);

        if (dropAlpha > EPS && near > EPS) {
          ctx.fillStyle = M.alpha(t.ink, 0.16 * near * exit);
          ctx.beginPath();
          ctx.ellipse(DROP.x + DROP.w / 2, LANE_Y + 136, DROP.w * 0.45 * near, 10 * near, 0, 0, TAU);
          ctx.fill();
        }

        drawBlock(ctx, {
          x: DROP.x,
          y: M.lerp(-220, LANE_Y, drop) - lift * 260,
          w: DROP.w,
          h: 120,
          colour: p.accent,
          label: label(4),
          time: DROP.time,
          done: 0,
          theme: t,
          alpha: dropAlpha,
          tilt: (1 - M.clamp(drop, 0, 1)) * -8
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
    durationInFrames: 150,
    stillFrame: 72,
    schema: [
      { key: 'headline', type: 'text', label: 'Headline', max: 36, default: 'Big update!' },
      { key: 'emojis', type: 'list', label: 'Stickers', max: 8, maxItems: 6, default: ['🎉', '⚡', '📅', '✅', '🔥', '✨'] },
      { key: 'accent', type: 'color', label: 'Headline colour', default: '#d985f5' },
      { key: 'background', type: 'color', label: 'Background', optional: true, default: '' }
    ],
    describe: (p) => p.headline,
    render(ctx, frame, p, env) {
      const t = env.theme;
      paintGround(ctx, env, p.background || t.ground);

      onStage(ctx, env, () => {
        const slots = stickerSlots(p.emojis.length);

        slots.forEach((slot, i) => {
          const launch = 16 + i * 4;
          const s = M.spring({ frame, fps: FPS, delay: launch, config: { damping: 9, stiffness: 120 } });
          const home = M.progress(frame, 118 + i * 2, 136 + i * 2, Easing.in(Easing.cubic));
          const reach = s * (1 - home);
          const settled = M.clamp(s, 0, 1);

          const ring = M.progress(frame, launch + 9, launch + 23, Easing.out(Easing.quad));
          if (ring > EPS && ring < 1 - EPS) {
            ctx.save();
            ctx.globalAlpha = ctx.globalAlpha * (1 - ring);
            ctx.strokeStyle = t.line;
            ctx.lineWidth = 5;
            ctx.beginPath();
            ctx.arc(slot.x, slot.y, M.lerp(60, 120, ring), 0, TAU);
            ctx.stroke();
            ctx.restore();
          }

          place(ctx, {
            x: M.lerp(600, slot.x, reach) + M.loopWave(frame, 150, 2, i * 0.13) * 5 * settled,
            y: M.lerp(300, slot.y, reach) + M.loopWave(frame, 150, 3, i * 0.21) * 7 * settled,
            rotate: deg(slot.tilt + M.loopWave(frame, 150, 2, i * 0.17) * 8 * settled),
            scaleX: (0.2 + 0.8 * M.clamp(s, 0, 1.2)) * (1 - home),
            alpha: M.clamp(s * 2, 0, 1) * (1 - home)
          }, () => {
            M.slabBox(ctx, {
              x: -64, y: -64, w: 128, h: 128,
              r: 32, fill: t.surface, line: t.line, lineWidth: 5, slab: 8
            });
            ctx.font = M.emojiFont(74);
            ctx.fillStyle = t.ink;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(p.emojis[i], 0, 5);
          });
        });

        const plateIn = M.spring({ frame, fps: FPS, delay: 4, config: { damping: 11, stiffness: 150 } });
        const plateOut = M.progress(frame, 130, 147, Easing.back(1.6));
        const { size, lines } = M.fitText(ctx, p.headline || ' ', { maxWidth: 520, maxLines: 2, max: 84, min: 40 });
        ctx.font = M.font(size);
        const textW = Math.max(120, ...lines.map((line) => ctx.measureText(line).width));
        const plateW = Math.min(680, textW + 110);
        const plateH = lines.length * size * 1.06 + 86;

        place(ctx, {
          x: 600,
          y: 300,
          rotate: deg(M.lerp(-16, -3, plateIn) + M.loopWave(frame, 150, 1) * 1.5),
          scaleX: plateIn * (1 - plateOut),
          alpha: M.clamp(plateIn * 2, 0, 1)
        }, () => {
          M.slabBox(ctx, {
            x: -plateW / 2, y: -plateH / 2, w: plateW, h: plateH,
            r: 26, fill: p.accent, line: t.line, lineWidth: 5, slab: 12
          });
          ctx.font = M.font(size);
          centeredLines(ctx, lines, { x: 0, y: 0, size, color: inkOn(p.accent, t) });
        });
      });
    }
  };

  // ==========================================
  // SCENE: CHECKLIST
  // ==========================================

  const checklist = {
    id: 'checklist',
    name: 'Checklist',
    description: 'A card of tasks that tick off one by one, with a little celebration at the end.',
    durationInFrames: 180,
    stillFrame: 130,
    schema: [
      { key: 'title', type: 'text', label: 'Title', max: 28, default: "Today's wins" },
      { key: 'items', type: 'list', label: 'Items', max: 30, maxItems: 4, default: ['Plan the week', 'Split the big task', 'Drag blocks around', 'Tick things off'] },
      { key: 'accent', type: 'color', label: 'Tick colour', default: '#9ae659' },
      { key: 'badge', type: 'text', label: 'Finish badge', max: 12, default: 'Done!' },
      { key: 'background', type: 'color', label: 'Background', optional: true, default: '' }
    ],
    describe: (p) => [p.title, p.items.join(', ')].filter(Boolean).join(': '),
    render(ctx, frame, p, env) {
      const t = env.theme;
      paintGround(ctx, env, p.background || t.mint);

      onStage(ctx, env, () => {
        const items = p.items;
        const n = items.length;
        const rowH = 76;
        const cardW = 740;
        const cardH = 36 + 84 + n * rowH + 60 + 24;
        const tickAt = (i) => 40 + i * 20;
        const finished = tickAt(n - 1) + 18;
        const exit = M.progress(frame, 152, 176, Easing.in(Easing.cubic));
        const cardIn = M.spring({ frame, fps: FPS, delay: 2, config: { damping: 13, stiffness: 120 } });
        const title = M.fitText(ctx, p.title || ' ', { maxWidth: 520, maxLines: 1, max: 46, min: 28 });

        place(ctx, {
          x: 600,
          y: 300 + (1 - cardIn) * 40 + exit * 90,
          rotate: deg((1 - cardIn) * 4 + exit * 7),
          scaleX: 0.88 + 0.12 * cardIn,
          alpha: M.clamp(cardIn * 1.5, 0, 1) * (1 - exit)
        }, () => {
          const left = -cardW / 2;
          const top = -cardH / 2;
          M.slabBox(ctx, {
            x: left, y: top, w: cardW, h: cardH,
            r: 28, fill: t.surface, line: t.line, lineWidth: 5, slab: 12
          });

          const doneCount = items.filter((_, i) => frame >= tickAt(i) + 4).length;
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'left';
          ctx.fillStyle = t.ink;
          ctx.font = M.font(title.size);
          ctx.fillText(title.lines[0] || '', left + 44, top + 74);
          ctx.textAlign = 'right';
          ctx.fillStyle = t.inkSoft;
          ctx.font = M.font(30, 800);
          ctx.fillText(`${doneCount}/${n}`, -left - 44, top + 74);

          items.forEach((item, i) => {
            const rowY = top + 120 + i * rowH + rowH / 2;
            const slide = M.spring({ frame, fps: FPS, delay: 10 + i * 5, config: { damping: 12, stiffness: 150 } });
            const tick = M.progress(frame, tickAt(i), tickAt(i) + 8, Easing.out(Easing.cubic));
            const strike = M.progress(frame, tickAt(i) + 4, tickAt(i) + 16, Easing.inOut(Easing.quad));
            const bump = Math.sin(Math.PI * M.progress(frame, tickAt(i), tickAt(i) + 10));
            const burst = M.progress(frame, tickAt(i) + 2, tickAt(i) + 16);

            place(ctx, {
              x: left + 44 - (1 - slide) * 50,
              y: rowY,
              alpha: M.clamp(slide * 1.6, 0, 1)
            }, () => {
              if (burst > EPS && burst < 1 - EPS) {
                ctx.save();
                ctx.globalAlpha = ctx.globalAlpha * (1 - burst);
                ctx.translate(24, 0);
                ctx.strokeStyle = t.ink;
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

              place(ctx, { x: 24, y: 0, scaleX: 1 + bump * 0.22 }, () => {
                M.slabBox(ctx, {
                  x: -24, y: -24, w: 48, h: 48,
                  r: 12, fill: tick > EPS ? p.accent : t.surface, line: t.line, lineWidth: 4, slab: 0
                });
                if (tick > EPS) {
                  checkPath(ctx, 34);
                  ctx.setLineDash([46, 46]);
                  ctx.lineDashOffset = 46 * (1 - tick);
                  ctx.strokeStyle = inkOn(p.accent, t);
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
              ctx.fillStyle = t.ink;
              ctx.globalAlpha = ctx.globalAlpha * (1 - strike * 0.5);
              ctx.fillText(item, 76, 2);
              if (strike > EPS) {
                ctx.strokeStyle = t.ink;
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
              M.spring({ frame, fps: FPS, delay: tickAt(i) + 2, config: { damping: 15, stiffness: 140 } }),
              0,
              1
            );
          }
          const fraction = n ? filled / n : 0;
          M.slabBox(ctx, {
            x: left + 44, y: barY, w: barW, h: 26,
            r: 13, fill: t.tray, line: t.line, lineWidth: 3, slab: 0
          });
          if (fraction > EPS) {
            M.slabBox(ctx, {
              x: left + 48, y: barY + 4, w: Math.max(18, (barW - 8) * fraction), h: 18,
              r: 9, fill: p.accent, line: t.line, lineWidth: 0, slab: 0
            });
          }

          if (p.badge) {
            const pop = M.spring({ frame, fps: FPS, delay: finished, config: { damping: 8, stiffness: 160 } });
            ctx.font = M.font(32);
            const badgeW = ctx.measureText(p.badge).width + 50;
            place(ctx, {
              x: -left - 36,
              y: top + 2,
              rotate: deg(12),
              scaleX: pop,
              alpha: M.clamp(pop * 2, 0, 1)
            }, () => {
              M.slabBox(ctx, {
                x: -badgeW / 2, y: -32, w: badgeW, h: 64,
                r: 32, fill: p.accent, line: t.line, lineWidth: 5, slab: 6
              });
              ctx.font = M.font(32);
              ctx.fillStyle = inkOn(p.accent, t);
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

  const stamp = {
    id: 'stamp',
    name: 'Stamp',
    description: 'A big badge slams down with a shake, a puff of dust and a spinning sunburst.',
    durationInFrames: 150,
    stillFrame: 64,
    schema: [
      { key: 'label', type: 'text', label: 'Badge text', max: 10, default: 'NEW' },
      { key: 'sublabel', type: 'text', label: 'Caption', max: 32, default: 'Fresh in klndr' },
      { key: 'color', type: 'color', label: 'Badge colour', default: '#fde047' },
      { key: 'background', type: 'color', label: 'Background', optional: true, default: '' }
    ],
    describe: (p) => [p.label, p.sublabel].filter(Boolean).join(': '),
    render(ctx, frame, p, env) {
      const t = env.theme;
      paintGround(ctx, env, p.background || t.ground);

      onStage(ctx, env, () => {
        const cx = 600;
        const cy = 268;
        const exit = M.progress(frame, 120, 144, Easing.in(Easing.cubic));
        const slam = M.progress(frame, 4, 16, Easing.in(Easing.cubic));
        const since = frame - 16;
        const impact = since >= 0 ? Math.exp(-since / 4.5) * Math.cos(since / 1.8) : 0;
        const shake = since >= 0 && since < 22 ? Math.exp(-since / 5) : 0;
        const shakeX = shake * 16 * Math.sin(frame * 1.9);
        const shakeY = shake * 10 * Math.cos(frame * 1.3);

        const rays = M.progress(frame, 12, 30) * (1 - M.progress(frame, 118, 142));
        if (rays > EPS) {
          ctx.save();
          ctx.globalAlpha = ctx.globalAlpha * rays;
          ctx.translate(cx, cy);
          ctx.rotate((frame / 150) * (TAU / 10));
          ctx.fillStyle = M.alpha(p.color, 0.35);
          ctx.beginPath();
          for (let i = 0; i < 20; i += 2) {
            const a0 = (i / 20) * TAU;
            const a1 = ((i + 1) / 20) * TAU;
            ctx.moveTo(0, 0);
            ctx.lineTo(Math.cos(a0) * 900, Math.sin(a0) * 900);
            ctx.lineTo(Math.cos(a1) * 900, Math.sin(a1) * 900);
            ctx.closePath();
          }
          ctx.fill();
          ctx.restore();
        }

        const dust = M.progress(frame, 16, 42, Easing.out(Easing.quad));
        if (dust > EPS && dust < 1 - EPS) {
          ctx.save();
          ctx.globalAlpha = ctx.globalAlpha * (1 - dust);
          ctx.fillStyle = t.surface;
          ctx.strokeStyle = t.line;
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

        const scale = M.lerp(2.6, 1, slam) * (1 + exit * 0.35) * (1 + M.loopWave(frame, 150, 2) * 0.012);
        place(ctx, {
          x: cx + shakeX,
          y: cy + shakeY,
          rotate: deg(M.lerp(-26, -8, slam) + M.loopWave(frame, 150, 1) * 2),
          scaleX: scale * (1 + impact * 0.16),
          scaleY: scale * (1 - impact * 0.16),
          alpha: M.progress(frame, 4, 9) * (1 - exit)
        }, () => {
          ctx.save();
          ctx.translate(12, 12);
          sealPath(ctx, 196, 176, 24);
          ctx.fillStyle = t.line;
          ctx.fill();
          ctx.restore();

          sealPath(ctx, 196, 176, 24);
          ctx.fillStyle = p.color;
          ctx.fill();
          ctx.lineWidth = 6;
          ctx.strokeStyle = t.line;
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(0, 0, 138, 0, TAU);
          ctx.setLineDash([14, 12]);
          ctx.lineWidth = 5;
          ctx.strokeStyle = inkOn(p.color, t);
          ctx.stroke();
          ctx.setLineDash([]);

          const text = M.fitText(ctx, p.label || ' ', { maxWidth: 240, maxLines: 1, max: 118, min: 40 });
          ctx.font = M.font(text.size);
          centeredLines(ctx, text.lines, { x: 0, y: 0, size: text.size, color: inkOn(p.color, t) });
        });

        if (p.sublabel) {
          const rise = M.spring({ frame, fps: FPS, delay: 26, config: { damping: 12, stiffness: 130 } });
          ctx.font = M.font(32, 800);
          const w = ctx.measureText(p.sublabel).width + 56;
          place(ctx, {
            x: cx,
            y: 530 + (1 - rise) * 50 + exit * 60,
            alpha: M.clamp(rise * 1.5, 0, 1) * (1 - exit)
          }, () => {
            M.slabBox(ctx, {
              x: -w / 2, y: -34, w, h: 68,
              r: 34, fill: t.surface, line: t.line, lineWidth: 5, slab: 7
            });
            ctx.font = M.font(32, 800);
            ctx.fillStyle = t.ink;
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

  const ticker = {
    id: 'ticker',
    name: 'Ticker',
    description: 'Rows of chunky word pills scroll past behind your headline.',
    durationInFrames: 150,
    stillFrame: 40,
    schema: [
      { key: 'headline', type: 'text', label: 'Headline', max: 32, default: "What's new in klndr" },
      { key: 'words', type: 'list', label: 'Words', max: 16, maxItems: 10, default: ['Faster', 'Smoother', 'Dark mode', 'Stories', 'Reactions', 'Studio', 'Motion', 'Polish'] },
      { key: 'accent', type: 'color', label: 'Headline colour', default: '#9ae659' },
      { key: 'background', type: 'color', label: 'Background', optional: true, default: '' }
    ],
    describe: (p) => p.headline,
    // Laid out across the whole canvas rather than on the stage: a ticker that
    // stopped short of the edges on a wide header would not be a ticker.
    render(ctx, frame, p, env) {
      const t = env.theme;
      paintGround(ctx, env, p.background || t.ground);
      const s = M.clamp(env.height / BASE_HEIGHT, 0.6, 1.3);

      ctx.save();
      ctx.translate(env.width / 2, env.height / 2);
      ctx.rotate(deg(-5));
      ctx.translate(-env.width / 2, -env.height / 2);

      [0.2, 0.5, 0.8].forEach((fraction, row) => {
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

        // One whole period per loop, so the last frame hands over to the first
        // without a seam.
        const period = Math.max(cursor, 1);
        const direction = row % 2 === 0 ? 1 : -1;
        const offset = ((((frame / 150) * period * direction) % period) + period) % period;

        for (let rep = -2; rep * period - offset - 200 < env.width + 400; rep++) {
          for (const tile of tiles) {
            const x = rep * period + tile.x - offset - 200;
            if (x > env.width + 300 || x + tile.w < -300) continue;
            M.slabBox(ctx, {
              x, y: y - h / 2, w: tile.w, h,
              r: h / 2, fill: M.taskFill(tile.colour, t), line: t.onColorLine, lineWidth: 4 * s, slab: 6 * s
            });
            ctx.font = M.font(42 * s);
            ctx.fillStyle = t.onColorInk;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(tile.word, x + tile.w / 2, y + 2 * s);
          }
        }
      });
      ctx.restore();

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
        x: env.width / 2,
        y: env.height / 2,
        rotate: deg(-3 + M.loopWave(frame, 150, 1) * 1.5),
        scaleX: 1 + M.loopWave(frame, 150, 2) * 0.025
      }, () => {
        M.slabBox(ctx, {
          x: -plateW / 2, y: -plateH / 2, w: plateW, h: plateH,
          r: 26 * s, fill: p.accent, line: t.line, lineWidth: 5, slab: 12 * s
        });
        ctx.font = M.font(size);
        centeredLines(ctx, lines, { x: 0, y: 0, size, color: inkOn(p.accent, t) });
      });
    }
  };

  // ==========================================
  // REGISTRY
  // ==========================================

  const SCENES = [popReveal, blockShuffle, stickerBurst, checklist, stamp, ticker];
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

  function list() {
    return SCENES.map((scene) => ({
      id: scene.id,
      name: scene.name,
      description: scene.description,
      fps: FPS,
      durationInFrames: scene.durationInFrames,
      stillFrame: scene.stillFrame,
      schema: scene.schema,
      defaults: defaultsOf(scene)
    }));
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

  /**
   * Draw one frame. `props` should already be sanitized - the player and the
   * Remotion composition both do that once, not sixty times a second.
   */
  function render(ctx, id, frame, props, env = {}) {
    const scene = get(id);
    if (!scene) return;
    const size = env.width && env.height ? env : sizeFor(2);
    scene.render(ctx, frame, props, {
      width: size.width,
      height: size.height,
      theme: env.theme || M.readTheme('light')
    });
  }

  return { FPS, WIDTH, BASE_HEIGHT, list, get, sanitizeProps, describe, sizeFor, render };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = KlndrScenes;
