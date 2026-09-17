// Remotion CLI settings for the klndr workspace, read by `remotion studio` and
// `remotion render`. Output names and codecs are set in scripts/render.mjs.
import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
