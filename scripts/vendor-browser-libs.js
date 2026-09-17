#!/usr/bin/env node
/* Copies the third-party browser libraries klndr serves into protected/vendor.
 *
 * klndr has no bundler, so a library the browser needs is a file on disk. These
 * are installed as devDependencies (so the version is pinned in package.json)
 * and copied out by this script, and the copies are committed: Vercel ships
 * protected/** as-is and never runs a build.
 *
 * Run after changing either version: npm run vendor
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "protected", "vendor");

const LIBS = [
  {
    pkg: "lottie-web",
    file: "build/player/lottie_light.min.js",
    out: "lottie_light.min.js",
    why:
      "Plays Lottie headers. The light build on purpose: SVG renderer only, and no " +
      "expression support, so a Lottie file has no route to eval().",
  },
  {
    pkg: "fflate",
    file: "umd/index.js",
    out: "fflate.min.js",
    why: "Studio only. Unzips .lottie archives so they can be stored as plain Lottie JSON.",
  },
];

fs.mkdirSync(OUT, { recursive: true });

const licences = ["# Vendored browser libraries", ""];

for (const lib of LIBS) {
  const dir = path.join(ROOT, "node_modules", lib.pkg);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const source = fs.readFileSync(path.join(dir, lib.file), "utf8");

  const banner = `/*! ${lib.pkg}@${manifest.version} (${manifest.license}) - copied by scripts/vendor-browser-libs.js. ${lib.why} */\n`;
  fs.writeFileSync(path.join(OUT, lib.out), banner + source);

  const licenceFile = ["LICENSE", "LICENSE.md", "LICENSE.txt"]
    .map((name) => path.join(dir, name))
    .find((candidate) => fs.existsSync(candidate));
  licences.push(`## ${lib.pkg}@${manifest.version} (${manifest.license})`, "");
  licences.push(`Served as \`protected/vendor/${lib.out}\`, from \`${lib.file}\`.`, "");
  if (licenceFile) {
    licences.push("```", fs.readFileSync(licenceFile, "utf8").trim(), "```", "");
  }

  console.log(`vendored ${lib.pkg}@${manifest.version} -> protected/vendor/${lib.out}`);
}

fs.writeFileSync(path.join(OUT, "LICENSES.md"), licences.join("\n"));
