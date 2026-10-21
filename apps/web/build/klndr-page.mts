import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

// What the build does to each page beyond bundling it, at the page's
// `<!-- klndr:NAME -->` markers.
//
// The boot overlay's stylesheet and script are written into the page rather
// than linked, because they draw the loading screen: linked, they would be one
// more request between the page arriving and anything being on it. They are
// kept as files of their own so they can be read, linted and tested like any
// other. This used to happen on every request, in the server; now the page
// leaves the build finished.
//
// The page's own stylesheet goes where its <link> tags used to be. Vite would
// put it at the end of <head>, after the icon font's stylesheet, and that one
// also styles .material-symbols-outlined: whichever sheet comes later wins at
// equal specificity, so moving ours would change how icons are drawn.

const SRC = path.join(import.meta.dirname, "..", "src");

export type PartialName = "boot.css" | "boot.js";

export const PARTIALS: Record<PartialName, { file: string; open: string; close: string }> = {
  "boot.css": { file: path.join(SRC, "shared", "boot.css"), open: '<style id="kb-css">', close: "</style>" },
  "boot.js": { file: path.join(SRC, "shared", "boot.js"), open: '<script id="kb-js">', close: "</script>" },
};

const MARKER = /<!--\s*klndr:([\w.-]+)\s*-->/g;
const STYLES = "styles";

const isPartial = (name: string): name is PartialName => Object.hasOwn(PARTIALS, name);

/** The markers a page carries, in order. */
export function markersIn(html: string): string[] {
  return [...html.matchAll(MARKER)].map((match) => match[1] ?? "");
}

/**
 * Checks a page's markers: each one names something that exists, the page
 * carries every partial it needs exactly once, and one place for its styles.
 * A marker that went missing would otherwise fail silently: the page would
 * simply lose its loading screen.
 */
export function checkMarkers(page: string, html: string, partials: readonly PartialName[]): void {
  const found = markersIn(html);
  for (const marker of found) {
    if (marker !== STYLES && !isPartial(marker)) throw new Error(`${page} has a marker for ${marker}, which does not exist`);
  }
  for (const wanted of [STYLES, ...partials]) {
    const count = found.filter((marker) => marker === wanted).length;
    if (count !== 1) throw new Error(`${page} carries ${count} markers for ${wanted}, not one`);
  }
  for (const marker of found) {
    if (marker !== STYLES && !partials.includes(marker as PartialName)) {
      throw new Error(`${page} has a marker for ${marker}, which it does not load`);
    }
  }
}

/** One partial, wrapped in the tag it is inlined as. */
export function partial(name: PartialName, read: (file: string) => string = (file) => fs.readFileSync(file, "utf8")): string {
  const spec = PARTIALS[name];
  const src = read(spec.file);
  // The one sequence that would end the tag early and spill the rest of the
  // partial into the page as markup.
  const closing = spec.close.slice(0, -1);
  if (src.toLowerCase().includes(closing)) {
    throw new Error(`${name} contains ${closing}, which would end its inline tag`);
  }
  return `${spec.open}\n${src}\n${spec.close}`;
}

/**
 * Moves the stylesheet links Vite injected (the ones under this page's
 * assets/) to the styles marker, in the order Vite wrote them.
 */
export function placeStyles(page: string, html: string, base: string): string {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const injected = new RegExp(`[ \\t]*<link rel="stylesheet"[^>]*href="${escaped}assets/[^"]+\\.css"[^>]*>\\n?`, "g");
  const links = (html.match(injected) ?? []).map((link) => link.trim());
  if (links.length === 0) throw new Error(`${page} has no stylesheet to place`);
  return html
    .replace(injected, "")
    .replace(/([ \t]*)<!--\s*klndr:styles\s*-->/, (match, indent: string) => links.map((link) => indent + link).join("\n"));
}

/** Writes each partial in at its marker. */
export function inlinePartials(html: string, read?: (file: string) => string): string {
  return html.replace(MARKER, (match, name: string) => (isPartial(name) ? partial(name, read) : match));
}

export function klndrPage({ page, partials }: { page: string; partials: readonly PartialName[] }): Plugin {
  let base = "/";
  return {
    name: "klndr-page",
    configResolved(config) {
      base = config.base;
    },
    buildStart() {
      // So a watching build rebuilds the page when the overlay changes.
      for (const name of partials) this.addWatchFile(PARTIALS[name].file);
    },
    transformIndexHtml: {
      // After Vite has written its own tags in, so they can be moved, and so
      // nothing inside a partial is ever rewritten.
      order: "post",
      handler(html) {
        checkMarkers(page, html, partials);
        return inlinePartials(placeStyles(page, html, base));
      },
    },
  };
}
