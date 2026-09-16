import React from 'react';
import { z } from 'zod';
import { MotionCanvas } from './MotionCanvas';
import { KlndrMotionTimeline, KlndrScenes } from './shared';

// A header's whole motion - several clips, each its own scene - as one video.
// Its props are exactly what the announcement studio stores, so the Studio's
// "Copy for Remotion" pastes straight in:
//
//   npm run render -- Reel --props=props/my-reel.json

const sceneIds = KlndrScenes.list().map((scene) => scene.id) as [string, ...string[]];

export const reelSchema = z.object({
  theme: z.enum(['light', 'dark']),
  tail: z.number().min(0).max(30),
  scene: z.object({
    loop: z.boolean(),
    clips: z
      .array(
        z.object({
          id: z.enum(sceneIds),
          props: z.record(z.string(), z.unknown()),
          hold: z.number().min(0).max(KlndrMotionTimeline.HOLD_MAX).multipleOf(KlndrMotionTimeline.HOLD_STEP)
        })
      )
      .min(1)
      .max(KlndrMotionTimeline.MAX_CLIPS)
  })
});

export type ReelProps = z.infer<typeof reelSchema>;

export const reelDefaults: ReelProps = {
  theme: 'light',
  tail: 3,
  scene: {
    loop: true,
    clips: [
      { id: 'stamp', props: { label: 'NEW', sublabel: 'Fresh in klndr' }, hold: 1.5 },
      { id: 'checklist', props: {}, hold: 2 },
      { id: 'ticker', props: {}, hold: 2 }
    ]
  }
};

/** Frames the reel runs: one loop, or the way in to its last clip plus the tail. */
export function reelLength(props: ReelProps) {
  return KlndrMotionTimeline.videoLength(KlndrMotionTimeline.plan(props.scene), props.tail);
}

export const Reel: React.FC<ReelProps> = ({ scene, theme }) => <MotionCanvas scene={scene} theme={theme} />;
