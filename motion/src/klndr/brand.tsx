import React from 'react';
import { spring, type SpringConfig } from 'remotion';
import { FONT, KlndrMotionCore, type Theme } from './shared';

// The app's design tokens at stage scale. A 1200-wide clip plays at roughly half
// size in the reader, so every line, slab and radius here is common.css's value
// doubled - which is also what the canvas scenes draw with.
export const LINE = 4; // --line-control
export const LINE_CONTAINER = 5; // --line-container
export const SLAB = 8; // --slab
export const SLAB_FLOAT = 12; // --slab-float
export const RADIUS = { sm: 16, md: 24, lg: 32, pill: 999 };

export const themeOf = (name: unknown): Theme => KlndrMotionCore.readTheme(name === 'dark' ? 'dark' : 'light');

/** A category colour as the theme paints a task block with it. */
export const blockFill = (hex: string, theme: Theme) => KlndrMotionCore.taskFill(hex, theme);

/** A spring that sits at 0 until `delay` frames in. */
export function springAt(frame: number, fps: number, delay: number, config: Partial<SpringConfig> = {}) {
  if (frame < delay) return 0;
  return spring({ frame: frame - delay, fps, config: { damping: 14, stiffness: 120, ...config } });
}

export const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** klndr's one box: a flat fill, a hard line, and the offset slab it casts in that line's colour. */
export const Slab: React.FC<{
  fill: string;
  line: string;
  slab?: number;
  radius?: number;
  lineWidth?: number;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}> = ({ fill, line, slab = SLAB, radius = RADIUS.md, lineWidth = LINE, style, children }) => (
  <div
    style={{
      boxSizing: 'border-box',
      background: fill,
      border: `${lineWidth}px solid ${line}`,
      borderRadius: radius,
      boxShadow: slab ? `${slab}px ${slab}px 0 0 ${line}` : 'none',
      ...style
    }}
  >
    {children}
  </div>
);

/** The eyebrow capsule: NEW, v2.0, TIP. */
export const Tag: React.FC<{ label: string; fill: string; theme: Theme; size?: number; style?: React.CSSProperties }> = ({
  label,
  fill,
  theme,
  size = 28,
  style
}) => (
  <Slab
    fill={fill}
    line={theme.line}
    slab={6}
    radius={RADIUS.pill}
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: `${size * 0.28}px ${size * 0.8}px`,
      fontFamily: FONT,
      fontWeight: 900,
      fontSize: size,
      lineHeight: 1,
      color: theme.onColorInk,
      letterSpacing: '0.02em',
      whiteSpace: 'nowrap',
      ...style
    }}
  >
    {label}
  </Slab>
);

// The lockup badge is theme-invariant on purpose (theme.css, "Brand lockup"): a
// black k, line and slab on every surface. Only the plate moves, to the colour
// of the wordmark beside it in the dark.
const KLNDR_INK = '#000000';

/** The app's lockup badge, drawn inline so the k is set in ElmsSans. */
export const KlndrMark: React.FC<{ size: number; theme: Theme }> = ({ size, theme }) => (
  <svg width={size} height={size} viewBox="0 0 512 512" style={{ display: 'block', overflow: 'visible' }}>
    <rect x="44" y="44" width="458" height="458" rx="74" fill={KLNDR_INK} />
    <rect
      x="10"
      y="10"
      width="458"
      height="458"
      rx="74"
      fill={theme.name === 'dark' ? theme.ink : '#ffffff'}
      stroke={KLNDR_INK}
      strokeWidth="20"
    />
    <text
      x="239"
      y="355"
      fontFamily={FONT}
      fontWeight="900"
      fontSize="324"
      letterSpacing="-19"
      textAnchor="middle"
      fill={KLNDR_INK}
    >
      k
    </text>
  </svg>
);

export const Wordmark: React.FC<{ size: number; theme: Theme }> = ({ size, theme }) => (
  <span
    style={{
      fontFamily: FONT,
      fontWeight: 900,
      fontSize: size,
      lineHeight: 1,
      letterSpacing: '-0.06em',
      color: theme.ink
    }}
  >
    klndr
  </span>
);

export const CheckIcon: React.FC<{ size: number; color: string; progress?: number }> = ({ size, color, progress = 1 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: 'block' }}>
    <path
      d="M5 12.5l4.5 4.5L19 7.5"
      fill="none"
      stroke={color}
      strokeWidth="3.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      pathLength={1}
      strokeDasharray={1}
      strokeDashoffset={1 - clamp01(progress)}
    />
  </svg>
);

/** A pointer, tip at the element's top-left corner. */
export const Cursor: React.FC<{ size: number; theme: Theme }> = ({ size, theme }) => (
  <svg width={size} height={size * 1.4} viewBox="0 0 32 45" style={{ display: 'block', overflow: 'visible' }}>
    <path
      d="M2 2 L2 36 L11 28 L17.5 42 L24 39 L17.5 25.5 L29 25.5 Z"
      fill={theme.ink}
      stroke={theme.surface}
      strokeWidth="3"
      strokeLinejoin="round"
    />
  </svg>
);
