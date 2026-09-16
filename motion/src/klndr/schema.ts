import { z } from 'zod';
import { zColor } from '@remotion/zod-types';
import { KlndrMotionTimeline, KlndrScenes } from './shared';

// A scene's own field list as a Zod schema. That is what gives Remotion Studio
// its props panel - text boxes, switches, lists, and a colour picker for colour
// fields - so a scene can be designed there visually before it is rendered.
//
// Ahead of the scene's fields, how the render plays it: looping (one whole loop
// with `hold` seconds of idle), or once (the way in, then `tail` seconds idle).
export function schemaFor(sceneId: string) {
  const scene = KlndrScenes.get(sceneId);
  if (!scene) throw new Error(`Unknown scene: ${sceneId}`);

  const shape: Record<string, z.ZodType> = {
    theme: z.enum(['light', 'dark']),
    loop: z.boolean(),
    hold: z.number().min(0).max(KlndrMotionTimeline.HOLD_MAX).multipleOf(KlndrMotionTimeline.HOLD_STEP),
    tail: z.number().min(0).max(30)
  };
  for (const field of scene.schema) {
    if (field.type === 'text') shape[field.key] = z.string().max(field.max);
    else if (field.type === 'toggle') shape[field.key] = z.boolean();
    // An optional colour may be empty, meaning "follow the theme".
    else if (field.type === 'color') shape[field.key] = field.optional ? z.string() : zColor();
    else if (field.type === 'list') shape[field.key] = z.array(z.string().max(field.max)).max(field.maxItems);
  }
  return z.object(shape);
}

/** 'block-shuffle' -> 'BlockShuffle'. Remotion composition ids are the render targets. */
export function compositionId(sceneId: string) {
  return sceneId
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
