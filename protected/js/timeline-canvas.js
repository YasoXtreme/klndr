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

    this.headerHeight = 56;   // ruler surface height
    this.dayHeaderWidth = 60; // gutter surface width
    this.dpr = window.devicePixelRatio || 1;

    // Horizontal zoom. 1 = the full 24h fits the viewport with no scrolling.
    this.zoom = this.readStoredZoom();

    this.isShiftMode = false;
    this.hoverPlayheadX = null;
    this.snapGuideX = null;

    this._rafId = null;
    this._chromeRafId = null;
    this._layoutRafId = null;

    this.scrollContainer.addEventListener('scroll', () => this.requestChromeRender(), { passive: true });
    this.scrollContainer.addEventListener('wheel', (e) => this.handleWheel(e), { passive: false });

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

  readStoredZoom() {
    try {
      const raw = parseFloat(localStorage.getItem(TimelineCanvas.ZOOM_STORAGE_KEY));
      if (Number.isFinite(raw)) return this.clampZoom(raw);
    } catch (e) { /* storage unavailable */ }
    return 1;
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

  setPlayhead(x) {
    if (this.hoverPlayheadX !== x) {
      this.hoverPlayheadX = x;
      this.requestRender();
    }
  }

  setSnapGuide(x) {
    if (this.snapGuideX !== x) {
      this.snapGuideX = x;
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
      window.devicePixelRatio || 1
    ].join('|');
  }

  // Coalesce ResizeObserver bursts (a CSS transition fires many) into one relayout,
  // and ignore observations that do not actually change the geometry — a relayout
  // can toggle a scrollbar, which would otherwise feed back into the observer.
  requestLayout() {
    if (this._layoutRafId) return;
    this._layoutRafId = requestAnimationFrame(() => {
      this._layoutRafId = null;
      if (this.layoutKey() === this._lastLayoutKey) return;
      this.resize();
    });
  }

  // ==========================================
  // ZOOM
  // ==========================================

  setZoom(nextZoom, anchorRatio = 0.5) {
    const clamped = this.clampZoom(nextZoom);
    if (clamped === this.zoom) return;

    // Keep the time under the anchor point pinned while the scale changes.
    const anchorX = this.scrollContainer.scrollLeft + this.availWidth * anchorRatio;
    const anchorMinutes = this.xToMinutes(anchorX);

    this.zoom = clamped;
    try {
      localStorage.setItem(TimelineCanvas.ZOOM_STORAGE_KEY, String(clamped));
    } catch (e) { /* storage unavailable */ }

    this.resize();
    this.scrollContainer.scrollLeft = Math.max(
      0,
      this.timeToX(anchorMinutes) - this.availWidth * anchorRatio
    );
    this.requestChromeRender();
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

    // With the whole week visible there is nothing to scroll vertically, so a
    // plain wheel would do nothing. Translate it onto the time axis instead.
    const canScrollY = this.scrollContainer.scrollHeight > this.scrollContainer.clientHeight + 1;
    const canScrollX = this.scrollContainer.scrollWidth > this.scrollContainer.clientWidth + 1;
    if (!canScrollY && canScrollX && e.deltaY !== 0 && e.deltaX === 0) {
      e.preventDefault();
      this.scrollContainer.scrollLeft += e.deltaY;
    }
  }

  // ==========================================
  // GEOMETRY
  // ==========================================

  resize() {
    this.dpr = window.devicePixelRatio || 1;
    this._lastLayoutKey = this.layoutKey();

    const numDays = Math.max(1, this.state.days.length);
    const sb = this.scrollbarSize;

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

    this.availWidth = availWidth;
    this.availHeight = availHeight;
    this.rulerWidth = boxWidth;
    this.gutterHeight = boxHeight;

    // Zoom 1 fits all 24h in the viewport, so the day is never partly off-screen
    // unless the user deliberately zooms in. Floor to whole pixels so an exact
    // fit cannot round into a one-pixel overflow and summon a scrollbar.
    this.totalTimelineWidth = Math.floor(availWidth * this.zoom);
    this.pxPerMinute = this.totalTimelineWidth / 1440;

    // The week is always whole: rows divide the viewport height, down to a floor.
    this.rowHeight = Math.max(
      TimelineCanvas.MIN_ROW_HEIGHT,
      Math.floor(availHeight / numDays)
    );

    this.width = this.totalTimelineWidth;
    this.height = numDays * this.rowHeight;

    this.sizeCanvas(this.canvas, this.ctx, this.width, this.height);
    this.sizeCanvas(this.rulerCanvas, this.rulerCtx, this.rulerWidth, this.headerHeight);
    this.sizeCanvas(this.gutterCanvas, this.gutterCtx, this.dayHeaderWidth, this.gutterHeight);

    if (this.domOverlay) {
      this.domOverlay.style.width = `${this.width}px`;
      this.domOverlay.style.height = `${this.height}px`;
    }

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

  get scrollLeft() { return this.scrollContainer.scrollLeft; }
  get scrollTop() { return this.scrollContainer.scrollTop; }

  // Minutes from day start (0-1440) -> body canvas X
  timeToX(minutesFromStart) {
    const ratio = Math.max(0, Math.min(1, minutesFromStart / 1440));
    return ratio * this.totalTimelineWidth;
  }

  // Body canvas X -> minutes from day start (0-1440)
  xToMinutes(x) {
    if (!this.totalTimelineWidth) return 0;
    const clampedX = Math.max(0, Math.min(this.totalTimelineWidth, x));
    return (clampedX / this.totalTimelineWidth) * 1440;
  }

  // Body canvas Y -> day row index
  yToDayIndex(y) {
    const idx = Math.floor(y / this.rowHeight);
    return Math.max(0, Math.min(this.state.days.length - 1, idx));
  }

  dayIndexToY(index) {
    return index * this.rowHeight;
  }

  scrollToTime(minutes, ratio = 0.5) {
    const target = this.timeToX(minutes) - this.scrollContainer.clientWidth * ratio;
    this.scrollContainer.scrollLeft = Math.max(0, target);
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

  renderChrome() {
    if (!this.rulerCtx || !this.gutterCtx || this.isCollapsed()) return;
    this.drawRuler();
    this.drawGutter();
  }

  renderBody() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    this.drawGrid(ctx);
    this.drawSplitBridges(ctx);
    this.drawNowLine(ctx);
    this.drawGuides(ctx);
  }

  // ==========================================
  // BODY: GRID
  // ==========================================

  drawGrid(ctx) {
    const bucketHours = this.state.bucketHours || 2;
    const numDays = this.state.days.length;
    const w = this.width;
    const h = this.height;

    ctx.save();

    // Today's row gets a tint so the current day is findable at a glance.
    this.state.days.forEach((day, index) => {
      if (!day.isToday) return;
      ctx.fillStyle = '#fbfff8';
      ctx.fillRect(0, this.dayIndexToY(index), w, this.rowHeight);
    });

    // Minor hour lines
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    for (let hour = 1; hour < 24; hour++) {
      if (hour % bucketHours === 0) continue;
      const x = this.crisp(this.timeToX(hour * 60), 1);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // Major bucket lines
    ctx.strokeStyle = '#9ca3af';
    ctx.lineWidth = 1.5;
    for (let hour = 0; hour <= 24; hour += bucketHours) {
      const x = this.crisp(this.timeToX(hour * 60), 1.5);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // Day row dividers
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.8;
    for (let i = 0; i <= numDays; i++) {
      const y = this.crisp(this.dayIndexToY(i), 1.8);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    ctx.restore();
  }

  drawNowLine(ctx) {
    const nowTs = Date.now() / 1000;
    const dayIndex = this.state.days.findIndex(
      day => nowTs >= day.startTimestamp && nowTs < day.startTimestamp + 86400
    );
    if (dayIndex === -1) return;

    const minutes = (nowTs - this.state.days[dayIndex].startTimestamp) / 60;
    const x = this.timeToX(minutes);
    const yTop = this.dayIndexToY(dayIndex);

    ctx.save();
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, yTop);
    ctx.lineTo(x, yTop + this.rowHeight);
    ctx.stroke();

    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(x, yTop + 5, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawSplitBridges(ctx) {
    if (!this.state.tasks) return;

    ctx.save();
    this.state.tasks.forEach(task => {
      if (!task.start_times || task.start_times.length < 2) return;

      for (let i = 0; i < task.start_times.length - 1; i++) {
        const st1 = task.start_times[i];
        const dur1 = task.durations[i] || 60;
        const et1 = st1 + dur1 * 60;
        const st2 = task.start_times[i + 1];

        const d1 = new Date(st1 * 1000);
        const dayIndex1 = this.state.days.findIndex(day =>
          day.date.getFullYear() === d1.getFullYear() &&
          day.date.getMonth() === d1.getMonth() &&
          day.date.getDate() === d1.getDate()
        );
        if (dayIndex1 === -1) continue;

        const dayStart1 = this.state.days[dayIndex1].startTimestamp;
        const x1 = this.timeToX((et1 - dayStart1) / 60);
        const x2 = this.timeToX((st2 - dayStart1) / 60);
        const y = this.dayIndexToY(dayIndex1) + this.rowHeight / 2;

        ctx.strokeStyle = task.color || '#9ae659';
        ctx.lineWidth = 3;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x1, y);
        ctx.quadraticCurveTo((x1 + x2) / 2, y + 24, x2, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });
    ctx.restore();
  }

  drawGuides(ctx) {
    ctx.save();

    if (this.snapGuideX !== null) {
      ctx.strokeStyle = '#16a34a';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(this.snapGuideX, 0);
      ctx.lineTo(this.snapGuideX, this.height);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (this.hoverPlayheadX !== null) {
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(this.hoverPlayheadX, 0);
      ctx.lineTo(this.hoverPlayheadX, this.height);
      ctx.stroke();
    }

    ctx.restore();
  }

  // ==========================================
  // FROZEN RULER (top)
  // ==========================================

  drawRuler() {
    const ctx = this.rulerCtx;
    const w = this.rulerWidth;
    const h = this.headerHeight;

    ctx.clearRect(0, 0, w, h);
    ctx.save();

    ctx.fillStyle = this.isShiftMode ? '#f2ffec' : '#ffffff';
    ctx.fillRect(0, 0, w, h);

    if (this.isShiftMode) {
      this.drawBucketRuler(ctx, w, h);
    } else {
      this.drawTickRuler(ctx, w, h);
    }

    // Bottom border closing the header off from the grid
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2.2;
    const borderY = this.crisp(h - 1.1, 2.2);
    ctx.beginPath();
    ctx.moveTo(0, borderY);
    ctx.lineTo(w, borderY);
    ctx.stroke();

    this.drawPlayheadChip(ctx, w, h);
    ctx.restore();
  }

  // Choose an hour step whose labels cannot collide at the current zoom.
  hourLabelStep(bucketHours) {
    const candidates = [1, 2, 3, 4, 6, 8, 12];
    const minSpacing = 44; // fits the shortest label form below
    const start = Math.max(1, bucketHours);
    for (const step of candidates) {
      if (step < start) continue;
      if (step * 60 * this.pxPerMinute >= minSpacing) return step;
    }
    return 12;
  }

  // Shorten the label form rather than dropping labels: keeping every other hour
  // marked matters more than spelling out ":00".
  hourLabelFormatter(spacing) {
    if (spacing >= 92) return (h) => this.formatHourLabel(h);
    if (spacing >= 52) return (h) => this.formatShortHourLabel(h);
    return (h) => this.formatCompactHourLabel(h);
  }

  drawTickRuler(ctx, w, h) {
    const bucketHours = this.state.bucketHours || 2;
    const tickPercent = this.state.tickPercent || 25;
    const tickMinutes = (bucketHours * 60) * (tickPercent / 100);
    const labelStep = this.hourLabelStep(bucketHours);

    const offset = this.scrollLeft;
    const baseline = h - 1;

    // Only walk the ticks that can actually be on screen.
    const step = Math.max(5, Math.min(15, tickMinutes));
    const firstMinute = Math.max(0, Math.floor(this.xToMinutes(offset) / step) * step);
    const lastMinute = Math.min(1440, this.xToMinutes(offset + w) + step);

    for (let m = firstMinute; m <= lastMinute; m += step) {
      const x = this.timeToX(m) - offset;
      if (x < -2 || x > w + 2) continue;

      const isHour = m % 60 === 0;
      ctx.beginPath();

      if (isHour) {
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 2;
        ctx.moveTo(this.crisp(x, 2), baseline - 18);
        ctx.lineTo(this.crisp(x, 2), baseline);
        ctx.stroke();
      } else if (m % 30 === 0) {
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1.4;
        ctx.moveTo(this.crisp(x, 1.4), baseline - 11);
        ctx.lineTo(this.crisp(x, 1.4), baseline);
        ctx.stroke();
      } else {
        ctx.strokeStyle = '#9ca3af';
        ctx.lineWidth = 1;
        ctx.moveTo(this.crisp(x, 1), baseline - 6);
        ctx.lineTo(this.crisp(x, 1), baseline);
        ctx.stroke();
      }
    }

    // Hour labels, on their own pass so ticks never overdraw them.
    ctx.fillStyle = '#000000';
    ctx.font = '700 12px ElmsSans, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const format = this.hourLabelFormatter(labelStep * 60 * this.pxPerMinute);

    for (let hour = 0; hour <= 24; hour += labelStep) {
      const x = this.timeToX(hour * 60) - offset;
      if (x < -50 || x > w + 50) continue;

      // Nudge the first and last labels inward so midnight is not sliced in half
      // against the gutter or the pane edge.
      const label = format(hour);
      const half = ctx.measureText(label).width / 2 + 3;
      ctx.fillText(label, Math.max(half, Math.min(w - half, x)), 18);
    }
  }

  drawBucketRuler(ctx, w, h) {
    const bucketHours = this.state.bucketHours || 2;
    const offset = this.scrollLeft;
    const bucketPx = bucketHours * 60 * this.pxPerMinute;
    const compact = bucketPx < 96;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let hour = 0; hour < 24; hour += bucketHours) {
      const x1 = this.timeToX(hour * 60) - offset;
      const x2 = this.timeToX((hour + bucketHours) * 60) - offset;
      if (x2 < -4 || x1 > w + 4) continue;

      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(this.crisp(x1, 1.5), 0);
      ctx.lineTo(this.crisp(x1, 1.5), h);
      ctx.stroke();

      const centerX = x1 + (x2 - x1) / 2;
      ctx.fillStyle = '#000000';

      if (compact) {
        ctx.font = '700 11px ElmsSans, sans-serif';
        ctx.fillText(
          `${this.formatCompactHourLabel(hour)}-${this.formatCompactHourLabel(hour + bucketHours)}`,
          centerX,
          h / 2
        );
      } else {
        ctx.font = '700 12px ElmsSans, sans-serif';
        ctx.fillText(this.formatHourLabel(hour), centerX, h / 2 - 9);
        ctx.fillText(`→ ${this.formatHourLabel(hour + bucketHours)}`, centerX, h / 2 + 9);
      }
    }
  }

  drawPlayheadChip(ctx, w, h) {
    if (this.hoverPlayheadX === null) return;

    const x = this.hoverPlayheadX - this.scrollLeft;
    if (x < 0 || x > w) return;

    const timeStr = this.formatTimeLabel(this.xToMinutes(this.hoverPlayheadX));
    const chipW = 68;
    const chipX = Math.max(1, Math.min(w - chipW - 1, x - chipW / 2));

    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.roundRect(chipX, h - 25, chipW, 20, 4);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 11px ElmsSans, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(timeStr, chipX + chipW / 2, h - 15);
  }

  // ==========================================
  // FROZEN GUTTER (left)
  // ==========================================

  drawGutter() {
    const ctx = this.gutterCtx;
    const w = this.dayHeaderWidth;
    const h = this.gutterHeight;
    const offset = this.scrollTop;

    ctx.clearRect(0, 0, w, h);
    ctx.save();

    // The gutter surface spans the whole scroll viewport, but the day column only
    // covers the rows; below them it should match the empty grid, not the gutter.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#f9fafb';
    ctx.fillRect(0, -offset, w, this.height);

    this.state.days.forEach((day, index) => {
      const y = this.dayIndexToY(index) - offset;
      if (y + this.rowHeight < 0 || y > h) return;

      if (day.isToday) {
        ctx.fillStyle = '#e6fbd8';
        ctx.fillRect(0, y, w, this.rowHeight);
      }

      // Row divider
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(0, this.crisp(y, 1.8));
      ctx.lineTo(w, this.crisp(y, 1.8));
      ctx.stroke();

      const centerY = y + this.rowHeight / 2;

      ctx.save();
      ctx.translate(w / 2, centerY);
      ctx.rotate(-Math.PI / 2);
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

    // Closing divider under the last row
    const lastY = this.dayIndexToY(this.state.days.length) - offset;
    if (lastY >= 0 && lastY <= h) {
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(0, this.crisp(lastY, 1.8));
      ctx.lineTo(w, this.crisp(lastY, 1.8));
      ctx.stroke();
    }

    // Right border against the grid
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(this.crisp(w - 1, 2), 0);
    ctx.lineTo(this.crisp(w - 1, 2), h);
    ctx.stroke();

    ctx.restore();
  }

  destroy() {
    if (this._resizeObserver) this._resizeObserver.disconnect();
  }
}
