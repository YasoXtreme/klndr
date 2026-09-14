import React from 'react';
import { Composition, Folder } from 'remotion';
import './klndr/fonts';
import { KlndrScenes } from './klndr/shared';
import { sceneComponent } from './klndr/SceneComposition';
import { compositionId, schemaFor } from './klndr/schema';
import { FeatureSpotlight, featureSpotlightDefaults, featureSpotlightSchema } from './clips/FeatureSpotlight';
import { WeekRecap, weekRecapDefaults, weekRecapSchema } from './clips/WeekRecap';

// 1200 wide at 2:1: the announcement header's default shape. Render with
// --scale=2 for a sharper file, or set the height to 675 for 16:9, 400 for 3:1
// or 1200 for a square - the scenes lay themselves out for any of those.
const WIDTH = 1200;
const HEIGHT = 600;

export const RemotionRoot: React.FC = () => (
  <>
    {/* The app's built-in scenes, drawn by the same code klndr plays live. */}
    <Folder name="Scenes">
      {KlndrScenes.list().map((scene) => (
        <Composition
          key={scene.id}
          id={compositionId(scene.id)}
          component={sceneComponent(scene.id)}
          schema={schemaFor(scene.id)}
          defaultProps={{ theme: 'light', ...scene.defaults }}
          durationInFrames={scene.durationInFrames}
          fps={scene.fps}
          width={WIDTH}
          height={HEIGHT}
        />
      ))}
    </Folder>

    {/* Free-form React clips: start from one of these for anything a scene can't do. */}
    <Folder name="Clips">
      <Composition
        id="FeatureSpotlight"
        component={FeatureSpotlight}
        schema={featureSpotlightSchema}
        defaultProps={featureSpotlightDefaults}
        durationInFrames={180}
        fps={30}
        width={WIDTH}
        height={HEIGHT}
      />
      <Composition
        id="WeekRecap"
        component={WeekRecap}
        schema={weekRecapSchema}
        defaultProps={weekRecapDefaults}
        durationInFrames={210}
        fps={30}
        width={WIDTH}
        height={HEIGHT}
      />
    </Folder>
  </>
);
