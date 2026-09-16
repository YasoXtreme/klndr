import React from 'react';
import { MotionCanvas } from './MotionCanvas';
import { KlndrMotionTimeline } from './shared';

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
    theme
  };
}

/** How many frames a scene composition runs with these props: one loop, or the way in and its tail. */
export function sceneLength(sceneId: string, props: Record<string, unknown>) {
  const { scene, tail } = motionOf(sceneId, props);
  return KlndrMotionTimeline.videoLength(KlndrMotionTimeline.plan(scene), tail);
}

const components = new Map<string, React.FC<Record<string, unknown>>>();

/**
 * The composition component for one scene. The scene id is baked in rather
 * than passed as a prop, so Studio's props panel only offers what the scene
 * itself lets you change, plus the theme and how it plays.
 */
export function sceneComponent(sceneId: string): React.FC<Record<string, unknown>> {
  let component = components.get(sceneId);
  if (!component) {
    const Scene: React.FC<Record<string, unknown>> = (props) => {
      const { scene, theme } = motionOf(sceneId, props);
      return <MotionCanvas scene={scene} theme={theme} />;
    };
    Scene.displayName = `KlndrScene(${sceneId})`;
    components.set(sceneId, Scene);
    component = Scene;
  }
  return component;
}
