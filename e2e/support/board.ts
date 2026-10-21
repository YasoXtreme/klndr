import { expect, type BrowserContext, type CDPSession, type Locator, type Page } from "@playwright/test";
import { E2E_USER } from "../fixtures/users";

// What the checklist suite (e2e/mobile) needs to put a board in a known state
// and to drive it the way a mouse and a finger would.

export type Orientation = "horizontal" | "vertical";
export type Input = "mouse" | "touch";
export type Segment = { id: string; start_time: number; duration: number; completed: boolean };
export type Task = { id: string; title: string; segments: Segment[] };
type Account = { username: string; password: string };
type Point = { x: number; y: number };

const MINUTE = 60;

/** Signs the context in through the API: the login page has its own tests. */
export async function signIn(context: BrowserContext, account: Account = E2E_USER) {
  const res = await context.request.post("/api/auth/login", {
    data: { username: account.username, password: account.password },
  });
  expect(res.ok(), `sign in as ${account.username}`).toBe(true);
}

export async function clearTasks(context: BrowserContext) {
  const res = await context.request.get("/api/tasks");
  const { tasks } = (await res.json()) as { tasks: Array<{ id: string }> };
  for (const task of tasks) await context.request.delete(`/api/tasks/${task.id}`);
}

let counter = 0;
const id = (prefix: string) => `${prefix}_e2e${Date.now().toString(36)}${(counter++).toString(36)}`;

/**
 * A task with one block per [start, minutes] pair, or none (unscheduled).
 * Segments are sent with their ids so the board and the test agree on them.
 */
export async function seedTask(context: BrowserContext, title: string, blocks: Array<[number, number]>) {
  const segments = blocks.map(([start, minutes]) => ({ id: id("seg"), start_time: start, duration: minutes, completed: false }));
  const task = {
    id: id("tsk"),
    title,
    segments,
    start_times: segments.map((s) => s.start_time),
    durations: segments.map((s) => s.duration),
    total_duration: segments.reduce((sum, s) => sum + s.duration, 0) || 60,
    default_timing: 60,
    color: "#3ba4f6",
    icon: "task_alt",
    is_locked: false,
  };
  const res = await context.request.post("/api/tasks", { data: task });
  expect(res.status(), `seed ${title}`).toBe(201);
  return task.id;
}

/** Tomorrow at the given local hour, in Unix seconds: always in the future, always in view. */
export function tomorrowAt(hour: number, minute = 0) {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(hour, minute, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

/**
 * Device preferences are per browser (localStorage), so they are written
 * before the app's first script runs, the way a returning visitor's would be.
 */
export async function setPreferences(context: BrowserContext, prefs: { orientation?: Orientation; dayCount?: number }) {
  await context.addInitScript((p) => {
    try {
      if (p.orientation) localStorage.setItem("klndr_orientation_pref", p.orientation);
      if (p.dayCount) localStorage.setItem("klndr_day_count", String(p.dayCount));
    } catch {
      // Storage refused: the app falls back to its defaults, and the test says so.
    }
  }, prefs);
}

export async function openBoard(page: Page, path = "/") {
  await page.goto(path);
  await expect(page.locator("#klndrBoot")).toHaveCount(0);
  await page.waitForFunction(() => Boolean(window.klndr && window.klndr.canvasRenderer && Array.isArray(window.klndr.tasks)));
}

/** Every task's blocks as the board holds them, sorted, for exact before/after comparison. */
export async function snapshot(page: Page): Promise<Task[]> {
  return page.evaluate(() =>
    (window.klndr?.tasks ?? [])
      .map((t) => ({
        id: t.id,
        title: t.title,
        segments: (t.segments ?? []).map((s) => ({ id: s.id, start_time: s.start_time, duration: s.duration, completed: s.completed })),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

export const taskIn = (tasks: Task[], taskId: string) => {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`no task ${taskId} on the board`);
  return task;
};
export const endOf = (segment: Segment) => segment.start_time + segment.duration * MINUTE;

export async function isDragging(page: Page) {
  return page.evaluate(() => Boolean(window.klndr?.dragController?.activeDrag));
}

export async function undo(page: Page) {
  // Undo never steals from a text field.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ControlOrMeta+z");
}

export function card(page: Page, taskId: string) {
  return page.locator(`.timeline-task-card[data-task-id="${taskId}"]`).first();
}

/** What a press on a block's body must miss to be a move rather than a resize or a tick. */
export const NOT_THE_BODY = ".resize-handle, .timeline-seam-handle, .segment-pill";

/**
 * A point the element itself receives: the middle of its box if nothing sits
 * on top there, otherwise the first point along its middle line that it does
 * (a pill or a badge can cover the centre of a handle). Scrolled to the middle
 * of the timeline first, so a drag from it has room on both sides.
 */
export async function centerOf(
  locator: Locator,
  options: { requireHit?: boolean; avoid?: string } = {},
): Promise<Point> {
  await locator.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" }));
  // A seam under a mouse only takes pointer events once the pointer has come
  // close enough to arm it, so its middle is the place to aim for.
  if (options.requireHit === false) {
    const box = await locator.boundingBox();
    if (!box) throw new Error("element has no box");
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  const point = await locator.evaluate((el, avoid) => {
    const box = el.getBoundingClientRect();
    const hits = (x: number, y: number) => {
      const top = document.elementFromPoint(x, y);
      if (!top || !(top === el || el.contains(top))) return false;
      return !(avoid && top.closest(avoid));
    };
    const candidates: Array<[number, number]> = [[box.left + box.width / 2, box.top + box.height / 2]];
    for (let i = 1; i < 10; i++) {
      candidates.push([box.left + (box.width * i) / 10, box.top + box.height / 2]);
      candidates.push([box.left + box.width / 2, box.top + (box.height * i) / 10]);
    }
    const found = candidates.find(([x, y]) => hits(x, y));
    return found ? { x: found[0], y: found[1] } : null;
  }, options.avoid ?? null);
  if (!point) throw new Error("no point of the element is on top");
  return point;
}

/** Screen pixels per minute along the time axis, read off a block of known length. */
export async function pixelsPerMinute(locator: Locator, orientation: Orientation, minutes: number) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no box");
  return (orientation === "horizontal" ? box.width : box.height) / minutes;
}

export const offset = (from: Point, orientation: Orientation, pixels: number): Point => ({
  x: from.x + along(orientation, pixels).x,
  y: from.y + along(orientation, pixels).y,
});

/** One unit along the axis time runs on: x when it runs across, y when it runs down. */
export const along = (orientation: Orientation, distance: number): Point =>
  orientation === "horizontal" ? { x: distance, y: 0 } : { x: 0, y: distance };

const steps = (from: Point, to: Point, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    x: from.x + ((to.x - from.x) * (i + 1)) / count,
    y: from.y + ((to.y - from.y) * (i + 1)) / count,
  }));

export type DragOptions = {
  /** Hold still this long first: a touch on a block's body needs the 400ms long press. */
  hold?: number;
  /** Where the pointer goes before it is released, if not where it ended. */
  releaseAt?: Point;
  /** End the gesture with a cancel instead of a release (touch only). */
  cancel?: boolean;
  /** Runs with the pointer still down, just before the release or cancel. */
  beforeRelease?: () => Promise<void>;
};

/**
 * Press at `from`, travel to `to` in small steps with a frame between each, and
 * release. Touch goes through CDP touch events, so the page sees real touch
 * pointers: the long press, the slop and the capture all run as on a phone.
 */
export async function drag(page: Page, input: Input, from: Point, to: Point, options: DragOptions = {}) {
  if (input === "mouse") {
    await page.mouse.move(from.x, from.y);
    // A hover first: seams arm on proximity, and only for a pointer that moves.
    await page.mouse.move(from.x + 1, from.y + 1);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    if (options.hold) await page.waitForTimeout(options.hold);
    for (const point of steps(from, to, 12)) {
      await page.mouse.move(point.x, point.y);
      await page.waitForTimeout(16);
    }
    if (options.releaseAt) await page.mouse.move(options.releaseAt.x, options.releaseAt.y, { steps: 4 });
    await options.beforeRelease?.();
    await page.mouse.up();
    return;
  }

  const cdp: CDPSession = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", point?: Point) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: point ? [{ x: point.x, y: point.y }] : [] });
  await touch("touchStart", from);
  if (options.hold) await page.waitForTimeout(options.hold);
  for (const point of steps(from, to, 12)) {
    await touch("touchMove", point);
    await page.waitForTimeout(16);
  }
  if (options.releaseAt) await touch("touchMove", options.releaseAt);
  await options.beforeRelease?.();
  await touch(options.cancel ? "touchCancel" : "touchEnd");
  await cdp.detach();
}
