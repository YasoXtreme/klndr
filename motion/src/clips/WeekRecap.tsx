import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { z } from 'zod';
import { FONT, KlndrMotionCore, KlndrPalette } from '../klndr/shared';
import { CheckIcon, LINE, LINE_CONTAINER, RADIUS, SLAB, Slab, blockFill, clamp01, springAt, themeOf } from '../klndr/brand';

export const weekRecapSchema = z.object({
  theme: z.enum(['light', 'dark']),
  title: z.string().max(28),
  dateRange: z.string().max(24),
  counters: z
    .array(
      z.object({
        label: z.string().max(18),
        value: z.number().int().min(0).max(99999),
        suffix: z.string().max(3)
      })
    )
    .max(3),
  doneShare: z.number().min(0).max(1)
});

export type WeekRecapProps = z.infer<typeof weekRecapSchema>;

export const weekRecapDefaults: WeekRecapProps = {
  theme: 'light',
  title: 'Your week in klndr',
  dateRange: 'Sep 8 - 14',
  counters: [
    { label: 'Blocks planned', value: 42, suffix: '' },
    { label: 'Hours focused', value: 31, suffix: 'h' },
    { label: 'Ticked off', value: 86, suffix: '%' }
  ],
  doneShare: 0.7
};

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
// [day, first slot, slots, palette colour] - a believable week rather than a random one.
const WEEK: Array<[number, number, number, number]> = [
  [0, 0, 3, 0], [0, 4, 2, 1], [0, 7, 3, 2],
  [1, 1, 2, 4], [1, 4, 4, 0],
  [2, 0, 2, 6], [2, 3, 3, 7], [2, 7, 2, 1],
  [3, 2, 4, 2], [3, 7, 3, 9],
  [4, 0, 3, 1], [4, 4, 2, 10], [4, 7, 2, 0],
  [5, 3, 3, 5],
  [6, 5, 3, 4]
];
const COUNTER_COLOURS = [KlndrPalette.colors[1], KlndrPalette.colors[0], KlndrPalette.colors[9]];

const CARD = { x: 70, y: 160, w: 720, h: 390 };
const INNER_W = CARD.w - LINE_CONTAINER * 2;
const HEADER = 56;
const SLOT = 30;
const COLUMN = INNER_W / DAYS.length;

/** A week filling up with blocks, some ticked off, beside counters that count up. */
export const WeekRecap: React.FC<WeekRecapProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = themeOf(props.theme);

  // Everything has left by the last frame, so the clip loops onto its empty first one.
  const exit = interpolate(frame, [176, 204], [0, 1], { ...CLAMP, easing: Easing.in(Easing.cubic) });
  const titleIn = springAt(frame, fps, 4, { damping: 13, stiffness: 130 });
  const cardIn = springAt(frame, fps, 0, { damping: 14, stiffness: 120 });
  const faint = KlndrMotionCore.alpha(t.ink, 0.1);

  return (
    <AbsoluteFill style={{ background: t.ground, overflow: 'hidden', fontFamily: FONT }}>
      <div
        style={{
          position: 'absolute',
          left: 70,
          top: 36,
          opacity: clamp01(titleIn * 1.5) * (1 - exit),
          transform: `translateY(${(1 - titleIn) * 24}px)`
        }}
      >
        <div style={{ fontWeight: 900, fontSize: 52, lineHeight: 1.1, color: t.ink }}>{props.title}</div>
        <div style={{ fontWeight: 800, fontSize: 26, color: t.inkSoft, marginTop: 4 }}>{props.dateRange}</div>
      </div>

      <Slab
        fill={t.surface}
        line={t.line}
        slab={SLAB}
        radius={RADIUS.md}
        lineWidth={LINE_CONTAINER}
        style={{
          position: 'absolute',
          left: CARD.x,
          top: CARD.y,
          width: CARD.w,
          height: CARD.h,
          overflow: 'hidden',
          opacity: clamp01(cardIn * 1.5) * (1 - exit),
          transform: `translateY(${(1 - cardIn) * 60 + exit * 30}px) scaleY(${0.9 + 0.1 * cardIn})`
        }}
      >
        <div style={{ display: 'flex', height: HEADER, borderBottom: `${LINE}px solid ${t.line}`, boxSizing: 'border-box' }}>
          {DAYS.map((day, i) => (
            <div
              key={i}
              style={{
                width: COLUMN,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 900,
                fontSize: 24,
                color: i >= 5 ? t.inkSoft : t.ink
              }}
            >
              {day}
            </div>
          ))}
        </div>
        {DAYS.slice(1).map((_, i) => (
          <div
            key={i}
            style={{ position: 'absolute', left: COLUMN * (i + 1), top: HEADER, bottom: 0, width: 2, background: faint }}
          />
        ))}
      </Slab>

      {WEEK.map(([day, start, slots, colour], i) => {
        const drop = springAt(frame, fps, 18 + i * 4, { damping: 11, stiffness: 140 });
        const done = ((i * 7 + 3) % 17) / 17 < props.doneShare;
        const tick = done ? interpolate(frame, [100 + i * 2, 112 + i * 2], [0, 1], CLAMP) : 0;
        const fall = clamp01(exit * 1.6 - (day % 7) * 0.08);
        return (
          <Slab
            key={i}
            fill={blockFill(KlndrPalette.colors[colour], t)}
            line={t.onColorLine}
            slab={5}
            radius={RADIUS.sm * 0.75}
            style={{
              position: 'absolute',
              left: CARD.x + LINE_CONTAINER + COLUMN * day + 8,
              top: CARD.y + LINE_CONTAINER + HEADER + 12 + start * SLOT + 3,
              width: COLUMN - 16,
              height: slots * SLOT - 6,
              display: 'flex',
              justifyContent: 'flex-end',
              padding: 6,
              opacity: clamp01(drop * 2) * (1 - fall),
              transform: `translateY(${(1 - drop) * -120 + fall * fall * 420}px) rotate(${(1 - clamp01(drop)) * -6}deg)`
            }}
          >
            {tick > 0 ? <CheckIcon size={26} color={t.onColorInk} progress={tick} /> : null}
          </Slab>
        );
      })}

      {props.counters.map((counter, i) => {
        const cardInAt = springAt(frame, fps, 20 + i * 6, { damping: 13, stiffness: 120 });
        const value = interpolate(frame, [40 + i * 8, 130 + i * 8], [0, counter.value], {
          ...CLAMP,
          easing: Easing.out(Easing.cubic)
        });
        return (
          <Slab
            key={i}
            fill={t.surface}
            line={t.line}
            slab={SLAB}
            radius={RADIUS.md}
            lineWidth={LINE_CONTAINER}
            style={{
              position: 'absolute',
              left: 830,
              top: CARD.y + i * 134,
              width: 300,
              height: 112,
              padding: '14px 22px',
              opacity: clamp01(cardInAt * 1.5) * (1 - exit),
              transform: `translateX(${(1 - cardInAt) * 90 + exit * 80}px)`
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontWeight: 800, fontSize: 22, color: t.inkSoft }}>{counter.label}</span>
              <Slab
                fill={blockFill(COUNTER_COLOURS[i], t)}
                line={t.line}
                slab={0}
                radius={RADIUS.pill}
                lineWidth={3}
                style={{ width: 22, height: 22 }}
              />
            </div>
            <div style={{ fontWeight: 900, fontSize: 54, lineHeight: 1.1, color: t.ink, fontVariantNumeric: 'tabular-nums' }}>
              {Math.round(value)}
              <span style={{ fontSize: 32, marginLeft: 2 }}>{counter.suffix}</span>
            </div>
          </Slab>
        );
      })}
    </AbsoluteFill>
  );
};
