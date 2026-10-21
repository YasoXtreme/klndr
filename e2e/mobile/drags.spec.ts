import { expect, test, type Browser } from "@playwright/test";
import {
  card,
  centerOf,
  clearTasks,
  drag,
  endOf,
  isDragging,
  NOT_THE_BODY,
  offset,
  openBoard,
  pixelsPerMinute,
  seedTask,
  setPreferences,
  signIn,
  snapshot,
  taskIn,
  tomorrowAt,
  undo,
  type Input,
  type Orientation,
} from "../support/board";

// docs/mobile-regression-checklist.md, "The 20 drag cases": five drags x two
// orientations x two kinds of pointer. Each one checks what the drop did to
// the model (not to pixels), that nothing is left stuck to the pointer, and
// that a single undo puts every block back exactly as it was.

const KINDS = ["move", "resize-left", "resize-right", "seam", "sidebar-drop"] as const;
type Kind = (typeof KINDS)[number];

// A touch on a block's body (or a task row) is a drag only after the 400ms
// long press; handles and seams start on contact. Held just past it: a finger
// that stays still to ~500ms raises the block's menu instead (hold to read),
// which is a feature, not a drag.
const LONG_PRESS = 450;

async function board(browser: Browser, orientation: Orientation, input: Input) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    // Touch means a touch-first device: (pointer: coarse) is what turns off
    // panning on block bodies (responsive.css), and without it the browser
    // claims a long press on a block as a scroll.
    hasTouch: input === "touch",
    isMobile: input === "touch",
    reducedMotion: "reduce",
  });
  await signIn(context);
  await clearTasks(context);
  const ids = {
    block: await seedTask(context, "Block", [[tomorrowAt(10), 120]]),
    // Two blocks that touch, so there is a seam between them.
    early: await seedTask(context, "Early half", [[tomorrowAt(14), 60]]),
    late: await seedTask(context, "Late half", [[tomorrowAt(15), 60]]),
    loose: await seedTask(context, "Unscheduled", []),
  };
  await setPreferences(context, { orientation, dayCount: 3 });
  const page = await context.newPage();
  await openBoard(page);
  expect(await page.evaluate(() => document.body.dataset.orientation)).toBe(orientation);
  return { context, page, ids };
}

for (const kind of KINDS) {
  for (const orientation of ["horizontal", "vertical"] as const) {
    for (const input of ["mouse", "touch"] as const) {
      test(`${kind} · ${orientation} · ${input}`, async ({ browser }) => {
        const { context, page, ids } = await board(browser, orientation, input);
        const before = await snapshot(page);
        const hold = input === "touch" ? LONG_PRESS : 0;
        // Distances in minutes, turned into pixels at whatever zoom the board
        // opened at, so every drop lands on free time.
        const block = card(page, ids.block);
        await centerOf(block);
        const ppm = await pixelsPerMinute(block, orientation, 120);
        const by = (minutes: number) => minutes * ppm;

        if (kind === "move") {
          const from = await centerOf(block, { avoid: NOT_THE_BODY });
          await drag(page, input, from, offset(from, orientation, by(60)), { hold });
        } else if (kind === "resize-left" || kind === "resize-right") {
          const handle = block.locator(`.resize-handle-${kind === "resize-left" ? "left" : "right"}`);
          const from = await centerOf(handle);
          await drag(page, input, from, offset(from, orientation, by(kind === "resize-left" ? -30 : 30)));
        } else if (kind === "seam") {
          const seam = page.locator(`.timeline-seam-handle[data-left-task-id="${ids.early}"]`);
          const from = await centerOf(seam, { requireHit: input === "touch" });
          await drag(page, input, from, offset(from, orientation, by(20)));
        } else {
          // Onto tomorrow, a couple of hours after the last block there.
          const anchor = await centerOf(card(page, ids.late));
          const to = offset(anchor, orientation, by(150));
          const from = await centerOf(page.locator(`.sidebar-task-card[data-task-id="${ids.loose}"]`));
          await drag(page, input, from, to, { hold });
        }

        // Released: nothing follows the pointer any more.
        await expect.poll(() => isDragging(page)).toBe(false);
        const after = await snapshot(page);
        assertOutcome(kind, before, after, ids);

        await undo(page);
        await expect.poll(() => snapshot(page)).toEqual(before);
        await context.close();
      });
    }
  }
}

type Ids = { block: string; early: string; late: string; loose: string };
type Board = Awaited<ReturnType<typeof snapshot>>;

function assertOutcome(kind: Kind, before: Board, after: Board, ids: Ids) {
  const was = (id: string) => taskIn(before, id).segments;
  const now = (id: string) => taskIn(after, id).segments;

  if (kind === "move") {
    // Later in time, same length.
    expect(now(ids.block)[0]!.start_time).toBeGreaterThan(was(ids.block)[0]!.start_time);
    expect(now(ids.block)[0]!.duration).toBe(was(ids.block)[0]!.duration);
  } else if (kind === "resize-left") {
    // The start moves earlier; the end stays pinned.
    expect(now(ids.block)[0]!.start_time).toBeLessThan(was(ids.block)[0]!.start_time);
    expect(endOf(now(ids.block)[0]!)).toBe(endOf(was(ids.block)[0]!));
  } else if (kind === "resize-right") {
    // The end moves later; the start stays pinned.
    expect(now(ids.block)[0]!.start_time).toBe(was(ids.block)[0]!.start_time);
    expect(now(ids.block)[0]!.duration).toBeGreaterThan(was(ids.block)[0]!.duration);
  } else if (kind === "seam") {
    // The two blocks trade minutes; the span they cover together is unchanged.
    const [early, late] = [now(ids.early)[0]!, now(ids.late)[0]!];
    expect(early.start_time).toBe(was(ids.early)[0]!.start_time);
    expect(early.duration).toBeGreaterThan(was(ids.early)[0]!.duration);
    expect(late.start_time).toBe(endOf(early));
    expect(endOf(late)).toBe(endOf(was(ids.late)[0]!));
  } else {
    expect(was(ids.loose)).toHaveLength(0);
    expect(now(ids.loose)).toHaveLength(1);
  }
}

// "Release outside the window and confirm the block does not stick to the
// pointer." A mouse can leave the window mid-drag; a finger can't, but the OS
// can take the gesture away, which arrives as a cancel and is not a drop.
test("a mouse drag released outside the window ends there", async ({ browser }) => {
  const { context, page, ids } = await board(browser, "horizontal", "mouse");
  const from = await centerOf(card(page, ids.block), { avoid: NOT_THE_BODY });
  const stillDragging = async () => expect(await isDragging(page)).toBe(true);
  await drag(page, "mouse", from, { x: from.x + 80, y: from.y }, { releaseAt: { x: 1400, y: -40 }, beforeRelease: stillDragging });
  await expect.poll(() => isDragging(page)).toBe(false);
  const settled = await snapshot(page);
  // Coming back over the board with the button up moves nothing.
  await page.mouse.move(from.x, from.y, { steps: 6 });
  expect(await snapshot(page)).toEqual(settled);
  await context.close();
});

test("a cancelled touch drag puts the block back", async ({ browser }) => {
  const { context, page, ids } = await board(browser, "vertical", "touch");
  const before = await snapshot(page);
  const from = await centerOf(card(page, ids.block), { avoid: NOT_THE_BODY });
  const stillDragging = async () => expect(await isDragging(page)).toBe(true);
  await drag(page, "touch", from, { x: from.x, y: from.y + 80 }, { hold: LONG_PRESS, cancel: true, beforeRelease: stillDragging });
  await expect.poll(() => isDragging(page)).toBe(false);
  expect(await snapshot(page)).toEqual(before);
  await context.close();
});
