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

    // Connector wires are drawn ABOVE the blocks. The old bridges lived on the
    // body canvas, underneath, so any block sitting between two halves hid the
    // link by construction. SVG shares the block layer's coordinate space and
    // scrolls with it for free.
    this.wireLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.wireLayer.setAttribute('class', 'timeline-wire-layer');

    this.container.innerHTML = '';
    this.container.appendChild(this.ghostLayer);
    this.container.appendChild(this.blockLayer);
    this.container.appendChild(this.wireLayer);

    this.ghostPool = [];
    this.tooltipEl = null;

    this.seamRecords = [];
    this.armedSeam = null;
    // Set by the drag controller. Asking it directly beats latching a flag on
    // drag start: however a drag ends, arming recovers on its own.
    this.isDragActive = () => false;

    this.focusedSegmentId = null;
    this._focusExitTimer = null;
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

  initTooltip() {
    this.tooltipEl = document.createElement('div');
    this.tooltipEl.className = 'timeline-tooltip';
    this.tooltipEl.style.display = 'none';
    document.body.appendChild(this.tooltipEl);

    // Delegated so the listener count does not scale with the number of blocks.
    this.blockLayer.addEventListener('mouseover', (e) => {
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

    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.style.visibility = 'visible';
  }

  hideTooltip() {
    clearTimeout(this._tooltipTimer);
    clearTimeout(this._tooltipCloseTimer);
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

    workspace.addEventListener('mousemove', (e) => this.updateSeamArming(e.clientX, e.clientY));
    workspace.addEventListener('mouseleave', () => {
      if (!this.isDragActive()) this.armSeam(null);
    });
  }

  // While a drag is in flight the armed seam is left exactly as it was: the one
  // being dragged must stay lit, and nothing else should arm under the pointer.
  updateSeamArming(clientX, clientY) {
    if (this.isDragActive() || !this.seamRecords.length) return;

    const rect = this.canvas.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const hit = this.seamRecords.find(seam =>
      Math.abs(x - seam.boundaryX) <= TimelineDOM.SEAM_ARM_RADIUS &&
      y >= seam.top && y <= seam.bottom
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

  focusSegment(card) {
    clearTimeout(this._focusExitTimer);
    const segmentId = card.dataset.segmentId;
    if (this.focusedSegmentId === segmentId) return;

    this.focusedSegmentId = segmentId;

    // Only the family gets touched -- the rest of the grid dims from a single
    // class on the container, so a hover is never O(blocks) of class churn.
    (this._focusedEls || []).forEach(el => el.classList.remove('is-focus', 'is-sibling'));
    this._focusedEls = [];

    const family = [...this.blockLayer.querySelectorAll(
      `.timeline-task-card[data-task-id="${card.dataset.taskId}"]`
    )];
    family.forEach(el => {
      el.classList.add(el.dataset.segmentId === segmentId ? 'is-focus' : 'is-sibling');
      this._focusedEls.push(el);
    });

    this.blockLayer.classList.add('has-focus');
    this.drawWires(card.dataset.taskId);
  }

  queueFocusClear() {
    clearTimeout(this._focusExitTimer);
    this._focusExitTimer = setTimeout(() => this.clearFocus(), TimelineDOM.FOCUS_EXIT_DELAY_MS);
  }

  clearFocus() {
    clearTimeout(this._focusExitTimer);
    this.focusedSegmentId = null;
    (this._focusedEls || []).forEach(el => el.classList.remove('is-focus', 'is-sibling'));
    this._focusedEls = [];
    this.blockLayer.classList.remove('has-focus');
    this.clearWires();
  }

  clearWires() {
    while (this.wireLayer.firstChild) this.wireLayer.removeChild(this.wireLayer.firstChild);
  }

  /**
   * Route a wire between consecutive blocks of one task, dropping into the 5px
   * band below the cards that is always free of blocks. Because wires only ever
   * draw for the one family under the pointer, there is never more than one in a
   * row -- which is what makes the lane workable at all.
   */
  drawWires(taskId) {
    this.clearWires();

    const task = (this.state.tasks || []).find(t => t.id === taskId);
    if (!task || !TaskModel.isSplit(task)) return;

    const cards = new Map();
    this.blockLayer
      .querySelectorAll(`.timeline-task-card[data-task-id="${taskId}"]`)
      .forEach(el => cards.set(el.dataset.segmentId, el));

    const segments = task.segments || [];
    const color = task.color || '#9ae659';

    for (let i = 0; i < segments.length - 1; i++) {
      const a = cards.get(segments[i].id);
      const b = cards.get(segments[i + 1].id);
      if (!a || !b) continue;

      const aTop = parseFloat(a.style.top);
      const bTop = parseFloat(b.style.top);

      // Different rows: a wire would have to cut vertically through other days'
      // blocks, so point at the sibling instead of drawing to it.
      if (Math.abs(aTop - bTop) > 1) {
        this.drawCrossDayMarker(a, b, segments[i + 1], color);
        continue;
      }

      const bottom = aTop + parseFloat(a.style.height);
      const lane = bottom + 2.5;
      const ax = parseFloat(a.style.left) + parseFloat(a.style.width) - 7;
      const bx = parseFloat(b.style.left) + 7;
      if (bx - ax < 4) continue;

      const d = `M ${ax} ${bottom - 5} L ${ax} ${lane - 3} Q ${ax} ${lane} ${ax + 5} ${lane}` +
                ` L ${bx - 5} ${lane} Q ${bx} ${lane} ${bx} ${lane - 3} L ${bx} ${bottom - 5}`;

      this.wireLayer.appendChild(TimelineDOM.wirePath(d, '#ffffff', 6));
      this.wireLayer.appendChild(TimelineDOM.wirePath(d, color, 2.6));
    }
  }

  static wirePath(d, stroke, width) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', stroke);
    path.setAttribute('stroke-width', width);
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    return path;
  }

  drawCrossDayMarker(fromCard, toCard, toSegment, color) {
    const days = this.state.days || [];
    const date = new Date(toSegment.start_time * 1000);
    const day = days.find(d =>
      d.date.getFullYear() === date.getFullYear() &&
      d.date.getMonth() === date.getMonth() &&
      d.date.getDate() === date.getDate()
    );

    const goingDown = parseFloat(toCard.style.top) > parseFloat(fromCard.style.top);
    const x = parseFloat(fromCard.style.left) + parseFloat(fromCard.style.width) - 12;
    const top = parseFloat(fromCard.style.top);
    const y = goingDown ? top + parseFloat(fromCard.style.height) - 4 : top + 4;
    const dir = goingDown ? 1 : -1;

    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');

    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrow.setAttribute('d', `M ${x - 5} ${y} L ${x + 5} ${y} L ${x} ${y + 7 * dir} Z`);
    arrow.setAttribute('fill', color);
    arrow.setAttribute('stroke', '#000000');
    arrow.setAttribute('stroke-width', '1.5');
    group.appendChild(arrow);

    if (day) {
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', x - 10);
      label.setAttribute('y', y + 4 * dir);
      label.setAttribute('text-anchor', 'end');
      label.setAttribute('class', 'timeline-wire-label');
      label.textContent = day.name;
      group.appendChild(label);
    }

    this.wireLayer.appendChild(group);
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

  geometryFor(placement) {
    const x1 = this.canvas.timeToX(placement.startMin);
    const x2 = this.canvas.timeToX(placement.endMin);
    return {
      left: x1,
      width: Math.max(10, x2 - x1),
      top: this.canvas.dayIndexToY(placement.dayIdx) + 5,
      height: this.canvas.rowHeight - 10
    };
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

    this.wireLayer.setAttribute('width', this.canvas.width);
    this.wireLayer.setAttribute('height', this.canvas.height);
    this.wireLayer.setAttribute('viewBox', `0 0 ${this.canvas.width} ${this.canvas.height}`);

    const { placements, seams } = this.computePlacements();

    placements.forEach(p => {
      p.cardEl = this.buildCard(p);
      this.blockLayer.appendChild(p.cardEl);
    });

    seams.forEach(seam => {
      const el = this.buildSeamHandle(seam);
      this.blockLayer.appendChild(el);

      const top = this.canvas.dayIndexToY(seam.dayIdx) + 5;
      this.seamRecords.push({
        el,
        boundaryX: this.canvas.timeToX(seam.boundaryMin),
        top,
        bottom: top + this.canvas.rowHeight - 10,
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
    const sizeClass = TimelineDOM.sizeClassForWidth(geo.width);
    const isShort = geo.height < 58;
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
    card.style.backgroundColor = task.color || '#9ae659';

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

    const titleEl = document.createElement('div');
    titleEl.className = 'task-title-text';
    titleEl.textContent = task.title || 'Untitled Task';
    content.appendChild(titleEl);

    const metaEl = document.createElement('div');
    metaEl.className = 'task-meta-text';
    metaEl.textContent = `${startLabel} - ${endLabel} (${duration}m)`;
    content.appendChild(metaEl);

    card.appendChild(content);

    // Edge handles sit INSIDE the block, and every block keeps both of them —
    // including at a shared boundary, where resizing this block alone stays a
    // normal, always-available gesture.
    card.appendChild(TimelineDOM.buildEdgeHandle('left'));
    card.appendChild(TimelineDOM.buildEdgeHandle('right'));

    if (task.is_locked !== false && !isSplit && task.category !== 'Break') {
      const lockPill = document.createElement('div');
      lockPill.className = 'task-lock-indicator';
      lockPill.innerHTML = '<span class="material-symbols-outlined" style="font-size: 13px; color: #000;">lock</span>';
      card.appendChild(lockPill);
    }

    card.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.onTaskInteraction('openEditModal', { task });
    });

    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hideTooltip();
      this.onTaskInteraction('openContextMenu', {
        task,
        segmentId: segment.id,
        // Captured HERE, while the pointer is still over the cut point. It will
        // have moved to the menu by the time anything is clicked.
        splitTimestamp: this.timestampAtClientX(e.clientX, placement.dayIdx),
        clientX: e.clientX,
        clientY: e.clientY
      });
    });

    return card;
  }

  timestampAtClientX(clientX, dayIdx) {
    const day = (this.state.days || [])[dayIdx];
    if (!day) return null;
    const rect = this.canvas.canvas.getBoundingClientRect();
    return day.startTimestamp + this.canvas.xToMinutes(clientX - rect.left) * 60;
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
      label.textContent = `${segIdx + 1}/${segTotal}`;
      pill.appendChild(label);
      pill.setAttribute('aria-label',
        `Block ${segIdx + 1} of ${segTotal}, ${segment.completed ? 'done' : 'not done'}`);
    } else {
      pill.innerHTML = '<span class="material-symbols-outlined segment-pill-check">check</span>';
      pill.setAttribute('aria-label', segment.completed ? 'Mark not done' : 'Mark done');
    }

    // Must swallow its own pointer events: on a narrow block the pill covers
    // most of the surface, and a missed click would start a drag instead.
    pill.addEventListener('mousedown', (e) => e.stopPropagation());
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

    el.style.left = `${this.canvas.timeToX(seam.boundaryMin)}px`;
    el.style.top = `${this.canvas.dayIndexToY(seam.dayIdx) + 5}px`;
    el.style.height = `${this.canvas.rowHeight - 10}px`;

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
        const card = this.blockLayer.querySelector(
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
        ghost.style.backgroundColor = task.color || '#9ae659';
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

  clearProjection() {
    this.ghostPool.forEach(g => { g.style.display = 'none'; });
    this.blockLayer.querySelectorAll('.is-superseded').forEach(c => c.classList.remove('is-superseded'));
    this.blockLayer.classList.remove('has-projection');
  }
}
