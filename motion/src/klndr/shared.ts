// The motion scenes klndr plays live in the app, used here unchanged - so a clip
// rendered from this workspace matches the in-app scene frame for frame. Edit a
// scene in protected/js/motion/scenes.js and both places change.

export type FieldSchema =
  | { key: string; type: 'text'; label: string; max: number; default: string }
  | { key: string; type: 'toggle'; label: string; default: boolean }
  | { key: string; type: 'color'; label: string; optional?: boolean; default: string }
  | { key: string; type: 'list'; label: string; max: number; maxItems: number; default: string[] };

export type SceneInfo = {
  id: string;
  name: string;
  description: string;
  fps: number;
  durationInFrames: number;
  stillFrame: number;
  schema: FieldSchema[];
  defaults: Record<string, unknown>;
};

export type ThemeName = 'light' | 'dark';

export type Theme = {
  name: ThemeName;
  ground: string;
  surface: string;
  tray: string;
  ink: string;
  inkSoft: string;
  line: string;
  slab: string;
  accent: string;
  accentInk: string;
  mint: string;
  onColorInk: string;
  onColorLine: string;
  taskMix: number;
  taskMixInto: string | null;
};

type ScenesApi = {
  FPS: number;
  list(): SceneInfo[];
  get(id: string): SceneInfo | null;
  sanitizeProps(id: string, props: unknown): Record<string, unknown>;
  describe(id: string, props: unknown): string;
  sizeFor(ratio: number): { width: number; height: number };
  render(
    ctx: CanvasRenderingContext2D,
    id: string,
    frame: number,
    props: Record<string, unknown>,
    env: { width: number; height: number; theme: Theme }
  ): void;
};

type CoreApi = {
  readTheme(name: ThemeName): Theme;
  taskFill(hex: string, theme: Theme): string;
  alpha(hex: string, opacity: number): string;
};

export const KlndrScenes: ScenesApi = require('../../../protected/js/motion/scenes.js');
export const KlndrMotionCore: CoreApi = require('../../../protected/js/motion/motion-core.js');
export const KlndrPalette: { colors: string[] } = require('../../../protected/js/palette.js');

// The app's own face, loaded by ./fonts.ts.
export const FONT = "ElmsSans, -apple-system, 'Segoe UI', Roboto, sans-serif";
