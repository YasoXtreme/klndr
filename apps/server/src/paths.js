const path = require("path");

// Where the files the server hands out (public/, protected/, admin/) live.
//
// From the repo, that is the root: one level up from server/. In the Vercel
// bundle (scripts/build-vercel-output.mjs) every module shares the bundle
// file's own __dirname, and the build copies those three directories beside
// it, so the root is that directory itself. The build defines KLNDR_BUNDLED;
// nothing else sets it.
const ROOT = process.env.KLNDR_BUNDLED ? __dirname : path.join(__dirname, "..");

module.exports = { ROOT };
