# klndr — responsive & touch regression checklist

There is no DOM test framework in this repo. `test-e2e.js` is a raw-`http` API
smoke test — auth redirects and CRUD — with zero coverage of geometry, input or
layout, and `package.json` has no `test` script. This file is the substitute:
run it by hand after any change to the timeline renderer, the drag controller,
the layout controller or `responsive.css`.

Two things here are automatable and should be done first, because they are free:

| Check | How |
|---|---|
| Geometry self-check | Load `/?debug=geom`. The console must print `[klndr geom] ok:` and never `[klndr geom]` with a problem list. Repeat at each day count. |
| Console is clean | `Failed to load resource: 400` / `Background sync failed for sylla` are pre-existing and unrelated. Anything else is a regression. |

---

## Device matrix

Reload at every size. Resizing an already-loaded page does **not** re-evaluate
media queries reliably in emulation, and several rules only take effect at boot.

| Profile | Size | Expect |
|---|---|---|
| iPhone SE | 375 × 667 | phone, vertical |
| iPhone 14 Pro | 393 × 852 | phone, vertical |
| Pixel 7 | 412 × 915 | phone, vertical |
| Phone landscape | 844 × 390 | **phone**, **horizontal**, 44px header + 44px tab bar |
| iPad Mini portrait | 768 × 1024 | tablet, vertical, two panes |
| iPad Mini landscape | 1024 × 768 | desktop, horizontal |
| Desktop | 1440 × 900 | desktop, horizontal |
| Narrow desktop | 900 × 700 | tablet, horizontal — the pane that used to render at 0px |

At each: `document.body.dataset` must report the `layout`, `orientation` and
`input` the table implies, and the calendar pane must have a non-zero width.

---

## The 20 drag cases

Five drag types × two orientations × two input types. Force an orientation from
**Calendar Options → Calendar Direction** so both can be exercised at any width.

| # | Drag | Orientation | Input | Expect |
|---|---|---|---|---|
| 1 | move | horizontal | mouse | sideways = new time, vertically = new day, duration held |
| 2 | move | horizontal | touch | 400ms press first; a shorter press is a tap, not a move |
| 3 | move | vertical | mouse | **down = later**, sideways = new day with the time preserved |
| 4 | move | vertical | touch | as above, after the long press |
| 5 | resize-left | horizontal | mouse | start moves, end pinned |
| 6 | resize-left | horizontal | touch | handle responds instantly — handles skip the long press |
| 7 | resize-left | vertical | mouse | writes `height`, never `width` |
| 8 | resize-left | vertical | touch | handles sit top/bottom, not left/right |
| 9 | resize-right | horizontal | mouse | end moves, start pinned |
| 10 | resize-right | horizontal | touch | as above |
| 11 | resize-right | vertical | mouse | as above, downward |
| 12 | resize-right | vertical | touch | as above |
| 13 | seam | horizontal | mouse | the two blocks trade minutes; **total span unchanged** |
| 14 | seam | horizontal | touch | seams are always armed on touch, 28px wide |
| 15 | seam | vertical | mouse | seam runs across the column, drags up/down |
| 16 | seam | vertical | touch | as above |
| 17 | sidebar-drop | horizontal | mouse | drag starts only after 4px, not on bare mousedown |
| 18 | sidebar-drop | horizontal | touch | the task list still scrolls; drag needs 400ms |
| 19 | sidebar-drop | vertical | mouse | lands in the right column and at the right time |
| 20 | sidebar-drop | vertical | touch | as above |

For every one of the 20: release outside the window and confirm the block does
not stick to the pointer, and that **undo** restores the previous state exactly.

---

## Input

- [ ] **Tap a block** (touch) → the block editor opens. The title is **not**
      focused, so the keyboard does not cover the sheet.
- [ ] **Tap → More…** → the six block actions open as a bottom sheet at phone
      width; the button is absent on mouse input.
- [ ] **Long-press a block and drag it.** The block moves and the timeline does
      **not** scroll underneath it. This is the one that `touch-action` decides:
      `.timeline-task-card` must compute to `none` on a coarse pointer, because
      the answer is latched when the gesture starts and cannot be given later.
      Emulation will not reproduce a failure here — a desktop browser has no
      compositor pan to lose the gesture to.
- [ ] **Drag a block to the top or bottom edge** and hold still: the view scrolls
      so any hour is reachable, faster the closer to the edge, and stops at the
      ends rather than spinning. It must **not** scroll while the pointer is
      outside the timeline (a desktop drag parked over the sidebar).
- [ ] **Split here** does not cut immediately. It shows the cut line and a
      confirm bar reading `Cut at 11:00 AM — 120m + 120m`, and:
  - [ ] from a right-click the line starts *where you clicked*; from the touch
        sheet it starts at the block's **midpoint**, there being no click point;
  - [ ] pressing and dragging on the timeline moves the line — along X when time
        runs across, down Y when it runs down;
  - [ ] dragging past either end clamps so neither half drops below 15 minutes;
  - [ ] **Split** commits exactly where the line was shown, and undo restores one
        block;
  - [ ] **Cancel** and **Escape** both leave the block untouched, clear the line,
        hide the bar and let normal drags resume;
  - [ ] while placing, nothing else responds — no block drags, no seam arming,
        no tooltips;
  - [ ] the resulting pair has a seam between them, so the cut can still be
        adjusted after the fact.
- [ ] **Right-click** (mouse) still opens the menu *at the pointer*, not as a
      sheet.
- [ ] **Pill tap** toggles completion and does **not** start a drag — the guard
      is on `pointerdown`, not `mousedown`.
- [ ] **Checkbox tap** toggles and does not drag; its hit area extends past its
      28px box without stealing taps from the neighbouring card.
- [ ] **Double-click** (mouse) still opens the editor.
- [ ] **Long-press on Android** does not raise the native context menu.
- [ ] **Pinch** zooms about the fingers, and cannot start while a drag is in
      flight (nor a drag while pinching).
- [ ] Lift a second finger anywhere off-screen mid-pinch, then long-press a
      block: the drag must still start. (A pointer left in the pinch map reads
      as half a pinch and silently blocks every future drag.)
- [ ] **Snap while dragging (touch)** in Calendar Options: off / tick / bucket
      change the grid a finger drags against, and change **nothing** for a mouse
      drag, where Shift still rules.

---

## Layout

- [ ] Phone: one pane at a time; the bottom tab bar switches between them.
- [ ] Phone: the tasks pane is a flat list, never 280px kanban columns.
- [ ] Phone: modals arrive as bottom sheets, flush to the bottom edge.
- [ ] Tablet: both panes fit, header on one row, sidebar 264px and not shrinking.
- [ ] Landscape phone: **one** header row, 44px tab bar, and the two-pane tablet
      shape must **not** appear (it is 844px wide and would otherwise match).
- [ ] Rotate a real device both ways: layout and orientation follow, and the
      canvas relayouts rather than stretching.
- [ ] Admin users table scrolls inside itself rather than widening the page.
- [ ] **The calendar opens at the current hour**, not at midnight. On a phone
      only about a third of a day is on screen at the default vertical zoom, so
      landing at 0 puts every block below the fold. Rotating must also land
      somewhere useful rather than back at 0.
- [ ] **Where the three fixtures live on a vertical block.** The grips take the
      middle 46% of the top and bottom edges; the badge takes the **left** edge;
      the pill takes the **foot**, as a bar between the text and the bottom
      grip; the lock takes the bottom right corner. Nothing shares a row with
      anything else — the badge and the pill may sit over a grab BAND, which is
      invisible, but never over a grip, which is not.
- [ ] **Only the title steps around the badge.** The category runs the full
      width of the block from the left edge, *above* the icon, and so does the
      time range below. The badge sits in the gutter the title alone opens.
- [ ] **From `is-md` up the bar clears the whole bottom grab band**, not just the
      grip line, so the bar and the handle each own their target: nothing below
      the bar toggles completion, nothing on the bar resizes. At a seam the band
      is 26px rather than 22 and the bar moves up to match. `is-sm` and below
      cannot afford the clearance and keep the tighter tuck.
- [ ] **Big blocks breathe.** The lane between a grip and the text is 9px at
      `is-sm`, 12px at `is-md` and 18px at `is-lg` — a 60px block can spare nine
      and no more, and a 200px one has no reason to crowd.
- [ ] **The split pill drops its denominator when it is a dot** — `1`, not `1/2`,
      at `is-min` and `is-xs`; the full `1/2` returns at `is-sm`, where the bar
      has the width for it.
- [ ] **The completion tick is 12px, not 24.** Google's Material Symbols sheet is
      linked after `app.css` and sets `.material-symbols-outlined { font-size:
      24px }`, so any one-class rule of ours ties and loses. `.segment-pill
      .segment-pill-check` is two classes for exactly that reason. If a new icon
      ever looks enormous, this is why: check the computed size against its host
      box before reaching for anything cleverer.
- [ ] **Hold a block to read it (touch).** A long press raises the same tooltip
      a hover gives on desktop — title, full range, category — which is the only
      way to read the tiers that have no room to print them. It must survive the
      whole gesture, and on Android that means surviving three separate things
      that each close a hover tooltip and are each right to: the context menu
      the OS callout triggers at ~500ms, the `closeAllModals` on its way in, and
      the `endDrag` when the finger lifts. So it is **pinned** rather than
      shown, and only `closeAllModals` and the menu's own outside-click handler
      may release it. Check all four:
  - [ ] it appears at the press and is **still there** once the menu is up;
  - [ ] it is still there after the finger comes off the glass;
  - [ ] it sits **above** the menu sheet, never behind it — including on a block
        taller than the screen, where "below the block" is off the bottom;
  - [ ] tapping a menu item, tapping outside, and Escape all take it away. A
        stranded tooltip has no other way to be dismissed.
- [ ] On a **mouse** the tooltip still goes on right-click, because hover has
      already offered it and the menu opens under the pointer.
- [ ] A background re-render while the menu is open leaves the tooltip alone.
- [ ] **The tier ladder, in order.** Zoom one block up through all five and
      check each arrival:

      | tier | what appears |
      |---|---|
      | `is-min` | icon left, grips, pill right — one row, no text |
      | `is-xs` | **one line of title**, pill right; the badge steps aside |
      | `is-sm` | badge back, title, pill along the foot, lock |
      | `is-md` | + the category above the title |
      | `is-lg` | + the time range, one clock reading per line |

      The tier follows DURATION, not the column: it reads the axis time runs
      along in both orientations. `is-xs` giving its row to the title rather
      than the badge is deliberate — a name you can read beats an icon that
      repeats what the block's colour already said.
- [ ] **Nothing is ever soft-locked.** Shrink a block until it is tiny: both grab
      bars must still be there (capped at 30% of the block each) so it can be
      dragged back. A block that loses its handles can never be resized again —
      there is no duration control in the editor to rescue it with.
- [ ] **Nothing is cut through the middle of a line.** Give a task a 40-character
      title and walk it up the ladder at 1, 3, 5 and 7 days: every text block
      must be a whole number of lines, ending in an ellipsis rather than in
      clipped descenders.
- [ ] **Seven days** (34px columns) drops the badge, the lock and the small
      pill, because a centred grip and a 12px control at the end of the same row
      cannot both fit in 34px. The bar along the foot survives from `is-sm` up.
      A finished block still reads as finished: `.is-completed` greys it out.
- [ ] The pill shrinks with the block and stays **inside** it at every size. On a
      block around 11px tall the two grip lines converge into what looks like
      one bar — that is the top and bottom edges being 11px apart, not a bug.

---

## Day count and navigation

- [ ] `1 · 3 · 5 · 7` appears in the header only when the calendar is vertical
      **and** the screen is phone-sized; everywhere else it is reached from
      Calendar Options → Days Shown, and the two stay in step.
- [ ] Switching count relayouts: lanes get wider and blocks change tier
      (7 → text-less bars, 1 → full card with title, time and category).
- [ ] The choice survives a reload. With nothing stored, a phone opens at 3 and
      anything larger at 7.
- [ ] Arrows step by **one view** — one day at N=1, a week at N=7 — and disable
      exactly when the next step would leave the ±28-day window.
- [ ] The date label reads `Mon, Sep 7` at 1 day, `Sep 7 – 9` within a month,
      `Sep 30 – Oct 2` across one, and `Sep 5 – Sep 11, 2026` at 7.
- [ ] Navigating **re-fetches**: a block on a day outside the old range appears
      when you reach it, and disappears when you leave.
- [ ] Hold an arrow down, then stop: the range shown matches the range fetched.
      (Out-of-order replies must not repaint a range you have already left.)
### Getting a task onto the calendar

- [ ] **Long-press a task in the list and drag it.** On a phone the calendar
      takes over the screen as soon as the press matures, the ghost keeps
      following your finger, and releasing on the grid schedules the task at the
      time that was previewed — not somewhere near it.
- [ ] **Release on the Tasks tab** instead: the tab highlights while you are over
      it, and the drop leaves the task unscheduled. This is the only way out once
      the pane has been handed over, because the list is no longer on screen.
- [ ] **Editor → Schedule** places the task near the current time, switches to
      the calendar, scrolls to it and flashes it. Undo removes it.
- [ ] Desktop drag from the sidebar still schedules, and the pane hand-off does
      nothing there because both panes are already visible.
- [ ] **Reorder arrows** on each task row move it one place up or down, past the
      row you can *see* (filters take rows out). They disable at the ends, the
      moved row stays in view, and undo puts the order back. They must be absent
      on desktop, where dragging a row still reorders it — they exist only
      because that gesture was taken away at phone width.

- [ ] **Swipe** left/right on the timeline steps the range — but only when the
      days all fit across. At 7 days on a phone the columns scroll sideways
      instead, and a swipe must do nothing.
- [ ] A mostly-vertical or short drag never navigates.
- [ ] Undo/redo work across a navigation and are not cleared by it.

---

## Performance

- [ ] Scroll a phone hard enough to collapse the URL bar. The board must not
      re-render per frame. To confirm: wrap `klndr.canvasRenderer.resize`, scroll,
      and check it is called **once, after the scroll stops** — not once per
      frame. This is the single worst thing the app can do on a phone.
- [ ] Canvas backing store stays sane at high zoom — DPR is capped at 2 on
      coarse pointers.

---

## Accessibility

- [ ] With **prefers-reduced-motion: reduce**, no modal, sheet, context menu,
      seam grip, focus flash or sync dot animates. The only animation that must
      survive is `app-boot-bailout` — it is `0s` and is a timeout, not motion.
- [ ] Touch targets reach 44px: nav arrows, zoom, Today, sidebar icons, modal
      close, and the day-count buttons.

---

## Must be done on real hardware

Emulation is faithful for everything above except these two, which it cannot
fake:

1. **Long-press versus scroll.** `touch-action` is consulted when a gesture
   *starts*, so flipping it to `none` when the 400ms timer fires will not stop a
   scroll that has already begun. What actually holds the gesture is the slop
   cancel plus `setPointerCapture` and `preventDefault` on subsequent moves.
   Verify on iOS Safari and Android Chrome that a long press on a block starts a
   drag and does **not** scroll the page, and that a press-and-drag *before* the
   timer scrolls normally and never leaves a half-started drag behind.
2. **iOS Safari's dynamic viewport.** With `100dvh`, the URL bar collapsing
   changes the app's height continuously. Confirm the bottom of the board is
   never hidden under browser chrome, the tab bar clears the home indicator, and
   the performance check above holds on the device rather than in emulation.
