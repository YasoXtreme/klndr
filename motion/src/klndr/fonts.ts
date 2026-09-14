import { loadFont } from '@remotion/fonts';
import { staticFile } from 'remotion';

// ElmsSans, copied into public/klndr/ by scripts/sync-assets.mjs from the app's
// own public/assets, so the type in a rendered clip sets exactly as it does in
// klndr. loadFont holds rendering until the face has arrived.
export const fontsReady = loadFont({
  family: 'ElmsSans',
  url: staticFile('klndr/ElmsSans.ttf'),
  weight: '100 900'
});
