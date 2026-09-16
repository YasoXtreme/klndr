import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { fontsReady } from './fonts';
import { KlndrMotionCore, KlndrMotionTimeline, KlndrScenes } from './shared';

type CanvasProps = { sceneId: string; props: Record<string, unknown> };

// Seconds of idle a render that plays once runs on for, after the scene has
// arrived, unless the composition's props say otherwise.
const DEFAULT_TAIL = 3;

/**
 * A scene composition's props as the app stores a header: one clip, looping or
 * not. `theme` and `tail` belong to the render, not the scene.
 */
function motionOf(sceneId: string, props: Record<string, unknown>) {
  const { theme, loop, hold, tail, ...fields } = props;
  return {
    scene: { loop: loop !== false, clips: [{ id: sceneId, props: fields, hold }] },
    tail: typeof tail === 'number' ? tail : DEFAULT_TAIL,
    theme: theme === 'dark' ? 'dark' : 'light'
  } as const;
}

/** How many frames a scene composition runs with these props: one loop, or the way in and its tail. */
export function sceneLength(sceneId: string, props: Record<string, unknown>) {
  const { scene, tail } = motionOf(sceneId, props);
  return KlndrMotionTimeline.videoLength(KlndrMotionTimeline.plan(scene), tail);
}

/**
 * One klndr motion scene as a Remotion composition: the same timeline and
 * render function the app's player uses, handed Remotion's frame instead of a
 * clock.
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

  const motionKey = JSON.stringify(motionOf(sceneId, props));
  const { plan, themeName } = useMemo(() => {
    const motion = JSON.parse(motionKey) as ReturnType<typeof motionOf>;
    return { plan: KlndrMotionTimeline.plan(motion.scene), themeName: motion.theme };
  }, [motionKey]);
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
    KlndrMotionTimeline.render(ctx, plan, frame, { width: stage.width, height: stage.height, theme: palette });
  }, [frame, width, height, plan, palette, fontEpoch]);

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
 * itself lets you change, plus the theme and how it plays.
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
