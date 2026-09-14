import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { fontsReady } from './fonts';
import { KlndrMotionCore, KlndrScenes } from './shared';

type CanvasProps = { sceneId: string; props: Record<string, unknown> };

/**
 * One klndr motion scene as a Remotion composition: the same render function
 * the app's player calls, handed Remotion's frame instead of a clock.
 */
const SceneCanvas: React.FC<CanvasProps> = ({ sceneId, props }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const canvas = useRef<HTMLCanvasElement>(null);

  // Studio can paint before ElmsSans has arrived; draw again once it has. A
  // render waits for the font on its own (loadFont holds it back).
  const [fontEpoch, setFontEpoch] = useState(0);
  useEffect(() => {
    let live = true;
    const redraw = () => live && setFontEpoch(1);
    fontsReady.then(redraw, redraw);
    return () => {
      live = false;
    };
  }, []);

  const { theme, ...fields } = props;
  const themeName = theme === 'dark' ? 'dark' : 'light';
  const fieldsKey = JSON.stringify(fields);
  const clean = useMemo(
    () => KlndrScenes.sanitizeProps(sceneId, JSON.parse(fieldsKey)),
    [sceneId, fieldsKey]
  );
  const palette = useMemo(() => KlndrMotionCore.readTheme(themeName), [themeName]);

  // Drawn during layout, before Remotion captures the frame. A canvas painted in
  // a later effect could be captured blank.
  useLayoutEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    const stage = KlndrScenes.sizeFor(width / height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.setTransform(width / stage.width, 0, 0, height / stage.height, 0, 0);
    KlndrScenes.render(ctx, sceneId, frame, clean, { width: stage.width, height: stage.height, theme: palette });
  }, [frame, width, height, sceneId, clean, palette, fontEpoch]);

  return (
    <AbsoluteFill>
      <canvas ref={canvas} width={width} height={height} style={{ width, height }} />
    </AbsoluteFill>
  );
};

const components = new Map<string, React.FC<Record<string, unknown>>>();

/**
 * The composition component for one scene. The scene id is baked in rather
 * than passed as a prop, so Studio's props panel only offers what the scene
 * itself lets you change, plus the theme.
 */
export function sceneComponent(sceneId: string): React.FC<Record<string, unknown>> {
  let component = components.get(sceneId);
  if (!component) {
    const Scene: React.FC<Record<string, unknown>> = (props) => <SceneCanvas sceneId={sceneId} props={props} />;
    Scene.displayName = `KlndrScene(${sceneId})`;
    components.set(sceneId, Scene);
    component = Scene;
  }
  return component;
}
