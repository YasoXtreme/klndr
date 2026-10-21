import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

// The pages as the build leaves them in apps/web/dist, which the server sends
// exactly as they are.

const WEB = path.resolve(import.meta.dirname, "..", "..", "apps", "web");
const DIST = path.join(WEB, "dist");

const PAGES = [
  { name: "app", dir: "protected", boot: true },
  { name: "admin", dir: "admin", boot: true },
  { name: "login", dir: "public", boot: false },
];

const html = (dir: string) => fs.readFileSync(path.join(DIST, dir, "index.html"), "utf8");
const countOf = (text: string, needle: string) => text.split(needle).length - 1;
// What the page loads: scripts, stylesheets, preloads, icons, images. Not its
// links to other pages.
const localUrls = (text: string) =>
  [...text.matchAll(/<(?:script|link|img|source)\b[^>]*?\b(?:src|href)="(\/[^"/][^"]*)"/g)].map((m) => m[1] ?? "");

describe.each(PAGES)("the $name page", ({ name, dir, boot }) => {
  const page = html(dir);

  test("has no marker left", () => {
    expect(page).not.toMatch(/<!--\s*klndr:/);
  });

  test("loads one script and one stylesheet, both hashed, from its own assets/", () => {
    const scripts = [...page.matchAll(/<script type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    const sheets = [...page.matchAll(/<link rel="stylesheet"[^>]*href="(\/[^"]+)"/g)].map((m) => m[1]);
    expect(scripts).toEqual([expect.stringMatching(new RegExp(`^/${dir}/assets/index-[\\w-]+\\.js$`))]);
    expect(sheets).toEqual([expect.stringMatching(new RegExp(`^/${dir}/assets/index-[\\w-]+\\.css$`))]);
    expect(page).not.toMatch(/<script src="\/(protected|admin|public)\//);
  });

  test("names only files that exist, or the unhashed /assets", () => {
    for (const url of localUrls(page)) {
      if (url.startsWith("/assets/")) {
        expect(fs.existsSync(path.join(WEB, "static", url)), url).toBe(true);
      } else {
        expect(url.startsWith(`/${dir}/assets/`), `${name}: ${url}`).toBe(true);
        expect(fs.existsSync(path.join(DIST, url)), url).toBe(true);
      }
    }
  });

  test("puts its stylesheet where its links were, relative to the icon font's", () => {
    const ours = page.search(/<link rel="stylesheet"[^>]*href="\//);
    const icons = page.indexOf("fonts.googleapis.com/css2");
    // The app and admin load theirs first; the login page's always came after.
    if (boot) expect(ours).toBeLessThan(icons);
    else expect(ours).toBeGreaterThan(icons);
  });

  test(boot ? "carries the boot overlay exactly once, first in <body>" : "carries no boot overlay", () => {
    expect(countOf(page, '<style id="kb-css">')).toBe(boot ? 1 : 0);
    expect(countOf(page, '<script id="kb-js">')).toBe(boot ? 1 : 0);
    if (!boot) return;
    // Inside <body>, ahead of everything the overlay stands in front of.
    // After </head>: the inlined stylesheet's comments mention <body too.
    const body = page.indexOf("<body", page.indexOf("</head>"));
    const firstElement = page.slice(page.indexOf(">", body) + 1).replace(/<!--[\s\S]*?-->/g, "").trimStart();
    expect(firstElement.startsWith('<script id="kb-js">')).toBe(true);
    // The overlay's styles come before the page's own, which may override them.
    expect(page.indexOf('<style id="kb-css">')).toBeLessThan(page.search(/<link rel="stylesheet"[^>]*href="\//));
    expect(page).toMatch(/data-boot-brand/);
  });

  test("preloads the font at the URL the stylesheet names it by", () => {
    const preload = page.match(/<link[^>]*rel="preload"[^>]*href="([^"]*ElmsSans[^"]*)"/)?.[1];
    const css = fs.readFileSync(path.join(DIST, page.match(/<link rel="stylesheet"[^>]*href="(\/[^"]+)"/)?.[1] ?? ""), "utf8");
    const face = css.match(/url\(['"]?([^'")]+ElmsSans[^'")]*)['"]?\)/)?.[1];
    expect(preload).toBe("/assets/ElmsSans.ttf");
    expect(face).toBe(preload);
  });
});

describe("the login page", () => {
  // It is served to anyone, and its files go on the CDN. Its script's source
  // map lists every file that went into it.
  test("is built from its own files and the theme, nothing else", () => {
    const assets = path.join(DIST, "public", "assets");
    const maps = fs.readdirSync(assets).filter((file) => file.endsWith(".js.map"));
    const sources = maps.flatMap((file) => JSON.parse(fs.readFileSync(path.join(assets, file), "utf8")).sources as string[]);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source, source).toMatch(/(^|\/)src\/(login\/|shared\/theme\.js$)/);
    }
  });
});

describe("the app page", () => {
  test("fetches Lottie and fflate only when they are needed", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(DIST, "protected", ".vite", "manifest.json"), "utf8"));
    const lazy = Object.values(manifest as Record<string, { isDynamicEntry?: boolean; src?: string }>)
      .filter((chunk) => chunk.isDynamicEntry)
      .map((chunk) => chunk.src ?? "");
    expect(lazy.some((src) => src.includes("lottie-web/build/player/lottie_light"))).toBe(true);
    expect(lazy.some((src) => src.includes("fflate"))).toBe(true);
    expect(manifest["index.html"].imports ?? []).toEqual([]);
  });

  // For tabs opened before the move to modules, for one release.
  test("still has the vendor files at their old URLs", () => {
    for (const file of ["lottie_light.min.js", "fflate.min.js"]) {
      expect(fs.existsSync(path.join(DIST, "protected", "vendor", file)), file).toBe(true);
    }
  });
});
