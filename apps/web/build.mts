// Builds the three pages into dist/: `npm run build:web`, or with --watch to
// rebuild each one as its files change (`npm run dev` does that).
import { build } from "vite";
import { PAGES, pageConfig } from "./vite.pages.mts";

const watch = process.argv.includes("--watch");

for (const page of PAGES) {
  await build(pageConfig(page, { watch }));
  if (!watch) console.log(`built ${page.name} into dist/${page.out}`);
}
