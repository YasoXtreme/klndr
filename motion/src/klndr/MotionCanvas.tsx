import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { fontsReady } from './fonts';
import { KlndrMotionCore, KlndrMotionTimeline, KlndrScenes, type MotionScene } from './shared';

type Props = { scene: MotionScene | Record<string, unknown>; theme: unknown };

/**
 * A header's motion drawn with the same timeline and render functions the
 * app's player uses, handed Remotion's frame instead of a clock. Every
 * composition that renders klndr motion - one scene, or a reel of clips - is
 * this canvas.
 */
export const MotionCanvas: React.FC<Props> = ({ scene, theme }) => {
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

  const sceneKey = JSON.stringify(scene);
  const plan = useMemo(() => KlndrMotionTimeline.plan(JSON.parse(sceneKey)), [sceneKey]);
  const themeName = theme === 'dark' ? 'dark' : 'light';
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
    // A run of clips that loops is recorded from its second pass, so the file
    // repeats without a seam; see KlndrMotionTimeline.videoStart.
    const time = KlndrMotionTimeline.videoStart(plan) + frame;
    KlndrMotionTimeline.render(ctx, plan, time, { width: stage.width, height: stage.height, theme: palette });
  }, [frame, width, height, plan, palette, fontEpoch]);

  return (
    <AbsoluteFill>
      <canvas ref={canvas} width={width} height={height} style={{ width, height }} />
    </AbsoluteFill>
  );
};
