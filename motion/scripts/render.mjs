// npm run render -- <CompositionId> [remotion render flags]
// npm run render:webm -- <CompositionId> [remotion render flags]
//
// Writes out/<CompositionId>.mp4 (H.264) or out/<CompositionId>.webm (VP9).
// Props can come from a JSON file, merged over the composition's defaults:
//   npm run render -- PopReveal --props=props/dark.json
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(workspace, 'node_modules', '@remotion', 'cli', 'remotion-cli.js');

const args = process.argv.slice(2);
const webm = args.includes('--webm');
const [id, ...flags] = args.filter((arg) => arg !== '--webm');

if (!id || id.startsWith('-')) {
  console.log('Usage: npm run render -- <CompositionId> [--props=props/dark.json] [--scale=2]');
  console.log('The composition ids are listed in Remotion Studio (npm run studio).');
  process.exit(1);
}

const output = `out/${id}.${webm ? 'webm' : 'mp4'}`;
const codec = webm ? ['--codec=vp9'] : ['--codec=h264', '--crf=23'];

// Node runs the CLI directly: no shell in between to mangle arguments on Windows.
const result = spawnSync(process.execPath, [cli, 'render', 'src/index.ts', id, output, ...codec, ...flags], {
  cwd: workspace,
  stdio: 'inherit'
});

if (result.status === 0) {
  console.log(`\nRendered motion/${output}. Upload it as the header in the announcement studio (/announcements).`);
}
process.exit(result.status ?? 1);
