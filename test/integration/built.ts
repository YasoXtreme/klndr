import fs from "node:fs";
import path from "node:path";

// The files the build wrote for each page, under their hashed names, read from
// the manifest Vite leaves beside them. npm run test:integration builds the
// pages first, so these are the current source's.

const DIST = path.resolve(import.meta.dirname, "..", "..", "apps", "web", "dist");

export type Built = {
  /** The page's script, as a URL: /protected/assets/index-<hash>.js */
  js: string;
  /** The page's stylesheet, as a URL. */
  css: string;
  /** A stretch of the script's own text, to recognise it in a response. */
  sample: string;
};

export function built(dir: "protected" | "admin" | "public"): Built {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, dir, ".vite", "manifest.json"), "utf8"));
  const entry = manifest["index.html"];
  const source = fs.readFileSync(path.join(DIST, dir, entry.file), "utf8");
  return {
    js: `/${dir}/${entry.file}`,
    css: `/${dir}/${entry.css[0]}`,
    sample: source.slice(Math.floor(source.length / 2), Math.floor(source.length / 2) + 200),
  };
}
