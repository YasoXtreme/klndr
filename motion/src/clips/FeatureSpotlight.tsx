import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { z } from 'zod';
import { zColor } from '@remotion/zod-types';
import { FONT, KlndrMotionCore, KlndrPalette, type Theme } from '../klndr/shared';
import {
  CheckIcon,
  Cursor,
  KlndrMark,
  LINE,
  LINE_CONTAINER,
  RADIUS,
  SLAB,
  SLAB_FLOAT,
  Slab,
  Tag,
  Wordmark,
  blockFill,
  clamp01,
  springAt,
  themeOf
} from '../klndr/brand';

export const featureSpotlightSchema = z.object({
  theme: z.enum(['light', 'dark']),
  eyebrow: z.string().max(16),
  headline: z.string().max(48),
  subline: z.string().max(90),
  buttonLabel: z.string().max(16),
  accent: zColor(),
  blocks: z.array(z.string().max(14)).max(3)
});

export type FeatureSpotlightProps = z.infer<typeof featureSpotlightSchema>;

export const featureSpotlightDefaults: FeatureSpotlightProps = {
  theme: 'light',
  eyebrow: 'NEW',
  headline: 'Split a block in two',
  subline: 'Alt-click anywhere on a block to cut it right at the pointer.',
  buttonLabel: 'Split block',
  accent: '#9ae659',
  blocks: ['Deep work', 'Gym', 'Read']
};

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

// Where things sit on the 1200x600 stage. Positions inside the window are
// measured from inside its border.
const WINDOW = { x: 220, y: 84, w: 760, h: 400 };
const TOPBAR = 72;
const BUTTON = { x: 476, y: 256, w: 240, h: 76 };
const TARGET = {
  x: WINDOW.x + LINE_CONTAINER + BUTTON.x + BUTTON.w / 2,
  y: WINDOW.y + LINE_CONTAINER + BUTTON.y + BUTTON.h / 2
};
const LANE = [
  { x: 28, w: 250, time: '9:00', colour: KlndrPalette.colors[0] },
  { x: 294, w: 190, time: '11:30', colour: KlndrPalette.colors[2] },
  { x: 500, w: 230, time: '1:00', colour: KlndrPalette.colors[4] }
];

const Block: React.FC<{ theme: Theme; label: string; time: string; colour: string; style: React.CSSProperties }> = ({
  theme,
  label,
  time,
  colour,
  style
}) => (
  <Slab
    fill={blockFill(colour, theme)}
    line={theme.onColorLine}
    slab={6}
    radius={RADIUS.sm}
    style={{ position: 'absolute', height: 100, padding: '14px 18px', overflow: 'hidden', ...style }}
  >
    <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: 26, color: theme.onColorInk, whiteSpace: 'nowrap' }}>
      {label}
    </div>
    <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 20, color: theme.onColorInk, opacity: 0.72, marginTop: 6 }}>
      {time}
    </div>
  </Slab>
);

/** A mock klndr window, a cursor that clicks the new thing, and a spring zoom onto it. */
export const FeatureSpotlight: React.FC<FeatureSpotlightProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = themeOf(props.theme);

  // Everything has left by the last frame, so the clip loops onto its empty first one.
  const exit = interpolate(frame, [150, 174], [0, 1], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });

  const windowIn = springAt(frame, fps, 0, { damping: 13, stiffness: 110 });
  const travel = interpolate(frame, [20, 60], [0, 1], { ...CLAMP, easing: Easing.bezier(0.3, 0, 0.15, 1) });
  const drift = interpolate(frame, [104, 136], [0, 1], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });
  const press = interpolate(frame, [62, 65, 71], [0, 1, 0], CLAMP);
  const tick = interpolate(frame, [66, 80], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  const burst = interpolate(frame, [65, 88], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  const zoom = springAt(frame, fps, 72, { damping: 16, stiffness: 80 }) * (1 - exit);
  const plateIn = springAt(frame, fps, 84, { damping: 12, stiffness: 120 });
  const tagIn = springAt(frame, fps, 96, { damping: 9, stiffness: 160 });

  const arc = Math.sin(travel * Math.PI) * 70;
  const cursor = {
    x: interpolate(travel, [0, 1], [1260, TARGET.x + 4]) + drift * 70 + arc * 0.4,
    y: interpolate(travel, [0, 1], [720, TARGET.y + 6]) + drift * 60 - arc
  };
  const cursorScale = 1 - press * 0.16;
  const clicked = frame >= 65;
  const headlineSize = props.headline.length > 26 ? 46 : 54;

  return (
    <AbsoluteFill style={{ background: t.ground, overflow: 'hidden' }}>
      <AbsoluteFill style={{ transform: `scale(${1 + 0.24 * zoom})`, transformOrigin: `${TARGET.x}px ${TARGET.y}px` }}>
        <Slab
          fill={t.surface}
          line={t.line}
          slab={SLAB_FLOAT}
          radius={RADIUS.md}
          lineWidth={LINE_CONTAINER}
          style={{
            position: 'absolute',
            left: WINDOW.x,
            top: WINDOW.y,
            width: WINDOW.w,
            height: WINDOW.h,
            opacity: clamp01(windowIn * 1.5) * (1 - exit),
            transform: `translateY(${(1 - windowIn) * 90 + exit * 40}px) scale(${0.92 + 0.08 * windowIn})`
          }}
        >
          <div
            style={{
              height: TOPBAR,
              boxSizing: 'border-box',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '0 24px',
              borderBottom: `${LINE}px solid ${t.line}`
            }}
          >
            <KlndrMark size={40} theme={t} />
            <Wordmark size={34} theme={t} />
            <div style={{ flex: 1 }} />
            <Slab fill={t.tray} line={t.line} slab={0} radius={RADIUS.pill} style={{ padding: '6px 18px' }}>
              <span style={{ fontFamily: FONT, fontWeight: 800, fontSize: 20, color: t.ink }}>This week</span>
            </Slab>
            <Slab fill={props.accent} line={t.line} slab={0} radius={RADIUS.pill} style={{ width: 40, height: 40 }} />
          </div>

          {LANE.map((block, i) => {
            const appear = springAt(frame, fps, 10 + i * 5, { damping: 11, stiffness: 150 });
            const hop = interpolate(frame, [70 + i * 5, 78 + i * 5, 92 + i * 5], [0, -18, 0], CLAMP);
            return (
              <Block
                key={i}
                theme={t}
                label={props.blocks[i] || featureSpotlightDefaults.blocks[i]}
                time={block.time}
                colour={block.colour}
                style={{
                  left: block.x,
                  top: TOPBAR + 28,
                  width: block.w,
                  opacity: clamp01(appear * 1.6),
                  transform: `translateY(${hop}px) scale(${0.7 + 0.3 * Math.min(appear, 1.1)})`
                }}
              />
            );
          })}

          {[360, 260].map((width, i) => (
            <div
              key={width}
              style={{
                position: 'absolute',
                left: 28,
                top: BUTTON.y + 12 + i * 36,
                width,
                height: 20,
                borderRadius: RADIUS.pill,
                background: KlndrMotionCore.alpha(t.ink, 0.08)
              }}
            />
          ))}

          <Slab
            fill={props.accent}
            line={t.line}
            slab={SLAB * (1 - press)}
            radius={RADIUS.sm}
            style={{
              position: 'absolute',
              left: BUTTON.x,
              top: BUTTON.y,
              width: BUTTON.w,
              height: BUTTON.h,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              transform: `translate(${SLAB * press}px, ${SLAB * press}px)`
            }}
          >
            {clicked ? <CheckIcon size={30} color={t.onColorInk} progress={tick} /> : null}
            <span style={{ fontFamily: FONT, fontWeight: 900, fontSize: 28, color: t.onColorInk, whiteSpace: 'nowrap' }}>
              {props.buttonLabel}
            </span>
          </Slab>
        </Slab>

        {burst > 0 && burst < 1 ? (
          <svg
            width={1200}
            height={600}
            style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', opacity: 1 - burst }}
          >
            {Array.from({ length: 10 }, (_, i) => {
              const angle = (i / 10) * Math.PI * 2 + 0.3;
              const inner = 150 + 50 * burst;
              const outer = inner + 46 * (1 - burst);
              return (
                <line
                  key={i}
                  x1={TARGET.x + Math.cos(angle) * inner}
                  y1={TARGET.y + Math.sin(angle) * inner * 0.55}
                  x2={TARGET.x + Math.cos(angle) * outer}
                  y2={TARGET.y + Math.sin(angle) * outer * 0.55}
                  stroke={t.line}
                  strokeWidth={LINE + 1}
                  strokeLinecap="round"
                />
              );
            })}
          </svg>
        ) : null}

        <div
          style={{
            position: 'absolute',
            left: cursor.x,
            top: cursor.y,
            opacity: 1 - exit,
            transform: `scale(${cursorScale})`,
            transformOrigin: '0 0'
          }}
        >
          <Cursor size={44} theme={t} />
        </div>
      </AbsoluteFill>

      <Slab
        fill={t.surface}
        line={t.line}
        slab={SLAB_FLOAT}
        radius={RADIUS.md}
        lineWidth={LINE_CONTAINER}
        style={{
          position: 'absolute',
          left: 60,
          top: 330,
          width: 590,
          padding: '34px 34px 30px',
          opacity: clamp01(plateIn * 2) * (1 - exit),
          transform: `translateY(${(1 - plateIn) * 260 + exit * 300}px) rotate(${(1 - clamp01(plateIn)) * -6}deg)`
        }}
      >
        {props.eyebrow ? (
          <Tag
            label={props.eyebrow}
            fill={props.accent}
            theme={t}
            style={{
              position: 'absolute',
              left: 28,
              top: -28,
              transform: `rotate(-5deg) scale(${tagIn})`,
              transformOrigin: 'left center'
            }}
          />
        ) : null}
        <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: headlineSize, lineHeight: 1.05, color: t.ink }}>
          {props.headline}
        </div>
        {props.subline ? (
          <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 24, lineHeight: 1.3, color: t.inkSoft, marginTop: 12 }}>
            {props.subline}
          </div>
        ) : null}
      </Slab>
    </AbsoluteFill>
  );
};
