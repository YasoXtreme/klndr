import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { E2E_ADMIN, E2E_USER } from "./fixtures/users";

// The shortest walk that proves the app still starts, draws, schedules and
// undoes, and that admin still loads in order. Everything finer is in
// e2e/mobile and the integration suite.

type Account = { username: string; password: string };

// Console noise that predates these tests and is not a regression (see
// docs/mobile-regression-checklist.md): a sync against an integration that
// isn't configured, and the 400 it logs.
const KNOWN_NOISE = [/Failed to load resource: the server responded with a status of 400/, /Background sync failed/];

// The icon font comes from Google Fonts. A network that drops one of those
// requests is not something the app did.
const THIRD_PARTY = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

function watchConsole(page: Page) {
  const problems: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (KNOWN_NOISE.some((pattern) => pattern.test(text))) return;
    if (text.startsWith("Failed to load resource") && THIRD_PARTY.test(message.location().url)) return;
    problems.push(text);
  });
  page.on("pageerror", (error) => problems.push(`${error.name}: ${error.message}`));
  return problems;
}

async function bootFinished(page: Page) {
  await expect(page.locator("#klndrBoot")).toHaveCount(0);
}

async function signIn(page: Page, account: Account) {
  await page.goto("/login");
  await page.locator("#usernameInput").fill(account.username);
  await page.locator("#passwordInput").fill(account.password);
  await page.locator("#submitBtn").click();
  await page.waitForURL((url) => url.pathname === "/");
  await bootFinished(page);
  await page.waitForFunction(() => Boolean(window.klndr && Array.isArray(window.klndr.tasks)));
}

test("signing in lands on a board that starts cleanly", async ({ page, isMobile }) => {
  const problems = watchConsole(page);
  await signIn(page, E2E_USER);
  if (!isMobile) await expect(page.locator("#timelineViewport")).toBeVisible();
  const layout = await page.evaluate(() => document.body.dataset.layout);
  expect(layout).toBe(isMobile ? "phone" : "desktop");
  expect(problems).toEqual([]);
});

test("the timeline geometry checks itself", async ({ page, isMobile }) => {
  // verifyGeometry() only covers the horizontal timeline, which a phone
  // never uses.
  test.skip(isMobile, "horizontal timeline only");
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  await signIn(page, E2E_USER);
  await page.goto("/?debug=geom");
  await bootFinished(page);
  await expect.poll(() => logs.some((line) => line.startsWith("[klndr geom] ok:"))).toBe(true);
  expect(logs.filter((line) => line.startsWith("[klndr geom]") && !line.startsWith("[klndr geom] ok:"))).toEqual([]);
});

test("a new task can be dragged onto the calendar and the drop undone", async ({ page, isMobile }) => {
  // Touch drags (long press, then move) are covered by e2e/mobile.
  test.skip(isMobile, "mouse drag");
  const problems = watchConsole(page);
  await signIn(page, E2E_USER);

  const title = `Smoke task ${Date.now()}`;
  await page.locator("#inlineTaskInput").fill(title);
  await page.locator("#inlineTaskInput").press("Enter");
  const card = page.locator(".sidebar-task-card", { hasText: title });
  await expect(card).toBeVisible();
  const taskId = await card.getAttribute("data-task-id");
  expect(taskId).toBeTruthy();

  const segmentsOf = () =>
    page.evaluate((id) => {
      const task = window.klndr?.tasks.find((t: { id: string }) => t.id === id);
      return task ? (task.segments || []).length : -1;
    }, taskId);
  expect(await segmentsOf()).toBe(0);

  const from = (await card.boundingBox())!;
  const to = (await page.locator("#timelineViewport").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // Past the 4px threshold first, so the press becomes a drag.
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
  await page.mouse.up();
  await expect.poll(segmentsOf).toBe(1);

  // Undo never steals from a text field, and the new task's input still has focus.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(segmentsOf).toBe(0);
  expect(problems).toEqual([]);
});

test("admin loads its sections in order, and the logo carries you there and back", async ({ page, isMobile }) => {
  test.skip(isMobile, "the account menu is reached differently on a phone");
  const problems = watchConsole(page);
  await signIn(page, E2E_ADMIN);

  await page.locator("#userProfileTrigger").click();
  await page.locator("#userMenuAdmin").click();
  await page.waitForURL((url) => url.pathname.startsWith("/admin"));
  await bootFinished(page);
  // Registration order is script order (admin/index.html); after the move to
  // modules it becomes import order, and this is what pins it.
  await expect(page.locator(".adm-nav-list > .adm-nav-group > .adm-nav-link > span:last-child")).toHaveText([
    "Analytics",
    "Announcements",
    "Accounts",
  ]);

  await page.locator('a.adm-nav-link[href="/"]').click();
  await page.waitForURL((url) => url.pathname === "/");
  await bootFinished(page);
  await page.waitForFunction(() => Boolean(window.klndr));
  expect(problems).toEqual([]);
});
