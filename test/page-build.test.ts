import fs from "node:fs";
import { describe, expect, test } from "vitest";
import {
  PARTIALS,
  checkMarkers,
  inlinePartials,
  partial,
  placeStyles,
} from "../apps/web/build/klndr-page.mts";

// What the build does to each page beyond bundling it: the boot overlay
// written in at its markers, and the page's stylesheet put back where its
// <link> tags were. The built pages themselves are checked in test/build.

const BOTH = ["boot.css", "boot.js"] as const;

const page = (head: string, body = "") =>
  `<!doctype html><html><head>${head}</head><body data-boot="app">${body}</body></html>`;

describe("markers", () => {
  const ok = page("<!-- klndr:boot.css --><!-- klndr:styles -->", "<!-- klndr:boot.js --><main data-boot-brand></main>");

  test("a page with every marker it needs passes", () => {
    expect(() => checkMarkers("app", ok, BOTH)).not.toThrow();
    expect(() => checkMarkers("login", page("<!-- klndr:styles -->"), [])).not.toThrow();
  });

  test("a missing, doubled or unknown marker fails the build", () => {
    expect(() => checkMarkers("app", ok.replace("<!-- klndr:boot.js -->", ""), BOTH)).toThrow(/0 markers for boot\.js/);
    expect(() => checkMarkers("app", ok.replace("<!-- klndr:boot.js -->", "<!-- klndr:boot.js --><!-- klndr:boot.js -->"), BOTH)).toThrow(/2 markers for boot\.js/);
    expect(() => checkMarkers("app", ok.replace("<!-- klndr:styles -->", ""), BOTH)).toThrow(/0 markers for styles/);
    expect(() => checkMarkers("app", `${ok}<!-- klndr:nope -->`, BOTH)).toThrow(/marker for nope, which does not exist/);
    // The login page has no overlay, and may not grow half of one.
    expect(() => checkMarkers("login", page("<!-- klndr:styles --><!-- klndr:boot.css -->"), [])).toThrow(/which it does not load/);
  });
});

describe("partials", () => {
  test("each is inlined in its own tag, exactly as written", () => {
    const html = inlinePartials(page("<!-- klndr:boot.css -->", "<!-- klndr:boot.js -->"), (file) => `/* ${file.endsWith(".css") ? "css" : "js"} */`);
    expect(html).toContain('<style id="kb-css">\n/* css */\n</style>');
    expect(html).toContain('<script id="kb-js">\n/* js */\n</script>');
    expect(html).not.toMatch(/klndr:boot/);
  });

  test("a partial cannot close its own tag early", () => {
    expect(() => partial("boot.js", () => "const a = '</script>';")).toThrow(/would end its inline tag/);
    expect(() => partial("boot.css", () => "/* </STYLE> */")).toThrow(/would end its inline tag/);
    for (const [name, spec] of Object.entries(PARTIALS)) {
      expect(fs.readFileSync(spec.file, "utf8").toLowerCase(), name).not.toContain(spec.close.slice(0, -1));
    }
  });

  test("leaves the styles marker for placeStyles", () => {
    expect(inlinePartials(page("<!-- klndr:styles -->"), () => "")).toContain("<!-- klndr:styles -->");
  });
});

describe("styles", () => {
  const icons = '<link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=X" />';
  const built = (base: string) =>
    page(
      `\n    <!-- klndr:styles -->\n    ${icons}\n` +
        `    <script type="module" crossorigin src="${base}assets/index-a1.js"></script>\n` +
        `    <link rel="stylesheet" crossorigin href="${base}assets/index-b2.css">\n`,
    );

  test("the stylesheet Vite injected moves to the marker, ahead of the icon font's", () => {
    const html = placeStyles("app", built("/protected/"), "/protected/");
    const sheet = html.indexOf('href="/protected/assets/index-b2.css"');
    expect(sheet).toBeGreaterThan(0);
    expect(sheet).toBeLessThan(html.indexOf("fonts.googleapis.com"));
    expect(html).not.toContain("klndr:styles");
    expect(html.match(/rel="stylesheet"/g)).toHaveLength(1);
  });

  test("only this page's own stylesheets move", () => {
    const html = built("/public/") + '<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X" /></noscript>';
    const placed = placeStyles("login", html, "/public/");
    expect(placed).toContain('<noscript><link rel="stylesheet" href="https://fonts.googleapis.com');
  });

  test("a page with no stylesheet fails the build", () => {
    expect(() => placeStyles("app", page("<!-- klndr:styles -->"), "/protected/")).toThrow(/no stylesheet/);
  });
});
