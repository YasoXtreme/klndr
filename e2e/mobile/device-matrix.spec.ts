import { expect, test } from "@playwright/test";
import { clearTasks, openBoard, signIn } from "../support/board";

// docs/mobile-regression-checklist.md, "Device matrix". Each size is a fresh
// context and a fresh load: several rules only take effect at boot, and
// resizing a loaded page does not re-evaluate media queries reliably.

type Expect = { layout: "phone" | "tablet" | "desktop"; orientation: "horizontal" | "vertical"; touch: boolean };

const MATRIX: Array<[string, number, number, Expect]> = [
  ["iPhone SE", 375, 667, { layout: "phone", orientation: "vertical", touch: true }],
  ["iPhone 14 Pro", 393, 852, { layout: "phone", orientation: "vertical", touch: true }],
  ["Pixel 7", 412, 915, { layout: "phone", orientation: "vertical", touch: true }],
  ["Phone landscape", 844, 390, { layout: "phone", orientation: "horizontal", touch: true }],
  ["iPad Mini portrait", 768, 1024, { layout: "tablet", orientation: "vertical", touch: true }],
  ["iPad Mini landscape", 1024, 768, { layout: "desktop", orientation: "horizontal", touch: true }],
  ["Desktop", 1440, 900, { layout: "desktop", orientation: "horizontal", touch: false }],
  // The pane that used to render at 0px.
  ["Narrow desktop", 900, 700, { layout: "tablet", orientation: "horizontal", touch: false }],
];

for (const [name, width, height, want] of MATRIX) {
  test(`${name} (${width}x${height}) is ${want.layout}, ${want.orientation}, ${want.touch ? "touch" : "mouse"}`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width, height },
      screen: { width, height },
      isMobile: want.touch && width < 1024,
      hasTouch: want.touch,
      deviceScaleFactor: want.touch ? 2 : 1,
      reducedMotion: "reduce",
    });
    await signIn(context);
    await clearTasks(context);
    const page = await context.newPage();
    await openBoard(page);

    const body = await page.evaluate(() => ({ ...document.body.dataset }));
    expect(body.layout).toBe(want.layout);
    expect(body.orientation).toBe(want.orientation);
    expect(body.input).toBe(want.touch ? "touch" : "mouse");

    const pane = await page.locator("#calendarPane").boundingBox();
    expect(pane?.width ?? 0).toBeGreaterThan(0);

    // Phone: one pane at a time, switched from the tab bar. Anywhere else both
    // panes are on screen and the tab bar is not.
    const tabbar = page.locator("#mobileTabbar");
    if (want.layout === "phone") await expect(tabbar).toBeVisible();
    else await expect(tabbar).toBeHidden();

    await context.close();
  });
}
