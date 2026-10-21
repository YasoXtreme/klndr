import { expect, test, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { clearTasks, openBoard, seedTask, setPreferences, signIn, tomorrowAt } from "../support/board";

// docs/mobile-regression-checklist.md: the geometry self-check, day count and
// navigation, accessibility, and the phone layout's shape.

async function boardIn(browser: Browser, options: BrowserContextOptions, prefs: Parameters<typeof setPreferences>[1] = {}) {
  const context = await browser.newContext({ reducedMotion: "reduce", ...options });
  await signIn(context);
  await clearTasks(context);
  await setPreferences(context, prefs);
  const page = await context.newPage();
  return { context, page };
}

const PHONE: BrowserContextOptions = {
  viewport: { width: 412, height: 915 },
  screen: { width: 412, height: 915 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2.625,
};

const dayCount = (page: Page) => page.evaluate(() => (window.klndr as unknown as { dayCount: number }).dayCount);
const dayOffset = (page: Page) => page.evaluate(() => (window.klndr as unknown as { dayOffset: number }).dayOffset);

test.describe("geometry", () => {
  // The renderer checks its own rects against the reference formulas on every
  // resize, horizontal only, and prints the verdict.
  for (const days of [1, 3, 5, 7]) {
    test(`the self-check passes at ${days} day${days > 1 ? "s" : ""}`, async ({ browser }) => {
      const { context, page } = await boardIn(browser, { viewport: { width: 1440, height: 900 } }, { orientation: "horizontal", dayCount: days });
      const logs: string[] = [];
      page.on("console", (message) => logs.push(message.text()));
      await openBoard(page, "/?debug=geom");
      expect(await dayCount(page)).toBe(days);
      await expect.poll(() => logs.some((line) => line.startsWith("[klndr geom] ok:"))).toBe(true);
      expect(logs.filter((line) => line.startsWith("[klndr geom]") && !line.startsWith("[klndr geom] ok:"))).toEqual([]);
      await context.close();
    });
  }
});

test.describe("day count and navigation", () => {
  test("with nothing stored a phone opens at 3 days and a desktop at 7", async ({ browser }) => {
    const phone = await boardIn(browser, PHONE);
    await openBoard(phone.page);
    expect(await dayCount(phone.page)).toBe(3);
    await phone.context.close();

    const desktop = await boardIn(browser, { viewport: { width: 1440, height: 900 }, screen: { width: 1440, height: 900 } });
    await openBoard(desktop.page);
    expect(await dayCount(desktop.page)).toBe(7);
    await desktop.context.close();
  });

  test("the phone's day-count buttons switch the view, and the choice survives a reload", async ({ browser }) => {
    const { context, page } = await boardIn(browser, PHONE);
    await openBoard(page);
    // Shown in the header only when the calendar is vertical on a phone.
    const one = page.locator('.day-count-btn[data-days="1"]');
    await expect(one).toBeVisible();
    await one.click();
    await expect.poll(() => dayCount(page)).toBe(1);
    await expect(one).toHaveAttribute("aria-pressed", "true");
    await openBoard(page);
    expect(await dayCount(page)).toBe(1);
    await context.close();
  });

  test("the arrows step one view at a time and stop at four weeks either side", async ({ browser }) => {
    const { context, page } = await boardIn(browser, { viewport: { width: 1440, height: 900 } }, { dayCount: 7 });
    await openBoard(page);
    const next = page.locator("#btnNextWeek");
    const prev = page.locator("#btnPrevWeek");
    for (let step = 1; step <= 4; step++) {
      await next.click();
      await expect.poll(() => dayOffset(page)).toBe(step * 7);
    }
    await expect(next).toBeDisabled();
    await page.locator("#btnTodayWeek").click();
    await expect.poll(() => dayOffset(page)).toBe(0);
    for (let step = 1; step <= 4; step++) await prev.click();
    await expect.poll(() => dayOffset(page)).toBe(-28);
    await expect(prev).toBeDisabled();
    await context.close();
  });

  test("navigating fetches the blocks of the range it lands on", async ({ browser }) => {
    const { context, page } = await boardIn(browser, { viewport: { width: 1440, height: 900 } }, { dayCount: 7 });
    // The week view is aligned to the start of a week, so "next week" is read
    // off the board: two days after its last day is in the next view only.
    await openBoard(page);
    const lastDay = await page.evaluate(() => {
      const days = (window.klndr as unknown as { days: Array<{ date: Date }> }).days;
      return days[days.length - 1]!.date.getTime();
    });
    const later = new Date(lastDay);
    later.setDate(later.getDate() + 2);
    later.setHours(11, 0, 0, 0);
    const id = await seedTask(context, "Next week", [[Math.floor(later.getTime() / 1000), 60]]);
    await openBoard(page);
    // The model, not the DOM: the overlay only draws blocks near what is on
    // screen, so a missing card proves nothing about what was fetched.
    const loaded = () => page.evaluate((taskId) => Boolean(window.klndr?.tasks.some((t) => t.id === taskId)), id);
    expect(await loaded()).toBe(false);
    await page.locator("#btnNextWeek").click();
    await expect.poll(loaded).toBe(true);
    await page.locator("#btnPrevWeek").click();
    await expect.poll(loaded).toBe(false);
    await context.close();
  });
});

test.describe("phone layout", () => {
  test("one pane at a time, switched from the tab bar, and the task list is flat", async ({ browser }) => {
    const { context, page } = await boardIn(browser, PHONE);
    await seedTask(context, "On the list", []);
    await openBoard(page);
    await expect(page.locator("#mobileTabbar")).toBeVisible();
    await page.locator("#mobileTabTasks").click();
    await expect(page.locator(".sidebar-task-card", { hasText: "On the list" })).toBeVisible();
    // Never the 280px kanban columns.
    await expect(page.locator(".tasks-multicolumn-container")).toBeHidden();
    await page.locator("#mobileTabCalendar").click();
    await expect(page.locator("#timelineViewport")).toBeVisible();
    await context.close();
  });

  test("the calendar opens at the current hour, not at midnight", async ({ browser }) => {
    const { context, page } = await boardIn(browser, PHONE);
    await openBoard(page);
    // Vertical on a phone: time runs down, and "now" sits about a third of the
    // way into the viewport rather than below the fold.
    const seen = await page.evaluate(() => {
      const scroller = document.getElementById("timeline-workspace")!;
      const now = new Date();
      return { scrollTop: scroller.scrollTop, minutes: now.getHours() * 60 + now.getMinutes() };
    });
    if (seen.minutes > 120) expect(seen.scrollTop).toBeGreaterThan(0);
    await context.close();
  });
});

test.describe("accessibility", () => {
  // With reduced motion, a sheet arrives without animating: nothing may be
  // running except kb-bailout, which is a 0s timeout rather than motion.
  test("reduced motion stops the sheets and menus from animating", async ({ browser }) => {
    const { context, page } = await boardIn(browser, PHONE);
    await openBoard(page);
    const moving = () =>
      page.evaluate(() =>
        document
          .getAnimations()
          .filter((animation) => animation.playState === "running")
          .filter((animation) => {
            const name = (animation as CSSAnimation).animationName;
            if (name === "kb-bailout") return false;
            const timing = animation.effect?.getComputedTiming();
            return Boolean(timing && Number(timing.duration) > 0);
          })
          .map((animation) => (animation as CSSAnimation).animationName || animation.constructor.name),
      );
    await page.locator("#userProfileTrigger").click();
    expect(await moving()).toEqual([]);
    await page.locator("#userMenuOptions").click();
    await expect(page.locator("#settingsModal")).toBeVisible();
    expect(await moving()).toEqual([]);
    await context.close();
  });

  // Touch targets: a press anywhere in a 44px-tall area around the control's
  // centre lands on it. Measured by hit-testing rather than by box, because some
  // controls grow their hit area past their visual bounds. 40px across, not 44:
  // the header's arrow, zoom and Today buttons are 40px wide by the stylesheet's
  // own rule (responsive.css, TOUCH TARGETS).
  test("touch targets reach 44px tall and 40px wide", async ({ browser }) => {
    const { context, page } = await boardIn(browser, PHONE);
    await openBoard(page);
    // Until the icon font arrives, an icon is its ligature's text ("filter_list"),
    // wide enough to spill over the button beside it.
    await iconFontLoaded(page);
    const short = await shortTargets(page, ["#btnPrevWeek", "#btnNextWeek", "#btnTodayWeek", ".day-count-btn"]);
    await page.locator("#mobileTabTasks").click();
    short.push(...(await shortTargets(page, ["#sidebarSearchBtn", "#sidebarFilterBtn"])));
    await page.locator("#userProfileTrigger").click();
    await page.locator("#userMenuOptions").click();
    short.push(...(await shortTargets(page, ["#settingsModal .modal-close-btn"])));
    expect(short).toEqual([]);
    await context.close();
  });

  // Known failure, kept failing on purpose: on a touch tablet in portrait the
  // week view's header does not fit its pane. The date label wraps to four
  // lines, Fit is cut off, and zoom-in and Calendar Options sit under the tasks
  // sidebar where no tap reaches them. The checklist expects one header row.
  // When the layout is fixed this test passes, Playwright reports it as an
  // unexpected pass, and this test.fail() line comes out.
  test("a touch tablet's calendar header fits its pane", async ({ browser }) => {
    test.fail();
    const tablet = await boardIn(browser, {
      viewport: { width: 768, height: 1024 },
      screen: { width: 768, height: 1024 },
      isMobile: true,
      hasTouch: true,
    });
    await openBoard(tablet.page);
    // No wait for the icon font here: the overlap doesn't depend on it, and an
    // expected failure must only ever fail on the thing it documents.
    expect(await shortTargets(tablet.page, ["#btnZoomOut", "#btnZoomFit", "#btnZoomIn", "#btnCalendarSliders"])).toEqual([]);
    await tablet.context.close();
  });
});

async function iconFontLoaded(page: Page) {
  await page.waitForFunction(() => document.fonts.check('24px "Material Symbols Outlined"'), null, { timeout: 20_000 });
}

/**
 * The controls a press 44px tall and 40px wide around their centre would miss,
 * with what it would land on instead.
 */
async function shortTargets(page: Page, selectors: string[]) {
  const short: string[] = [];
  for (const selector of selectors) {
    const target = page.locator(selector).first();
    await expect(target, selector).toBeVisible();
    const misses = await target.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      // A pixel inside each edge: layout lands on fractional pixels, and a
      // sample exactly on a boundary can go either way.
      const across = 19;
      const down = 21;
      return [[cx - across, cy], [cx + across, cy], [cx, cy - down], [cx, cy + down]].flatMap(([x, y]) => {
        const hit = document.elementFromPoint(x!, y!);
        if (hit && (hit === el || el.contains(hit))) return [];
        return [`(${Math.round(x! - cx)},${Math.round(y! - cy)}) lands on ${hit?.tagName.toLowerCase()}.${String(hit?.className).split(" ")[0]}`];
      });
    });
    if (misses.length) short.push(`${selector}: ${misses.join("; ")}`);
  }
  return short;
}

test("a block opens tomorrow without a console error", async ({ browser }) => {
  // A canary for the suite itself: seeding, signing in and opening the board
  // all work on a touch-first device.
  const { context, page } = await boardIn(browser, PHONE);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const id = await seedTask(context, "Tomorrow", [[tomorrowAt(9), 60]]);
  await openBoard(page);
  await expect(page.locator(`.timeline-task-card[data-task-id="${id}"]`)).toHaveCount(1);
  expect(errors).toEqual([]);
  await context.close();
});
