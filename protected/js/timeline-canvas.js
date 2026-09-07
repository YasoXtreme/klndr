// Klndr Canvas Timeline Renderer
// Three-surface architecture: a scrolling BODY canvas holds the grid, while a
// frozen RULER canvas (top) and GUTTER canvas (left) sit outside the scroll
// container and repaint against the scroll offset, so the time axis and the day
// labels are never scrolled out of view.
//
// Coordinate space: the body canvas covers the timeline area only. x = 0 is
// 00:00 and y = 0 is the top of the first day row; the ruler and gutter live in
// their own surfaces and are not part of it.

class TimelineCanvas {
  static MIN_ROW_HEIGHT = 72;
  static MIN_ZOOM = 1;
  static MAX_ZOOM = 8;
  static ZOOM_STORAGE_KEY = 'klndr_timeline_zoom';
  // Vertical needs its own remembered zoom. At zoom 1 a whole day compressed
  // into a phone's height is about 0.35 px/min - a 30-minute block would be ten
  // pixels tall - so the two orientations want genuinely different defaults, and
  // one shared key would let each rotation clobber the other's setting.
  static ZOOM_STORAGE_KEY_VERTICAL = 'klndr_timeline_zoom_v';
  static DEFAULT_VERTICAL_ZOOM = 3;

  // Surface depths. The top surface is shallower when it only carries day names.
  static TIME_AXIS_DEPTH = 56;
  static DAY_AXIS_DEPTH_TOP = 44;
  static DAY_AXIS_DEPTH_SIDE = 60;
  // "10:00 AM" needs more room than a rotated day name did.
  static TIME_AXIS_DEPTH_SIDE = 62;

  // How far a block is inset from its lane's edges, and the smallest main-axis
  // extent it may be drawn at. Named because they appear in three places that
  // must agree - the DOM rect, the seam rect and the projection ghost.
  // A lane's floor: a row height when time runs across, a column width when it
  // runs down. 44 is the smallest column that still fits a readable block.
  static MIN_LANE_WIDTH = 44;
  static LANE_INSET = 5;
  static MIN_BLOCK_MAIN = 10;

  constructor({ bodyCanvas, rulerCanvas, gutterCanvas, scrollContainer, viewport, domOverlay, state, onLayoutChange }) {
    this.canvas = bodyCanvas;
    this.rulerCanvas = rulerCanvas;
    this.gutterCanvas = gutterCanvas;
    this.scrollContainer = scrollContainer;
    this.viewport = viewport;
    this.domOverlay = domOverlay;
    this.state = state;
    this.onLayoutChange = onLayoutChange || null;

    this.ctx = bodyCanvas.getContext('2d');
    this.rulerCtx = rulerCanvas.getContext('2d');
    this.gutterCtx = gutterCanvas.getContext('2d');

    // Which screen axis carries TIME. Everything below is written in terms of
    // MAIN (time) and CROSS (days) so one renderer serves both; this is the only
    // place the mapping to x/y is decided.
    this.orientation = 'horizontal';

    // Depths of the two frozen surfaces, in their orientation-dependent roles.
    // Assigned properly by resize(); seeded here because the constructor paints
    // one frame before the first layout.
    this.headerHeight = TimelineCanvas.TIME_AXIS_DEPTH;
    this.dayHeaderWidth = TimelineCanvas.DAY_AXIS_DEPTH_SIDE;
    this.dpr = TimelineCanvas.effectiveDpr();

    // Horizontal zoom. 1 = the full 24h fits the viewport with no scrolling.
    this.zoom = this.readStoredZoom();

    this.isShiftMode = false;
    // Both are MAIN-axis coordinates, not x.
    this.hoverPlayheadMain = null;
    this.snapGuideMain = null;
    this.cutMarker = null;

    this._rafId = null;
    this._chromeRafId = null;
    this._layoutRafId = null;

    // When the last scroll happened, which requestLayout() needs: a mobile
    // browser collapses its URL bar THROUGH a scroll, so a viewport height
    // measured mid-gesture is not the one it will settle at.
    this._lastScrollAt = 0;
    this.scrollContainer.addEventListener('scroll', () => {
      this._lastScrollAt = performance.now();
      this.requestChromeRender();
    }, { passive: true });
    this.scrollContainer.addEventListener('wheel', (e) => this.handleWheel(e), { passive: false });

    // Pinch is the touch spelling of Ctrl+wheel. Tracked here rather than in the
    // drag controller because it is a zoom, not a drag, and the two must never
    // both claim the same fingers.
    this._pinchPointers = new Map();
    this._pinchStart = null;
    this.scrollContainer.addEventListener('pointerdown', (e) => this.handlePinchDown(e));
    this.scrollContainer.addEventListener('pointermove', (e) => this.handlePinchMove(e), { passive: false });
    // Cleanup on window, not on the container: a finger can be lifted anywhere,
    // and a pointer left behind in the map would read as half a pinch forever -
    // which silently blocks every future long-press drag through isPinching().
    const endPinch = (e) => this.handlePinchUp(e);
    window.addEventListener('pointerup', endPinch);
    window.addEventListener('pointercancel', endPinch);

    // A ResizeObserver keeps geometry correct for every cause of a size change
    // (window resize, pane collapse, devtools) instead of guessing with timers.
    this.scrollbarSize = this.measureScrollbar();

    // Observe the VIEWPORT, not the scroll container: the scroll container's own
    // content box shrinks when a scrollbar appears, which would feed our own
    // relayout back into the observer and oscillate.
    this._resizeObserver = new ResizeObserver(() => this.requestLayout());
    this._resizeObserver.observe(this.viewport);

    this.resize();
    // resize() delegates to the app, which is not wired up yet during
    // construction, so paint the first frame ourselves.
    this.render();
  }

  static debugGeometry() {
    try {
      return new URLSearchParams(location.search).get('debug') === 'geom';
    } catch (e) { return false; }
  }

  // Phone screens report a DPR of 3, which across three canvases at high zoom
  // asks for more backing store than iOS Safari will hand out - and the extra
  // resolution is invisible at arm's length. Cap it where it stops paying.
  static usesCoarsePointer() {
    return Boolean(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  }

  static effectiveDpr() {
    const raw = window.devicePixelRatio || 1;
    return TimelineCanvas.usesCoarsePointer() ? Math.min(raw, 2) : raw;
  }

  // Measure the scroll container itself rather than a detached probe: this
  // element has its own ::-webkit-scrollbar width, which a probe would not pick up.
  measureScrollbar() {
    const el = this.scrollContainer;
    const previous = el.style.overflow;
    el.style.overflow = 'scroll';
    const size = el.offsetWidth - el.clientWidth;
    el.style.overflow = previous;
    return Math.max(0, size); // 0 on overlay-scrollbar platforms
  }

  get zoomStorageKey() {
    return this.mainIsX
      ? TimelineCanvas.ZOOM_STORAGE_KEY
      : TimelineCanvas.ZOOM_STORAGE_KEY_VERTICAL;
  }

  readStoredZoom() {
    try {
      const raw = parseFloat(localStorage.getItem(this.zoomStorageKey));
      if (Number.isFinite(raw)) return this.clampZoom(raw);
    } catch (e) { /* storage unavailable */ }
    return this.mainIsX ? 1 : TimelineCanvas.DEFAULT_VERTICAL_ZOOM;
  }

  clampZoom(z) {
    return Math.max(TimelineCanvas.MIN_ZOOM, Math.min(TimelineCanvas.MAX_ZOOM, z));
  }

  setShiftMode(enabled) {
    if (this.isShiftMode !== enabled) {
      this.isShiftMode = enabled;
      this.requestRender();
    }
  }

  setPlayhead(main) {
    if (this.hoverPlayheadMain !== main) {
      this.hoverPlayheadMain = main;
      this.requestRender();
    }
  }

  // Where a "Split here" would cut. Held while the context menu is open, since
  // the menu covers the block and the pointer has left the cut point.
  setCutMarker(marker) {
    this.cutMarker = marker;
    this.render();
  }

  setSnapGuide(main) {
    if (this.snapGuideMain !== main) {
      this.snapGuideMain = main;
      this.requestRender();
    }
  }

  requestRender() {
    if (this._rafId) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this.render();
    });
  }

  // Scroll only moves the frozen surfaces; the body canvas is scrolled by the browser.
  requestChromeRender() {
    if (this._chromeRafId) return;
    this._chromeRafId = requestAnimationFrame(() => {
      this._chromeRafId = null;
      this.renderChrome();
    });
  }

  layoutKey() {
    return [
      this.viewport.clientWidth,
      this.viewport.clientHeight,
      this.state.days.length,
      this.zoom,
      // Without this a rotation keeps the old key and never relayouts.
      this.orientation,
      window.devicePixelRatio || 1
    ].join('|');
  }

  // How long the viewport must hold still before a touch device believes it.
  static LAYOUT_SETTLE_MS = 150;

  /**
   * Coalesce ResizeObserver bursts (a CSS transition fires many) into one
   * relayout, and ignore observations that do not actually change the geometry —
   * a relayout can toggle a scrollbar, which would otherwise feed back into the
   * observer.
   *
   * A frame is enough on a desktop, where nothing resizes the viewport
   * continuously. It is not enough on a phone. `layoutKey()` reads
   * viewport.clientHeight, and that is exactly what a collapsing URL bar changes
   * — smoothly, over the whole length of a scroll — so on the naive path every
   * frame of every scroll sees a new key and pays for a full relayout plus a
   * re-render of every card on screen. This is the single worst thing the app
   * can do on a phone.
   *
   * So on touch: wait for the viewport to settle, and re-arm rather than commit
   * while a scroll is still in flight. Re-arming instead of skipping is what
   * makes it self-correcting - the height that eventually gets measured is the
   * one the browser stopped at, however long that takes, and a real change (a
   * rotation, a pane collapse) still lands a settle-time later.
   */
  requestLayout() {
    if (!TimelineCanvas.usesCoarsePointer()) {
      if (this._layoutRafId) return;
      this._layoutRafId = requestAnimationFrame(() => {
        this._layoutRafId = null;
        if (this.layoutKey() === this._lastLayoutKey) return;
        this.resize();
      });
      return;
    }

    clearTimeout(this._layoutTimer);
    const settle = () => {
      if (performance.now() - this._lastScrollAt < TimelineCanvas.LAYOUT_SETTLE_MS) {
        this._layoutTimer = setTimeout(settle, TimelineCanvas.LAYOUT_SETTLE_MS);
        return;
      }
      if (this.layoutKey() === this._lastLayoutKey) return;
      this.resize();
    };
    this._layoutTimer = setTimeout(settle, TimelineCanvas.LAYOUT_SETTLE_MS);
  }

  // True when the days do not all fit across the cross axis, so that axis is
  // scrollable. Swipe-to-navigate stands down when this is true, because the
  // same gesture is already spoken for.
  get crossOverflows() {
    const total = Math.max(1, this.state.days.length) * this.laneSize;
    return total > this.availCross + 1;
  }

  // ==========================================
  // ZOOM
  // ==========================================

  setZoom(nextZoom, anchorRatio = 0.5) {
    const clamped = this.clampZoom(nextZoom);
    if (clamped === this.zoom) return;

    // Keep the time under the anchor point pinned while the scale changes.
    const anchorMain = this.mainScroll + this.availMain * anchorRatio;
    const anchorMinutes = this.mainToTime(anchorMain);

    this.zoom = clamped;
    try {
      localStorage.setItem(this.zoomStorageKey, String(clamped));
    } catch (e) { /* storage unavailable */ }

    this.resize();
    this.mainScroll = Math.max(0, this.timeToMain(anchorMinutes) - this.availMain * anchorRatio);
    this.requestChromeRender();
  }

  // ------------------------------------------------------------------ pinch

  // The scroll container is also the element the drag controller listens on and
  // captures to, so the two gesture readers see the same fingers and have to
  // agree on who owns them. A drag already in flight wins; a pinch already in
  // flight blocks a long press from maturing (see armPendingTouch).
  isPinching() {
    return Boolean(this._pinchStart);
  }

  handlePinchDown(e) {
    if (e.pointerType === 'mouse') return;
    if (document.body.classList.contains('is-touch-dragging')) return;
    this._pinchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._pinchPointers.size !== 2) return;

    // Claimed on the SECOND finger: with touch-action allowing pan, one finger
    // is a scroll and only the second makes the gesture a pinch.
    const [a, b] = [...this._pinchPointers.values()];
    const rect = this.scrollContainer.getBoundingClientRect();
    const midX = (a.x + b.x) / 2;
    this._pinchStart = {
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      zoom: this.zoom,
      anchorRatio: rect.width
        ? Math.max(0, Math.min(1, (midX - rect.left) / rect.width))
        : 0.5
    };
  }

  handlePinchMove(e) {
    if (!this._pinchPointers.has(e.pointerId)) return;
    this._pinchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!this._pinchStart || this._pinchPointers.size !== 2) return;

    if (e.cancelable) e.preventDefault();
    const [a, b] = [...this._pinchPointers.values()];
    const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    this.setZoom(
      this._pinchStart.zoom * (distance / this._pinchStart.distance),
      this._pinchStart.anchorRatio
    );
  }

  handlePinchUp(e) {
    this._pinchPointers.delete(e.pointerId);
    if (this._pinchPointers.size < 2) this._pinchStart = null;
  }

  zoomIn() { this.setZoom(this.zoom * 1.5); }
  zoomOut() { this.setZoom(this.zoom / 1.5); }
  zoomToFit() { this.setZoom(1); }

  handleWheel(e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = this.scrollContainer.getBoundingClientRect();
      const anchorRatio = rect.width ? (e.clientX - rect.left) / rect.width : 0.5;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.setZoom(this.zoom * factor, Math.max(0, Math.min(1, anchorRatio)));
      return;
    }

    // A wheel with nowhere to go is wasted: when the axis it would naturally
    // scroll is already fully visible, redirect it onto the time axis. Stated
    // as "the wheel's own axis vs the main axis" so it holds when they swap.
    const canScrollY = this.scrollContainer.scrollHeight > this.scrollContainer.clientHeight + 1;
    const canScrollX = this.scrollContainer.scrollWidth > this.scrollContainer.clientWidth + 1;
    const wheelAxisStuck = this.mainIsX ? !canScrollY : !canScrollX;
    const mainCanScroll = this.mainIsX ? canScrollX : canScrollY;

    if (wheelAxisStuck && mainCanScroll && e.deltaY !== 0 && e.deltaX === 0) {
      e.preventDefault();
      this.mainScroll += e.deltaY;
    }
  }

  // ==========================================
  // AXIS
  // ==========================================
  //
  // MAIN is the axis time runs along; CROSS is the one days are stacked on.
  // Horizontal: main = x, cross = y. Vertical swaps them and nothing else.
  // Every coordinate below this point is expressed in those terms, which is what
  // lets the grid, the block rects and the drag maths transpose as a unit.

  get mainIsX() { return this.orientation === 'horizontal'; }

  setOrientation(next) {
    const value = next === 'vertical' ? 'vertical' : 'horizontal';
    if (this.orientation === value) return;
    this.orientation = value;
    this.zoom = this.readStoredZoom();
    this.resize();
    // The scroll offset the browser preserved across this is a position on the
    // axis that has just stopped carrying time, so it means nothing now.
    // setZoom re-anchors for the same reason; this is the rotation's version of
    // that, and it is also what puts the phone's first vertical frame somewhere
    // other than midnight.
    this.scrollToNow();
  }

  // A lane is a row when time runs across, a column when it runs down, so its
  // floor is a different measurement in each.
  get minLaneSize() {
    return this.mainIsX ? TimelineCanvas.MIN_ROW_HEIGHT : TimelineCanvas.MIN_LANE_WIDTH;
  }

  toXY(main, cross) {
    return this.mainIsX ? { x: main, y: cross } : { x: cross, y: main };
  }

  fromXY(x, y) {
    return this.mainIsX ? { main: x, cross: y } : { main: y, cross: x };
  }

  get mainScroll() {
    return this.mainIsX ? this.scrollContainer.scrollLeft : this.scrollContainer.scrollTop;
  }

  set mainScroll(value) {
    if (this.mainIsX) this.scrollContainer.scrollLeft = value;
    else this.scrollContainer.scrollTop = value;
  }

  get crossScroll() {
    return this.mainIsX ? this.scrollContainer.scrollTop : this.scrollContainer.scrollLeft;
  }

  // How much of the main axis the scroll container shows at once.
  get mainViewport() {
    return this.mainIsX ? this.scrollContainer.clientWidth : this.scrollContainer.clientHeight;
  }

  get minutesPerPixel() {
    return this.mainSpan ? 1440 / this.mainSpan : 0;
  }

  // Minutes from day start (0-1440) -> main-axis pixels
  timeToMain(minutesFromStart) {
    const ratio = Math.max(0, Math.min(1, minutesFromStart / 1440));
    return ratio * this.mainSpan;
  }

  // Main-axis pixels -> minutes from day start (0-1440)
  mainToTime(main) {
    if (!this.mainSpan) return 0;
    const clamped = Math.max(0, Math.min(this.mainSpan, main));
    return (clamped / this.mainSpan) * 1440;
  }

  dayToCross(index) {
    return index * this.laneSize;
  }

  crossToDay(cross) {
    const idx = Math.floor(cross / this.laneSize);
    return Math.max(0, Math.min(this.state.days.length - 1, idx));
  }

  /**
   * The single choke point turning a placement into a CSS box. Everything that
   * positions a DOM element goes through here, which is why transposing the
   * timeline does not touch the block-building code at all.
   */
  rectFor(dayIdx, startMin, endMin, options = {}) {
    const crossInset = options.crossInset || 0;
    const minMain = options.minMain || 0;

    const m1 = this.timeToMain(startMin);
    const mainSize = Math.max(minMain, this.timeToMain(endMin) - m1);
    const crossStart = this.dayToCross(dayIdx) + crossInset;
    const crossSize = this.laneSize - crossInset * 2;

    return this.mainIsX
      ? { left: m1, top: crossStart, width: mainSize, height: crossSize }
      : { left: crossStart, top: m1, width: crossSize, height: mainSize };
  }

  /**
   * A seam has no main-axis extent - it is a boundary, and CSS centres it on the
   * line with a translate. So this reports where the line is and how far it runs
   * across the lane, plus which CSS property carries that run.
   */
  seamRectFor(dayIdx, boundaryMin) {
    const main = this.timeToMain(boundaryMin);
    const crossStart = this.dayToCross(dayIdx) + TimelineCanvas.LANE_INSET;
    const crossSize = this.laneSize - TimelineCanvas.LANE_INSET * 2;

    return {
      main,
      crossStart,
      crossEnd: crossStart + crossSize,
      crossSize,
      left: this.mainIsX ? main : crossStart,
      top: this.mainIsX ? crossStart : main,
      crossProp: this.mainIsX ? 'height' : 'width'
    };
  }

  // Where a cut would fall: a line across one whole lane.
  cutRectFor(dayIdx, minutes) {
    return {
      main: this.timeToMain(minutes),
      crossStart: this.dayToCross(dayIdx),
      crossSize: this.laneSize
    };
  }

  // The one place the canvas rect is consulted. Four copies of this had drifted
  // across the DOM and drag layers.
  clientToLocal(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return this.fromXY(clientX - rect.left, clientY - rect.top);
  }

  pointToTimeDay(clientX, clientY) {
    const { main, cross } = this.clientToLocal(clientX, clientY);
    return { main, cross, minutes: this.mainToTime(main), dayIndex: this.crossToDay(cross) };
  }

  // Takes BOTH deltas and projects onto the time axis, which is what lets the
  // resize and seam handlers stay orientation-free.
  deltaToMinutes(dx, dy) {
    return (this.mainIsX ? dx : dy) * this.minutesPerPixel;
  }

  /**
   * Proves the axis layer reproduces the pre-refactor formulas exactly. There is
   * no test framework here, so this is the closest thing available: enable with
   * ?debug=geom and it runs on every resize.
   */
  verifyGeometry() {
    if (!this.mainIsX) return { skipped: 'vertical has no legacy formula' };
    const problems = [];
    const days = Math.max(1, this.state.days.length);

    for (let d = 0; d < days; d++) {
      for (const [s, e] of [[0, 30], [540, 660], [1410, 1440], [0, 1440]]) {
        const got = this.rectFor(d, s, e, { crossInset: TimelineCanvas.LANE_INSET, minMain: TimelineCanvas.MIN_BLOCK_MAIN });
        const x1 = this.timeToMain(s);
        const want = {
          left: x1,
          width: Math.max(TimelineCanvas.MIN_BLOCK_MAIN, this.timeToMain(e) - x1),
          top: this.dayToCross(d) + TimelineCanvas.LANE_INSET,
          height: this.laneSize - TimelineCanvas.LANE_INSET * 2
        };
        for (const k of ['left', 'top', 'width', 'height']) {
          if (Math.abs(got[k] - want[k]) > 1e-9) {
            problems.push(`day ${d} ${s}-${e} ${k}: ${got[k]} != ${want[k]}`);
          }
        }
      }
    }

    // Round-tripping must land back on the same minute, or drags will drift.
    for (const m of [0, 1, 359.5, 720, 1439]) {
      const back = this.mainToTime(this.timeToMain(m));
      if (Math.abs(back - m) > 1e-6) problems.push(`roundtrip ${m} -> ${back}`);
    }
    for (let d = 0; d < days; d++) {
      if (this.crossToDay(this.dayToCross(d) + 1) !== d) problems.push(`day roundtrip ${d}`);
    }

    if (problems.length) console.error('[klndr geom]', problems);
    else console.log('[klndr geom] ok:', days, 'days, mainSpan', this.mainSpan, 'lane', this.laneSize);
    return problems;
  }

  // ==========================================
  // GEOMETRY
  // ==========================================

  resize() {
    this.dpr = TimelineCanvas.effectiveDpr();
    this._lastLayoutKey = this.layoutKey();

    const numDays = Math.max(1, this.state.days.length);
    const sb = this.scrollbarSize;

    // Which axis each surface is labelling decides how deep it needs to be, and
    // CSS positions all three surfaces off these same two numbers - so JS is the
    // source of truth and hands them over as custom properties rather than
    // hoping the stylesheet's constants still agree.
    this.headerHeight = this.mainIsX
      ? TimelineCanvas.TIME_AXIS_DEPTH
      : TimelineCanvas.DAY_AXIS_DEPTH_TOP;
    this.dayHeaderWidth = this.mainIsX
      ? TimelineCanvas.DAY_AXIS_DEPTH_SIDE
      : TimelineCanvas.TIME_AXIS_DEPTH_SIDE;
    this.viewport.style.setProperty('--header-bucket-height', `${this.headerHeight}px`);
    this.viewport.style.setProperty('--day-header-width', `${this.dayHeaderWidth}px`);

    // The scroll container is pinned inside the viewport, so its border box is
    // derived rather than measured. Measuring clientWidth/clientHeight instead
    // would fold in whichever scrollbars happen to be showing right now.
    const boxWidth = Math.max(1, this.viewport.clientWidth - this.dayHeaderWidth);
    const boxHeight = Math.max(1, this.viewport.clientHeight - this.headerHeight);

    // Always reserve scrollbar space on both axes, even when neither scrollbar is
    // showing. Sizing the content to exactly fill the box deadlocks: any transient
    // scrollbar shrinks the client box below the content, which keeps the
    // scrollbar alive forever. The extra pixel guarantees the retraction.
    const reserve = sb + 1;
    const availWidth = Math.max(1, boxWidth - reserve);
    const availHeight = Math.max(1, boxHeight - reserve);

    // Restated in main/cross terms: the arithmetic below is identical in both
    // orientations, and this mapping is the only thing that differs.
    this.availMain = this.mainIsX ? availWidth : availHeight;
    this.availCross = this.mainIsX ? availHeight : availWidth;
    this.rulerWidth = boxWidth;
    this.gutterHeight = boxHeight;

    // Zoom 1 fits all 24h in the viewport, so the day is never partly off-screen
    // unless the user deliberately zooms in. Floor to whole pixels so an exact
    // fit cannot round into a one-pixel overflow and summon a scrollbar.
    this.mainSpan = Math.floor(this.availMain * this.zoom);
    this.pxPerMinute = this.mainSpan / 1440;

    // The week is always whole: lanes divide the cross axis, down to a floor.
    this.laneSize = Math.max(this.minLaneSize, Math.floor(this.availCross / numDays));

    const crossTotal = numDays * this.laneSize;
    this.width = this.mainIsX ? this.mainSpan : crossTotal;
    this.height = this.mainIsX ? crossTotal : this.mainSpan;

    this.sizeCanvas(this.canvas, this.ctx, this.width, this.height);
    this.sizeCanvas(this.rulerCanvas, this.rulerCtx, this.rulerWidth, this.headerHeight);
    this.sizeCanvas(this.gutterCanvas, this.gutterCtx, this.dayHeaderWidth, this.gutterHeight);

    if (this.domOverlay) {
      this.domOverlay.style.width = `${this.width}px`;
      this.domOverlay.style.height = `${this.height}px`;
    }

    if (TimelineCanvas.debugGeometry()) this.verifyGeometry();

    // Geometry changed, so the DOM task cards are now stale too. Hand off to the
    // app so canvas and overlay always re-render together.
    if (this.onLayoutChange) {
      this.onLayoutChange();
    } else {
      this.render();
    }
  }

  sizeCanvas(canvas, ctx, cssWidth, cssHeight) {
    const w = Math.max(1, Math.round(cssWidth));
    const h = Math.max(1, Math.round(cssHeight));
    // Assigning width/height resets the context transform, so re-apply the DPR scale.
    canvas.width = Math.round(w * this.dpr);
    canvas.height = Math.round(h * this.dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  // Align a stroke so its edges land on device pixel boundaries (no blurry hairlines).
  crisp(value, lineWidth) {
    const half = (lineWidth * this.dpr) / 2;
    return (Math.round(value * this.dpr - half) + half) / this.dpr;
  }

  scrollToTime(minutes, ratio = 0.5) {
    this.mainScroll = Math.max(0, this.timeToMain(minutes) - this.mainViewport * ratio);
  }

  // Where "now" falls in the visible strip, or null when today is not in it.
  // Extracted from drawNowLine, which had the only copy of this arithmetic.
  nowPosition() {
    const nowTs = Date.now() / 1000;
    const dayIndex = this.state.days.findIndex(
      day => nowTs >= day.startTimestamp && nowTs < day.startTimestamp + 86400
    );
    if (dayIndex === -1) return null;
    return { dayIndex, minutes: (nowTs - this.state.days[dayIndex].startTimestamp) / 60 };
  }

  /**
   * Put the current hour on screen.
   *
   * Until this existed the timeline opened at scroll 0 - midnight - every time,
   * which on a desktop was nearly harmless because zoom 1 fits the whole day,
   * and on a phone means opening onto an empty 00:00-05:00 with every block
   * below the fold. Slightly above centre, because what is coming matters more
   * than what has gone.
   */
  scrollToNow(ratio = 0.35) {
    const now = this.nowPosition();
    // Nine o'clock when today is not in range: the same answer the rest of the
    // app gives when it has to guess at a useful hour.
    this.scrollToTime(now ? now.minutes : 9 * 60, ratio);
    this.requestChromeRender();
  }

  formatHourLabel(hour) {
    const h = hour % 24;
    const ampm = h >= 12 && h < 24 ? 'PM' : 'AM';
    const displayH = h % 12 === 0 ? 12 : h % 12;
    return `${displayH}:00 ${ampm}`;
  }

  formatShortHourLabel(hour) {
    const h = hour % 24;
    const ampm = h >= 12 && h < 24 ? 'PM' : 'AM';
    const displayH = h % 12 === 0 ? 12 : h % 12;
    return `${displayH} ${ampm}`;
  }

  formatCompactHourLabel(hour) {
    const h = hour % 24;
    const ampm = h >= 12 && h < 24 ? 'p' : 'a';
    const displayH = h % 12 === 0 ? 12 : h % 12;
    return `${displayH}${ampm}`;
  }

  formatTimeLabel(totalMinutes) {
    const hour = Math.floor(totalMinutes / 60) % 24;
    const mins = Math.floor(totalMinutes % 60);
    const ampm = hour >= 12 && hour < 24 ? 'PM' : 'AM';
    const displayH = hour % 12 === 0 ? 12 : hour % 12;
    const padM = mins < 10 ? '0' + mins : mins;
    return `${displayH}:${padM} ${ampm}`;
  }

  isCollapsed() {
    const calPane = document.getElementById('calendarPane');
    return Boolean(calPane && calPane.classList.contains('is-collapsed'));
  }

  // ==========================================
  // RENDER ENTRY POINTS
  // ==========================================

  render() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (!this.ctx || this.isCollapsed()) return;
    if (!this.width || !this.height) return;

    this.renderBody();
    this.renderChrome();
  }

  /**
   * The two frozen surfaces are defined by WHICH SCROLL AXIS THEY ARE FROZEN
   * AGAINST, not by what they draw:
   *
   *   top  - frozen against vertical scroll, tracks the horizontal one, and so
   *          labels whatever varies along X.
   *   left - frozen against horizontal scroll, tracks the vertical one, and so
   *          labels whatever varies along Y.
   *
   * Horizontal puts time on X, so the top surface rules time and the left one
   * names days. Vertical swaps which painter goes where - and nothing else. The
   * DOM nodes, their CSS positions, the z-indexes and the freeze logic are all
   * untouched by the rotation.
   */
  renderChrome() {
    if (!this.rulerCtx || !this.gutterCtx || this.isCollapsed()) return;

    const top = { ctx: this.rulerCtx, length: this.rulerWidth, depth: this.headerHeight, along: 'x' };
    const left = { ctx: this.gutterCtx, length: this.gutterHeight, depth: this.dayHeaderWidth, along: 'y' };

    if (this.mainIsX) {
      this.paintTimeAxis(top);
      this.paintDayAxis(left);
    } else {
      this.paintDayAxis(top);
      this.paintTimeAxis(left);
    }
  }

  /**
   * Surface-local mapping. `along` runs parallel to the axis being labelled;
   * `depth` runs into the surface from its OUTER edge, so the baseline is at
   * depth - 1 whichever way round it is, and ticks always grow away from the
   * grid by the same arithmetic.
   */
  surfacePoint(surface, along, depth) {
    return surface.along === 'x' ? { x: along, y: depth } : { x: depth, y: along };
  }

  renderBody() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    this.drawGrid(ctx);
    this.drawNowLine(ctx);
    this.drawGuides(ctx);
  }

  // ==========================================
  // BODY: GRID
  // ==========================================

  // Every stroke on the body canvas is one of three shapes, and each transposes
  // by swapping which argument is which. Routing them through these three
  // helpers is what makes the grid orientation-agnostic.

  // A line at one time, spanning every day.
  strokeAtTime(ctx, minutes, lineWidth) {
    const main = this.crisp(this.timeToMain(minutes), lineWidth);
    const span = this.mainIsX ? this.height : this.width;
    const a = this.toXY(main, 0);
    const b = this.toXY(main, span);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // A line at one lane boundary, spanning the whole day.
  strokeAtDay(ctx, dayIndex, lineWidth) {
    const cross = this.crisp(this.dayToCross(dayIndex), lineWidth);
    const span = this.mainIsX ? this.width : this.height;
    const a = this.toXY(0, cross);
    const b = this.toXY(span, cross);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  fillLane(ctx, dayIndex) {
    const cross = this.dayToCross(dayIndex);
    const origin = this.toXY(0, cross);
    const size = this.mainIsX
      ? { w: this.width, h: this.laneSize }
      : { w: this.laneSize, h: this.height };
    ctx.fillRect(origin.x, origin.y, size.w, size.h);
  }

  drawGrid(ctx) {
    const bucketHours = this.state.bucketHours || 2;
    const numDays = this.state.days.length;

    ctx.save();

    // Today's lane gets a tint so the current day is findable at a glance.
    ctx.fillStyle = '#fbfff8';
    this.state.days.forEach((day, index) => {
      if (day.isToday) this.fillLane(ctx, index);
    });

    // Minor hour lines
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    for (let hour = 1; hour < 24; hour++) {
      if (hour % bucketHours === 0) continue;
      this.strokeAtTime(ctx, hour * 60, 1);
    }

    // Major bucket lines
    ctx.strokeStyle = '#9ca3af';
    ctx.lineWidth = 1.5;
    for (let hour = 0; hour <= 24; hour += bucketHours) {
      this.strokeAtTime(ctx, hour * 60, 1.5);
    }

    // Lane dividers
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.8;
    for (let i = 0; i <= numDays; i++) {
      this.strokeAtDay(ctx, i, 1.8);
    }

    ctx.restore();
  }

  drawNowLine(ctx) {
    const now = this.nowPosition();
    if (!now) return;

    const { dayIndex, minutes } = now;
    const main = this.timeToMain(minutes);
    const crossTop = this.dayToCross(dayIndex);

    // Unlike the grid lines this one spans a single lane, so it is drawn from
    // its two endpoints rather than through strokeAtTime.
    const a = this.toXY(main, crossTop);
    const b = this.toXY(main, crossTop + this.laneSize);
    const dot = this.toXY(main, crossTop + 5);

    ctx.save();
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawGuides(ctx) {
    ctx.save();

    if (this.snapGuideMain !== null) {
      const span = this.mainIsX ? this.height : this.width;
      const a = this.toXY(this.snapGuideMain, 0);
      const b = this.toXY(this.snapGuideMain, span);
      ctx.strokeStyle = '#16a34a';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (this.cutMarker) {
      const { main, crossStart, crossSize } = this.cutMarker;
      const cut = this.crisp(main, 2.5);
      const near = crossStart + 2;
      const far = crossStart + crossSize - 2;

      const a = this.toXY(cut, near);
      const b = this.toXY(cut, far);
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([7, 4]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Notches at both ends so it reads as a cut, not as another guide line.
      // The triangle straddles the cut on the MAIN axis and points inward along
      // the cross axis, which is the same shape either way round.
      const notch = (crossAt, pointAt) => {
        const p1 = this.toXY(main - 5, crossAt);
        const p2 = this.toXY(main + 5, crossAt);
        const tip = this.toXY(main, pointAt);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineTo(tip.x, tip.y);
        ctx.closePath();
        ctx.fill();
      };

      ctx.fillStyle = '#000000';
      notch(near, crossStart + 9);
      notch(far, crossStart + crossSize - 9);
    }

    if (this.hoverPlayheadMain !== null) {
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const span = this.mainIsX ? this.height : this.width;
      const a = this.toXY(this.hoverPlayheadMain, 0);
      const b = this.toXY(this.hoverPlayheadMain, span);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    ctx.restore();
  }

  // ==========================================
  // FROZEN SURFACES
  // ==========================================
  //
  // Two painters, each taking the surface it has been handed rather than
  // assuming which one it is. renderChrome() decides the assignment; from here
  // down nothing knows whether it is drawing along the top or down the side.

  // Choose an hour step whose labels cannot collide at the current zoom.
  hourLabelStep(bucketHours) {
    const candidates = [1, 2, 3, 4, 6, 8, 12];
    // Horizontal labels are limited by their WIDTH along the time axis. Vertical
    // ones are limited only by their height, which is far smaller - so a vertical
    // ruler can mark many more hours before they collide. Same rule, different
    // measurement.
    const minSpacing = this.mainIsX ? 44 : 22;
    const start = Math.max(1, bucketHours);
    for (const step of candidates) {
      if (step < start) continue;
      if (step * 60 * this.pxPerMinute >= minSpacing) return step;
    }
    return 12;
  }

  // Shorten the label form rather than dropping labels: keeping every other hour
  // marked matters more than spelling out ":00".
  //
  // The two orientations are squeezed by different things. Along the top it is
  // the gap between consecutive labels. Down the side labels never crowd each
  // other - they crowd the TICKS, because both live inside the same fixed
  // surface depth. So that form is fixed rather than computed.
  hourLabelFormatter(spacing) {
    if (!this.mainIsX) return (h) => this.formatShortHourLabel(h);
    if (spacing >= 92) return (h) => this.formatHourLabel(h);
    if (spacing >= 52) return (h) => this.formatShortHourLabel(h);
    return (h) => this.formatCompactHourLabel(h);
  }

  paintTimeAxis(surface) {
    const { ctx, length, depth } = surface;
    const alongX = surface.along === 'x';
    const w = alongX ? length : depth;
    const h = alongX ? depth : length;

    ctx.clearRect(0, 0, w, h);
    ctx.save();

    ctx.fillStyle = this.isShiftMode ? '#f2ffec' : '#ffffff';
    ctx.fillRect(0, 0, w, h);

    if (this.isShiftMode) {
      this.paintBucketRuler(surface);
    } else {
      this.paintTickRuler(surface);
    }

    // The border closing the ruler off from the grid: along the surface's inner
    // edge, which is the bottom when it sits on top and the right when it sits
    // down the side. Same arithmetic either way, because depth always runs
    // inward from the outer edge.
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2.2;
    const edge = this.crisp(depth - 1.1, 2.2);
    const a = this.surfacePoint(surface, 0, edge);
    const b = this.surfacePoint(surface, length, edge);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    this.paintPlayheadChip(surface);
    ctx.restore();
  }

  // A tick at one time, growing inward from the surface's outer edge.
  paintTick(surface, along, len, lineWidth, color) {
    const { ctx, depth } = surface;
    const baseline = depth - 1;
    const at = this.crisp(along, lineWidth);
    const a = this.surfacePoint(surface, at, baseline - len);
    const b = this.surfacePoint(surface, at, baseline);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  paintTickRuler(surface) {
    const { ctx, length, depth } = surface;
    const bucketHours = this.state.bucketHours || 2;
    const tickPercent = this.state.tickPercent || 25;
    const tickMinutes = (bucketHours * 60) * (tickPercent / 100);
    const labelStep = this.hourLabelStep(bucketHours);
    const offset = this.mainScroll;

    // Only walk the ticks that can actually be on screen.
    const step = Math.max(5, Math.min(15, tickMinutes));
    const firstMinute = Math.max(0, Math.floor(this.mainToTime(offset) / step) * step);
    const lastMinute = Math.min(1440, this.mainToTime(offset + length) + step);

    for (let m = firstMinute; m <= lastMinute; m += step) {
      const along = this.timeToMain(m) - offset;
      if (along < -2 || along > length + 2) continue;

      // Along the top a tick has the surface's whole depth to grow into,
      // because the labels sit above it. Down the side it shares that depth
      // with them, so it gives way.
      const tick = this.mainIsX
        ? { hour: 18, half: 11, minor: 6 }
        : { hour: 10, half: 7, minor: 4 };

      if (m % 60 === 0) this.paintTick(surface, along, tick.hour, 2, '#000000');
      else if (m % 30 === 0) this.paintTick(surface, along, tick.half, 1.4, '#000000');
      else this.paintTick(surface, along, tick.minor, 1, '#9ca3af');
    }

    // Hour labels, on their own pass so ticks never overdraw them. The text
    // stays horizontal in both orientations: reading direction is a property of
    // the reader, not of the axis, so this is the one part that does not
    // transpose.
    ctx.fillStyle = '#000000';
    ctx.font = '700 12px ElmsSans, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const format = this.hourLabelFormatter(labelStep * 60 * this.pxPerMinute);

    for (let hour = 0; hour <= 24; hour += labelStep) {
      const along = this.timeToMain(hour * 60) - offset;
      if (along < -50 || along > length + 50) continue;

      const label = format(hour);

      if (surface.along === 'x') {
        // Nudge the end labels inward so midnight is not sliced in half against
        // the gutter or the pane edge.
        const half = ctx.measureText(label).width / 2 + 3;
        ctx.fillText(label, Math.max(half, Math.min(length - half, along)), 18);
      } else {
        // Left-aligned and stopped short of the tick zone: centring it in the
        // surface put the text straight through the hour ticks.
        const clamped = Math.max(9, Math.min(length - 9, along));
        ctx.textAlign = 'left';
        ctx.fillText(label, 5, clamped);
        ctx.textAlign = 'center';
      }
    }
  }

  paintBucketRuler(surface) {
    const { ctx, length, depth } = surface;
    const bucketHours = this.state.bucketHours || 2;
    const offset = this.mainScroll;
    const bucketPx = bucketHours * 60 * this.pxPerMinute;
    const compact = bucketPx < 96;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let hour = 0; hour < 24; hour += bucketHours) {
      const a1 = this.timeToMain(hour * 60) - offset;
      const a2 = this.timeToMain((hour + bucketHours) * 60) - offset;
      if (a2 < -4 || a1 > length + 4) continue;

      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.5;
      const p1 = this.surfacePoint(surface, this.crisp(a1, 1.5), 0);
      const p2 = this.surfacePoint(surface, this.crisp(a1, 1.5), depth);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();

      const centre = a1 + (a2 - a1) / 2;
      ctx.fillStyle = '#000000';

      // The two label lines stack along DEPTH in both orientations, which is
      // why their offsets go through surfacePoint rather than straight into y.
      if (compact) {
        ctx.font = '700 11px ElmsSans, sans-serif';
        const p = this.surfacePoint(surface, centre, depth / 2);
        ctx.fillText(
          this.formatCompactHourLabel(hour) + '-' + this.formatCompactHourLabel(hour + bucketHours),
          p.x, p.y
        );
      } else {
        ctx.font = '700 12px ElmsSans, sans-serif';
        const near = this.surfacePoint(surface, centre, depth / 2 - 9);
        const far = this.surfacePoint(surface, centre, depth / 2 + 9);
        ctx.fillText(this.formatHourLabel(hour), near.x, near.y);
        ctx.fillText('\u2192 ' + this.formatHourLabel(hour + bucketHours), far.x, far.y);
      }
    }
  }

  paintPlayheadChip(surface) {
    if (this.hoverPlayheadMain === null) return;

    const { ctx, length, depth } = surface;
    const along = this.hoverPlayheadMain - this.mainScroll;
    if (along < 0 || along > length) return;

    const timeStr = this.formatTimeLabel(this.mainToTime(this.hoverPlayheadMain));

    // The chip's long side follows the reading direction, not the axis: on a
    // side ruler it is a short, wide box, and it has to fit a surface sized for
    // "10:00 AM" rather than for the 68px the top ruler could spend.
    const alongX = surface.along === 'x';
    const chipAlong = alongX ? 68 : 18;
    const chipDepth = alongX ? 20 : Math.min(56, depth - 6);
    const chipStart = Math.max(1, Math.min(length - chipAlong - 1, along - chipAlong / 2));

    const origin = this.surfacePoint(surface, chipStart, depth - chipDepth - 5);
    const w = alongX ? chipAlong : chipDepth;
    const h = alongX ? chipDepth : chipAlong;

    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.roundRect(origin.x, origin.y, w, h, 4);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 11px ElmsSans, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(timeStr, origin.x + w / 2, origin.y + h / 2);
  }

  paintDayAxis(surface) {
    const { ctx, length, depth } = surface;
    const alongX = surface.along === 'x';
    const offset = this.crossScroll;
    const w = alongX ? length : depth;
    const h = alongX ? depth : length;

    ctx.clearRect(0, 0, w, h);
    ctx.save();

    // The surface spans the whole scroll viewport, but the lanes cover only part
    // of it; past their end it should match the empty grid, not the gutter.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#f9fafb';
    const lanesOrigin = this.surfacePoint(surface, -offset, 0);
    const lanesExtent = this.mainIsX ? this.height : this.width;
    ctx.fillRect(
      lanesOrigin.x, lanesOrigin.y,
      alongX ? lanesExtent : depth,
      alongX ? depth : lanesExtent
    );

    this.state.days.forEach((day, index) => {
      const along = this.dayToCross(index) - offset;
      if (along + this.laneSize < 0 || along > length) return;

      if (day.isToday) {
        ctx.fillStyle = '#e6fbd8';
        const p = this.surfacePoint(surface, along, 0);
        ctx.fillRect(
          p.x, p.y,
          alongX ? this.laneSize : depth,
          alongX ? depth : this.laneSize
        );
      }

      // Lane divider
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.8;
      const d1 = this.surfacePoint(surface, this.crisp(along, 1.8), 0);
      const d2 = this.surfacePoint(surface, this.crisp(along, 1.8), depth);
      ctx.beginPath();
      ctx.moveTo(d1.x, d1.y);
      ctx.lineTo(d2.x, d2.y);
      ctx.stroke();

      const centre = along + this.laneSize / 2;

      ctx.save();
      if (alongX) {
        // Across the top the name reads straight, which is a genuine gain over
        // the rotation the side gutter is forced into.
        ctx.translate(centre, depth / 2);
      } else {
        ctx.translate(depth / 2, centre);
        ctx.rotate(-Math.PI / 2);
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Day name and date number, so you can tell which Saturday you are on.
      ctx.fillStyle = '#000000';
      ctx.font = '800 13px ElmsSans, sans-serif';
      ctx.letterSpacing = '1px';
      ctx.fillText(day.name.toUpperCase(), 0, -8);

      ctx.font = day.isToday ? '800 13px ElmsSans, sans-serif' : '600 12px ElmsSans, sans-serif';
      ctx.letterSpacing = '0px';
      ctx.fillStyle = day.isToday ? '#000000' : '#6b7280';
      ctx.fillText(String(day.date.getDate()), 0, 9);
      ctx.restore();
    });

    // Closing divider past the last lane
    const lastAlong = this.dayToCross(this.state.days.length) - offset;
    if (lastAlong >= 0 && lastAlong <= length) {
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.8;
      const e1 = this.surfacePoint(surface, this.crisp(lastAlong, 1.8), 0);
      const e2 = this.surfacePoint(surface, this.crisp(lastAlong, 1.8), depth);
      ctx.beginPath();
      ctx.moveTo(e1.x, e1.y);
      ctx.lineTo(e2.x, e2.y);
      ctx.stroke();
    }

    // Border against the grid, along this surface's inner edge.
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    const edge = this.crisp(depth - 1, 2);
    const b1 = this.surfacePoint(surface, 0, edge);
    const b2 = this.surfacePoint(surface, length, edge);
    ctx.beginPath();
    ctx.moveTo(b1.x, b1.y);
    ctx.lineTo(b2.x, b2.y);
    ctx.stroke();

    ctx.restore();
  }


  destroy() {
    if (this._resizeObserver) this._resizeObserver.disconnect();
  }
}
