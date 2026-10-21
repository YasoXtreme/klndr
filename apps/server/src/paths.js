const path = require("path");

// Where the files the server hands out live: apps/web/dist, the three built
// pages and their files, and apps/web/static, what is served as it is.
//
// From the repo, apps/web is two levels up from this file. In the Vercel
// bundle (scripts/build-vercel-output.mjs) every module shares the bundle
// file's own __dirname, and the build copies dist and static into web/ beside
// it. The build defines KLNDR_BUNDLED; nothing else sets it.
const WEB = process.env.KLNDR_BUNDLED
  ? path.join(__dirname, "web")
  : path.join(__dirname, "..", "..", "web");

const DIST = path.join(WEB, "dist");
const STATIC = path.join(WEB, "static");

module.exports = { DIST, STATIC };
