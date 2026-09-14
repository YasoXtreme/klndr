// Copies what the clips borrow from the app into public/klndr/, where Remotion's
// staticFile() finds it. Copies rather than paths out of the workspace, because
// Remotion only serves what is inside public/. public/klndr/ is git-ignored and
// rebuilt before every studio and render run; put your own assets beside it.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const into = join(here, '..', 'public', 'klndr');

// The klndr mark is drawn inline (src/klndr/brand.tsx) rather than copied from
// brand/svg: an SVG loaded as an image cannot reach ElmsSans, nor follow the theme.
const ASSETS = [['public/assets/ElmsSans.ttf', 'ElmsSans.ttf']];

mkdirSync(into, { recursive: true });
for (const [from, to] of ASSETS) {
  copyFileSync(join(repo, from), join(into, to));
}
console.log(`Synced ${ASSETS.length} klndr assets into motion/public/klndr`);
