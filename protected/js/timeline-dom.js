// Klndr Timeline DOM Overlay Renderer
// Renders native interactive DOM cards, badges, checkboxes, handles, and tooltips
// over the canvas, plus two things the drag layer depends on:
//   - SEAM handles, where two blocks touch, for resizing the shared boundary
//   - a GHOST layer that previews what a drag is about to do to other blocks
//
// Touching blocks keep their own ordinary edge handles. The seam is an extra
// affordance layered on top: it stays out of sight until the pointer is right on
// the shared boundary, then pops in. Aim at the boundary and you move both
// blocks; aim a few pixels either side and you resize just that one.

class TimelineDOM {
  // Two boundaries within this many minutes of each other count as touching.
  static SEAM_TOLERANCE_MINUTES = 0.5;

  // Half-width, in pixels, of the zone around a shared boundary that summons the
  // seam handle. Deliberately narrower than the widened edge handles beside it,
  // so a block's own handle is always still reachable.
  static SEAM_ARM_RADIUS = 9;

  static TOOLTIP_DELAY_MS = 750;
  static TOOLTIP_DELAY_COLLAPSED_MS = 250;
  static TOOLTIP_CLOSE_GRACE_MS = 150;

  // Un-dimming is delayed so sweeping the pointer across a busy row does not
  // strobe the whole grid on and off.
  static FOCUS_EXIT_DELAY_MS = 100;

  // Focus arrives in stages: two pulses on the hovered block's family, then the
  // full dim. Nothing at all happens before the first, so moving the pointer
  // across the grid leaves the screen completely still.
  static FOCUS_FLASH_ONE_MS = 1000;
  static FOCUS_FLASH_TWO_MS = 2000;
  static FOCUS_DIM_MS = 3000;

  constructor(containerElement, canvasRenderer, state, onTaskInteraction) {
    this.container = containerElement;
    this.canvas = canvasRenderer;
    this.state = state;
    this.onTaskInteraction = onTaskInteraction;

    // Blocks and ghosts live in separate layers so a re-render of one does not
    // destroy the other mid-drag.
    this.blockLayer = document.createElement('div');
    this.blockLayer.className = 'timeline-block-layer';

    this.ghostLayer = document.createElement('div');
    this.ghostLayer.className = 'timeline-ghost-layer';

    this.container.innerHTML = '';
    this.container.appendChild(this.ghostLayer);
    this.container.appendChild(this.blockLayer);

    this.ghostPool = [];
    this.tooltipEl = null;

    this.seamRecords = [];
    this.armedSeam = null;
    // Set by the drag controller. Asking it directly beats latching a flag on
    // drag start: however a drag ends, arming recovers on its own.
    this.isDragActive = () => false;

    this.focusedSegmentId = null;
    this._focusExitTimer = null;
    this._focusStageTimers = [];
    this._tooltipTimer = null;
    this._tooltipOpen = false;
    this._tooltipCloseTimer = null;

    this.initTooltip();
    this.initSeamArming();
    this.initFocusHighlight();
  }

  static getCategoryIconElement(iconName) {
    const icon = iconName || 'task_alt';
    return `<span class="material-symbols-outlined task-icon-symbol">${icon}</span>`;
  }

  // Blocks shrink with their duration and the zoom level. Rather than clipping
  // every element at once, drop them in order of least importance.
  // Named for what it measures: room along the axis the text reads across,
  // which is the MAIN axis - duration - in both orientations. See buildCard.
  static sizeClassForWidth(width) {
    if (width >= 160) return 'is-lg';
    if (width >= 104) return 'is-md';
    if (width >= 60) return 'is-sm';
    if (width >= 30) return 'is-xs';
    return 'is-min';
  }


  // A block in one of these tiers cannot show its own title or time, so its
  // tooltip is the only way to read it -- that earns a shorter delay.
  static hidesContent(sizeClass, isShort) {
    return sizeClass === 'is-sm' || sizeClass === 'is-xs' || sizeClass === 'is-min' || isShort;
  }

  // ==========================================
  // TOOLTIP
  // ==========================================

  /**
   * Tooltips and the focus dim are hover affordances, and a tap synthesizes
   * mouseover - so without this gate they fire on touch, where a 750ms rest is
   * indistinguishable from the long press that starts a drag.
   */
  static isTouchInput() {
    return document.body.dataset.input === 'touch';
  }

  initTooltip() {
    this.tooltipEl = document.createElement('div');
    this.tooltipEl.className = 'timeline-tooltip';
    this.tooltipEl.style.display = 'none';
    document.body.appendChild(this.tooltipEl);

    // Delegated so the listener count does not scale with the number of blocks.
    this.blockLayer.addEventListener('mouseover', (e) => {
      if (TimelineDOM.isTouchInput()) return;
      const card = e.target.closest('.timeline-task-card[data-tip-title]');
      if (!card || card.classList.contains('is-dragging')) return;
      this.queueTooltip(card);
    });

    this.blockLayer.addEventListener('mouseout', (e) => {
      const card = e.target.closest('.timeline-task-card');
      if (!card) return;
      if (e.relatedTarget && card.contains(e.relatedTarget)) return;
      this.queueTooltipClose();
    });
  }

  /**
   * A block that already shows its title and time gets the full delay — the
   * tooltip is supplementary there. A block too small to read gets a short one,
   * because the tooltip is the only way to read it at all.
   *
   * Once a tooltip is open, moving to another block switches almost instantly:
   * paying the full delay per block makes scanning a row feel broken.
   */
  queueTooltip(card) {
    clearTimeout(this._tooltipTimer);
    clearTimeout(this._tooltipCloseTimer);

    if (this._tooltipOpen) {
      this.showTooltip(card);
      return;
    }

    const delay = card.dataset.tipCollapsed === 'true'
      ? TimelineDOM.TOOLTIP_DELAY_COLLAPSED_MS
      : TimelineDOM.TOOLTIP_DELAY_MS;

    this._tooltipTimer = setTimeout(() => {
      if (!card.isConnected) return;
      this._tooltipOpen = true;
      this.showTooltip(card);
    }, delay);
  }

  // A short grace so travelling between two blocks does not re-arm the full
  // delay, and does not flicker the card closed on the way.
  queueTooltipClose() {
    clearTimeout(this._tooltipTimer);
    clearTimeout(this._tooltipCloseTimer);
    this._tooltipCloseTimer = setTimeout(() => this.hideTooltip(), TimelineDOM.TOOLTIP_CLOSE_GRACE_MS);
  }

  showTooltip(card) {
    const tip = this.tooltipEl;
    tip.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'timeline-tooltip-title';
    title.textContent = card.dataset.tipTitle;
    tip.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'timeline-tooltip-meta';
    meta.textContent = card.dataset.tipMeta;
    tip.appendChild(meta);

    if (card.dataset.tipSession) {
      const session = document.createElement('div');
      session.className = 'timeline-tooltip-session';
      session.textContent = card.dataset.tipSession;
      tip.appendChild(session);
    }

    if (card.dataset.tipCategory) {
      const cat = document.createElement('div');
      cat.className = 'timeline-tooltip-category';
      cat.textContent = card.dataset.tipCategory;
      tip.appendChild(cat);
    }

    tip.style.setProperty('--tip-accent', card.dataset.tipColor || '#9ae659');
    tip.style.display = 'block';
    tip.style.visibility = 'hidden';

    // Prefer sitting above the block, and never let it leave the window.
    const cardRect = card.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const margin = 8;

    let left = cardRect.left + cardRect.width / 2 - tipRect.width / 2;
    left = Math.max(margin, Math.min(window.innerWidth - tipRect.width - margin, left));

    let top = cardRect.top - tipRect.height - 10;
    tip.classList.toggle('is-below', top < margin);
    if (top < margin) top = cardRect.bottom + 10;

    // At phone width the context menu is a sheet across the bottom of the
    // screen, and "below the block" for a block low in the day means behind it.
    // Whatever the block's own position wanted, the tooltip goes above the
    // sheet - it is there to be read alongside it.
    const sheet = document.querySelector('.context-menu.active');
    if (sheet) {
      const sheetRect = sheet.getBoundingClientRect();
      if (sheetRect.height && top + tipRect.height > sheetRect.top - 6) {
        top = Math.max(margin, sheetRect.top - tipRect.height - 10);
        tip.classList.toggle('is-below', top >= cardRect.bottom);
      }
    }

    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.style.visibility = 'visible';
  }

  /**
   * Hold the tooltip open until something explicitly lets it go.
   *
   * A long press on Android raises the OS callout at about 500ms, which this
   * app answers with its own context menu - and everything that follows from
   * that was closing the tooltip the press had just opened at 400ms: the menu's
   * own handler, then closeAllModals, then endDrag when the finger came up. The
   * tooltip was correct for about a tenth of a second.
   *
   * Pinning it is better than teaching each of those three not to fire. They
   * are all right to close a HOVER tooltip; what they are wrong about is
   * closing one that is deliberately part of the open menu.
   */
  pinTooltip(card) {
    if (!card || !card.dataset.tipTitle) return;
    this._tooltipPinned = true;
    this.showTooltip(card);
  }

  unpinTooltip() {
    if (!this._tooltipPinned) return;
    this._tooltipPinned = false;
    this.hideTooltip();
  }

  hideTooltip() {
    clearTimeout(this._tooltipTimer);
    clearTimeout(this._tooltipCloseTimer);
    // A pinned tooltip belongs to whatever pinned it, and only that thing may
    // take it away - see unpinTooltip, which closeAllModals calls.
    if (this._tooltipPinned) return;
    this._tooltipOpen = false;
    if (this.tooltipEl) this.tooltipEl.style.display = 'none';
  }

  // ==========================================
  // SEAM ARMING
  // ==========================================

  // The workspace, not the overlay, carries the listener: the overlay is
  // pointer-events:none over the gaps between blocks, so tracking it alone would
  // lose the pointer the moment it left a card and the seam would never retract.
  initSeamArming() {
    const workspace = document.getElementById('timeline-workspace');
    if (!workspace) return;

    workspace.addEventListener('pointermove', (e) => {
      // Proximity arming is a mouse affordance: it needs a pointer that hovers
      // without pressing, which touch does not have. Touch gets every seam
      // armed up front instead - see .is-touch-input in the stylesheet.
      if (e.pointerType !== 'mouse') return;
      this.updateSeamArming(e.clientX, e.clientY);
    });
    workspace.addEventListener('pointerleave', () => {
      if (!this.isDragActive()) this.armSeam(null);
    });
  }

  // While a drag is in flight the armed seam is left exactly as it was: the one
  // being dragged must stay lit, and nothing else should arm under the pointer.
  updateSeamArming(clientX, clientY) {
    if (this.isDragActive() || !this.seamRecords.length) return;

    const { main, cross } = this.canvas.clientToLocal(clientX, clientY);

    const hit = this.seamRecords.find(seam =>
      Math.abs(main - seam.main) <= TimelineDOM.SEAM_ARM_RADIUS &&
      cross >= seam.crossStart && cross <= seam.crossEnd
    );

    this.armSeam(hit || null);
  }

  armSeam(seam) {
    if (this.armedSeam === seam) return;

    if (this.armedSeam) {
      this.armedSeam.el.classList.remove('is-armed');
      this.armedSeam.leftCard?.classList.remove('is-seam-partner');
      this.armedSeam.rightCard?.classList.remove('is-seam-partner');
    }

    this.armedSeam = seam;

    if (seam) {
      // Both blocks light up their grips alongside the seam, so the choice
      // between "move the boundary" and "resize one block" is visible at once.
      seam.el.classList.add('is-armed');
      seam.leftCard?.classList.add('is-seam-partner');
      seam.rightCard?.classList.add('is-seam-partner');
      this.hideTooltip();
    }
  }

  // ==========================================
  // FOCUS HIGHLIGHT + CONNECTOR WIRES
  // ==========================================

  initFocusHighlight() {
    this.blockLayer.addEventListener('mouseover', (e) => {
      if (TimelineDOM.isTouchInput()) return;
      const card = e.target.closest('.timeline-task-card');
      if (!card || this.isDragActive()) return;
      this.focusSegment(card);
    });

    this.blockLayer.addEventListener('mouseout', (e) => {
      const card = e.target.closest('.timeline-task-card');
      if (!card) return;
      if (e.relatedTarget && card.contains(e.relatedTarget)) return;
      this.queueFocusClear();
    });
  }

  /**
   * Hover focus is a slow burn, not an instant reaction. Sweeping the pointer
   * across a busy grid used to repaint half the screen on every card it crossed;
   * now nothing happens at all until the pointer has settled. Two short pulses
   * on the family announce that focus is coming, and only then does the rest of
   * the grid drop away.
   */
  focusSegment(card) {
    clearTimeout(this._focusExitTimer);
    const segmentId = card.dataset.segmentId;
    if (this.focusedSegmentId === segmentId) return;

    this.cancelFocusStages();
    this.focusedSegmentId = segmentId;

    // Only the family gets touched -- the rest of the grid dims from a single
    // class on the container, so a hover is never O(blocks) of class churn.
    (this._focusedEls || []).forEach(el => el.classList.remove('is-focus', 'is-sibling'));
    this._focusedEls = [];
    this.blockLayer.classList.remove('has-focus');

    const family = [...this.blockLayer.querySelectorAll(
      `.timeline-task-card[data-task-id="${card.dataset.taskId}"]`
    )];
    // Marked now, but inert: every focus style is gated behind `has-focus` on
    // the container, which does not arrive until the last stage.
    family.forEach(el => {
      el.classList.add(el.dataset.segmentId === segmentId ? 'is-focus' : 'is-sibling');
      this._focusedEls.push(el);
    });

    this._focusStageTimers = [
      setTimeout(() => this.flashFamily(), TimelineDOM.FOCUS_FLASH_ONE_MS),
      setTimeout(() => this.flashFamily(), TimelineDOM.FOCUS_FLASH_TWO_MS),
      setTimeout(() => this.blockLayer.classList.add('has-focus'), TimelineDOM.FOCUS_DIM_MS)
    ];
  }

  // A single dip-and-return on the family. The class has to come off, force a
  // reflow, and go back on for the animation to restart on the second pulse --
  // re-adding a class the element already carries replays nothing.
  flashFamily() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    (this._focusedEls || []).forEach(el => {
      el.classList.remove('is-focus-flash');
      void el.offsetWidth;
      el.classList.add('is-focus-flash');
    });
  }

  cancelFocusStages() {
    (this._focusStageTimers || []).forEach(clearTimeout);
    this._focusStageTimers = [];
    (this._focusedEls || []).forEach(el => el.classList.remove('is-focus-flash'));
  }

  queueFocusClear() {
    clearTimeout(this._focusExitTimer);
    this._focusExitTimer = setTimeout(() => this.clearFocus(), TimelineDOM.FOCUS_EXIT_DELAY_MS);
  }

  clearFocus() {
    clearTimeout(this._focusExitTimer);
    this.cancelFocusStages();
    this.focusedSegmentId = null;
    (this._focusedEls || []).forEach(el => el.classList.remove('is-focus', 'is-sibling'));
    this._focusedEls = [];
    this.blockLayer.classList.remove('has-focus');
  }

  // ==========================================
  // PLACEMENT
  // ==========================================

  // Flatten scheduled task segments into positioned placements for the visible
  // week, then mark the pairs that share a boundary.
  computePlacements() {
    const tasks = this.state.tasks || [];
    const days = this.state.days || [];
    const placements = [];

    tasks.forEach(task => {
      const segments = TaskModel.ensureSegments(task);
      if (!segments.length) return;

      segments.forEach((segment, segIdx) => {
        const segDate = new Date(segment.start_time * 1000);
        const dayIdx = days.findIndex(d =>
          d.date.getFullYear() === segDate.getFullYear() &&
          d.date.getMonth() === segDate.getMonth() &&
          d.date.getDate() === segDate.getDate()
        );
        if (dayIdx === -1) return;

        const startMin = (segment.start_time - days[dayIdx].startTimestamp) / 60;
        placements.push({
          task,
          segment,
          // Positional, in time order across the whole task — this is what the
          // pill shows, so splitting renumbers everything after the cut.
          segIdx,
          segTotal: segments.length,
          dayIdx,
          startMin,
          endMin: startMin + segment.duration,
          duration: segment.duration,
          hasLeftSeam: false,
          hasRightSeam: false
        });
      });
    });

    // Seam detection, per day, in chronological order.
    const byDay = new Map();
    placements.forEach(p => {
      if (!byDay.has(p.dayIdx)) byDay.set(p.dayIdx, []);
      byDay.get(p.dayIdx).push(p);
    });

    const seams = [];
    byDay.forEach((dayPlacements, dayIdx) => {
      dayPlacements.sort((a, b) => a.startMin - b.startMin);
      for (let i = 0; i < dayPlacements.length - 1; i++) {
        const a = dayPlacements[i];
        const b = dayPlacements[i + 1];
        if (Math.abs(a.endMin - b.startMin) > TimelineDOM.SEAM_TOLERANCE_MINUTES) continue;

        a.hasRightSeam = true;
        b.hasLeftSeam = true;
        seams.push({ dayIdx, boundaryMin: b.startMin, left: a, right: b });
      }
    });

    return { placements, seams };
  }

  // One line, and it is the whole reason transposing the timeline does not
  // touch buildCard or renderProjection: they consume {left,top,width,height}
  // and never learn which axis carried the time.
  geometryFor(placement) {
    return this.canvas.rectFor(placement.dayIdx, placement.startMin, placement.endMin, {
      crossInset: TimelineCanvas.LANE_INSET,
      minMain: TimelineCanvas.MIN_BLOCK_MAIN
    });
  }

  // ==========================================
  // RENDER
  // ==========================================

  render() {
    this.hideTooltip();
    this.clearFocus();
    this.armedSeam = null;
    this.seamRecords = [];
    this.blockLayer.innerHTML = '';

    const { placements, seams } = this.computePlacements();

    placements.forEach(p => {
      p.cardEl = this.buildCard(p);
      this.blockLayer.appendChild(p.cardEl);
    });

    seams.forEach(seam => {
      const el = this.buildSeamHandle(seam);
      this.blockLayer.appendChild(el);

      const rect = this.canvas.seamRectFor(seam.dayIdx, seam.boundaryMin);
      this.seamRecords.push({
        el,
        main: rect.main,
        crossStart: rect.crossStart,
        crossEnd: rect.crossEnd,
        leftCard: seam.left.cardEl,
        rightCard: seam.right.cardEl
      });
    });
  }

  buildCard(placement) {
    const { task, segment, segIdx, segTotal, duration } = placement;
    const geo = this.geometryFor(placement);

    const isSplit = segTotal > 1;
    const startLabel = this.canvas.formatTimeLabel(placement.startMin);
    const endLabel = this.canvas.formatTimeLabel(placement.endMin);
    // The tier measures the MAIN axis - the one time runs along - and the short
    // test measures the CROSS axis. Horizontally that is width and height, which
    // is what this has always done; vertically the two swap over.
    //
    // Getting this the wrong way round is what made vertical blocks unusable.
    // The tier ladder exists to shrink a block's chrome as the block shrinks,
    // and vertically it was reading the COLUMN - a function of the day count
    // that never changes with duration - so the chrome never shrank. An 80px
    // block spent 74px of itself on padding and showed nothing at all.
    const mainSize = this.canvas.mainIsX ? geo.width : geo.height;
    const crossSize = this.canvas.mainIsX ? geo.height : geo.width;
    const sizeClass = TimelineDOM.sizeClassForWidth(mainSize);
    const isShort = crossSize < 58;
    const collapsed = TimelineDOM.hidesContent(sizeClass, isShort);

    const card = document.createElement('div');
    card.className = [
      'timeline-task-card',
      sizeClass,
      isShort ? 'is-short' : '',
      // Completion is per block now: one chunk of a split can be done while its
      // siblings are not.
      segment.completed ? 'is-completed' : '',
      isSplit ? 'is-split' : '',
      placement.hasLeftSeam ? 'has-seam-left' : '',
      placement.hasRightSeam ? 'has-seam-right' : ''
    ].filter(Boolean).join(' ');

    card.dataset.taskId = task.id;
    card.dataset.segmentId = segment.id;
    card.dataset.segmentIndex = segIdx;
    card.style.left = `${geo.left}px`;
    card.style.top = `${geo.top}px`;
    card.style.width = `${geo.width}px`;
    card.style.height = `${geo.height}px`;
    KlndrTheme.paint(card, task.color || '#9ae659');

    card.dataset.tipTitle = task.title || 'Untitled Task';
    card.dataset.tipMeta = `${startLabel} – ${endLabel} · ${duration}m`;
    card.dataset.tipColor = task.color || '#9ae659';
    card.dataset.tipCollapsed = String(collapsed);
    if (isSplit) card.dataset.tipSession = `Block ${segIdx + 1} of ${segTotal} · ${task.total_duration}m total`;
    if (task.category) card.dataset.tipCategory = task.category;

    const badge = document.createElement('div');
    badge.className = 'task-badge-circle';
    badge.innerHTML = TimelineDOM.getCategoryIconElement(task.icon);
    card.appendChild(badge);

    card.appendChild(this.buildPill(task, segment, segIdx, segTotal));

    const content = document.createElement('div');
    content.className = 'task-content-inner';

    // Above the title, in the tooltip's own category style. An imported title
    // like "M3 S1" says which session but not which subject, and the block's
    // colour only says it once you know the palette.
    if (task.category) {
      const categoryEl = document.createElement('div');
      categoryEl.className = 'task-category-text';
      categoryEl.textContent = task.category;
      content.appendChild(categoryEl);
    }

    const titleEl = document.createElement('div');
    titleEl.className = 'task-title-text';
    titleEl.textContent = task.title || 'Untitled Task';
    content.appendChild(titleEl);

    // Three spans, not one string. A column is under 50px of text, and left to
    // wrap freely "11:00 AM - 1:30 PM (150m)" breaks mid-clock: the first line
    // reads "11:00" with no meridiem on it. Split at the joins the eye already
    // uses and the vertical stylesheet can give each part its own line, while a
    // horizontal block still reads all three as one sentence.
    const metaEl = document.createElement('div');
    metaEl.className = 'task-meta-text';
    for (const [cls, text] of [
      ['task-meta-start', startLabel],
      ['task-meta-end', ` - ${endLabel}`],
      ['task-meta-dur', ` (${duration}m)`]
    ]) {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      metaEl.appendChild(span);
    }
    content.appendChild(metaEl);

    card.appendChild(content);

    // Edge handles sit INSIDE the block, and every block keeps both of them —
    // including at a shared boundary, where resizing this block alone stays a
    // normal, always-available gesture.
    card.appendChild(TimelineDOM.buildEdgeHandle('left'));
    card.appendChild(TimelineDOM.buildEdgeHandle('right'));

    // No category name carries behaviour any more. This used to exempt a
    // category literally called "Break"; categories are the person's now and
    // klndr ships none, so that rule would have to be a property on the
    // category record rather than a name match.
    if (task.is_locked !== false && !isSplit) {
      const lockPill = document.createElement('div');
      lockPill.className = 'task-lock-indicator';
      lockPill.innerHTML = '<span class="material-symbols-outlined" style="font-size: 13px; color: var(--on-color-ink);">lock</span>';
      card.appendChild(lockPill);
    }

    card.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.onTaskInteraction('openEditModal', { task });
    });

    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // A mouse has hover, so the tooltip has already had its turn and the menu
      // is landing right on top of the pointer. A finger has neither: this
      // gesture is the only way to read a block too small to print its own
      // title, so the tooltip comes WITH the menu. Pinned after the menu opens,
      // never before - openContextMenu runs closeAllModals on its way in, and
      // that is exactly what unpins.
      const withTip = TimelineDOM.isTouchInput();
      if (!withTip) this.hideTooltip();
      this.onTaskInteraction('openContextMenu', {
        task,
        segmentId: segment.id,
        // Captured HERE, while the pointer is still over the cut point. It will
        // have moved to the menu by the time anything is clicked.
        splitTimestamp: this.timestampAtPoint(e.clientX, e.clientY, placement.dayIdx),
        clientX: e.clientX,
        clientY: e.clientY
      });
      // Now that the menu is up and has finished unpinning whatever came
      // before. Pinning is what carries the tooltip past the finger coming off
      // the glass, which ends the drag this press also armed - and endDrag
      // closes tooltips.
      if (withTip) this.pinTooltip(card);
    });

    return card;
  }

  timestampAtPoint(clientX, clientY, dayIdx) {
    const day = (this.state.days || [])[dayIdx];
    if (!day) return null;
    const { main } = this.canvas.clientToLocal(clientX, clientY);
    return day.startTimestamp + this.canvas.mainToTime(main) * 60;
  }

  /**
   * One control carrying two signals: the shape says whether this block belongs
   * to a split (capsule) or stands alone (square), and the fill says whether it
   * is done. Fusing them means they never compete for the same pixels on a
   * narrow block — which they would as two separate controls.
   */
  buildPill(task, segment, segIdx, segTotal) {
    const isSplit = segTotal > 1;
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = [
      'segment-pill',
      isSplit ? 'is-segment' : 'is-single',
      segment.completed ? 'is-done' : ''
    ].filter(Boolean).join(' ');

    if (isSplit) {
      const label = document.createElement('span');
      label.className = 'segment-pill-label';
      // Two spans so the denominator can be dropped on its own. "1/2" at 9px in
      // a 16px square is three glyphs where there is room for one, and which
      // block you are looking at is the half that carries the information -
      // how many there are in total is on the tooltip and in the editor.
      const idx = document.createElement('span');
      idx.className = 'segment-pill-index';
      idx.textContent = String(segIdx + 1);
      const total = document.createElement('span');
      total.className = 'segment-pill-total';
      total.textContent = `/${segTotal}`;
      label.append(idx, total);
      pill.appendChild(label);
      pill.setAttribute('aria-label',
        `Block ${segIdx + 1} of ${segTotal}, ${segment.completed ? 'done' : 'not done'}`);
    } else {
      pill.innerHTML = '<span class="material-symbols-outlined segment-pill-check">check</span>';
      pill.setAttribute('aria-label', segment.completed ? 'Mark not done' : 'Mark done');
    }

    // Must swallow its own pointer events: on a narrow block the pill covers
    // most of the surface, and a missed click would start a drag instead.
    // pointerdown, not mousedown - drags now begin on the pointer event, and a
    // mousedown guard would arrive after the drag it was meant to prevent.
    pill.addEventListener('pointerdown', (e) => e.stopPropagation());
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onTaskInteraction('toggleSegmentComplete', {
        taskId: task.id,
        segmentId: segment.id,
        completed: !segment.completed
      });
    });

    return pill;
  }

  static buildEdgeHandle(side) {
    const handle = document.createElement('div');
    handle.className = `resize-handle resize-handle-${side}`;
    handle.dataset.handle = side;
    // No native title: the ew-resize cursor and the grip already say what this
    // does, and an OS tooltip here would fight the styled one on the block.

    const grip = document.createElement('span');
    grip.className = 'resize-handle-grip';
    handle.appendChild(grip);
    return handle;
  }

  buildSeamHandle(seam) {
    const el = document.createElement('div');
    el.className = 'timeline-seam-handle';
    el.dataset.seam = 'true';
    el.dataset.leftTaskId = seam.left.task.id;
    el.dataset.leftSegmentId = seam.left.segment.id;
    el.dataset.rightTaskId = seam.right.task.id;
    el.dataset.rightSegmentId = seam.right.segment.id;
    el.dataset.dayIndex = seam.dayIdx;

    const rect = this.canvas.seamRectFor(seam.dayIdx, seam.boundaryMin);
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    // Which property runs across the lane depends on the orientation; the CSS
    // translate that centres the handle on the boundary follows the same rule.
    el.style[rect.crossProp] = `${rect.crossSize}px`;

    const grip = document.createElement('span');
    grip.className = 'seam-grip';
    el.appendChild(grip);
    return el;
  }

  // ==========================================
  // PROJECTION GHOSTS
  // ==========================================

  /**
   * Draw where the in-flight drag is about to leave every affected block.
   * `updates` is the same shape the drag commits, so the preview cannot drift
   * from the result. Segments already moved live in the DOM are skipped, so only
   * the knock-on effects the user has not seen yet get a ghost.
   */
  renderProjection(updates, options = {}) {
    const activeTaskId = options.activeTaskId || null;
    const days = this.state.days || [];
    let ghostIndex = 0;
    const supersededTaskIds = new Set();

    (updates || []).forEach(update => {
      const task = (this.state.tasks || []).find(t => t.id === update.id);
      if (!task) return;

      (update.start_times || []).forEach((st, segIdx) => {
        const dur = update.durations[segIdx] || 60;
        const segId = (update.segments || [])[segIdx]?.id;
        const segDate = new Date(st * 1000);
        const dayIdx = days.findIndex(d =>
          d.date.getFullYear() === segDate.getFullYear() &&
          d.date.getMonth() === segDate.getMonth() &&
          d.date.getDate() === segDate.getDate()
        );
        if (dayIdx === -1) return;

        const startMin = (st - days[dayIdx].startTimestamp) / 60;
        const geo = this.geometryFor({ startMin, endMin: startMin + dur, dayIdx });

        // If a card is already sitting exactly here, the user can see it; no ghost.
        // Matched by segment id, not position: an outcome that splits a block
        // renumbers everything after it, and index matching would then compare
        // each piece against the wrong card.
        const card = segId
          ? this.blockLayer.querySelector(`.timeline-task-card[data-segment-id="${segId}"]`)
          : this.blockLayer.querySelector(
              `.timeline-task-card[data-task-id="${update.id}"][data-segment-index="${segIdx}"]`
            );
        if (card &&
            Math.abs(parseFloat(card.style.left) - geo.left) < 0.5 &&
            Math.abs(parseFloat(card.style.width) - geo.width) < 0.5 &&
            Math.abs(parseFloat(card.style.top) - geo.top) < 0.5) {
          return;
        }

        if (update.id !== activeTaskId) supersededTaskIds.add(update.id);

        const ghost = this.acquireGhost(ghostIndex++);
        ghost.style.left = `${geo.left}px`;
        ghost.style.top = `${geo.top}px`;
        ghost.style.width = `${geo.width}px`;
        ghost.style.height = `${geo.height}px`;
        KlndrTheme.paint(ghost, task.color || '#9ae659');
        ghost.classList.toggle('is-active-task', update.id === activeTaskId);

        const label = ghost.firstChild;
        label.textContent = geo.width >= 96
          ? `${this.canvas.formatTimeLabel(startMin)} · ${dur}m`
          : `${dur}m`;
        label.style.display = geo.width >= 40 ? 'block' : 'none';
      });
    });

    // Release any ghosts left over from the previous frame.
    for (let i = ghostIndex; i < this.ghostPool.length; i++) {
      this.ghostPool[i].style.display = 'none';
    }

    // Fade the blocks whose ghost now represents them.
    this.blockLayer.querySelectorAll('.timeline-task-card').forEach(card => {
      card.classList.toggle('is-superseded', supersededTaskIds.has(card.dataset.taskId));
    });

    this.blockLayer.classList.toggle('has-projection', ghostIndex > 0);
    return ghostIndex;
  }

  acquireGhost(index) {
    let ghost = this.ghostPool[index];
    if (!ghost) {
      ghost = document.createElement('div');
      ghost.className = 'timeline-ghost-block';
      const label = document.createElement('div');
      label.className = 'timeline-ghost-label';
      ghost.appendChild(label);
      this.ghostLayer.appendChild(ghost);
      this.ghostPool[index] = ghost;
    }
    ghost.style.display = 'block';
    return ghost;
  }

  // Point at a block that just appeared somewhere the eye was not looking.
  // Reuses the focus flash rather than inventing a second highlight.
  flashTask(taskId) {
    this.blockLayer.querySelectorAll(`.timeline-task-card[data-task-id="${taskId}"]`)
      .forEach(el => {
        el.classList.remove('is-focus-flash');
        // Reading offsetWidth restarts the animation; without it a second flash
        // on the same element does nothing at all.
        void el.offsetWidth;
        el.classList.add('is-focus-flash');
      });
  }

  clearProjection() {
    this.ghostPool.forEach(g => { g.style.display = 'none'; });
    this.blockLayer.querySelectorAll('.is-superseded').forEach(c => c.classList.remove('is-superseded'));
    this.blockLayer.classList.remove('has-projection');
  }
}
