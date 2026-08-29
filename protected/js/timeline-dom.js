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

    this.initTooltip();
    this.initSeamArming();
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

  // Which tiers actually hide something. Only these get a tooltip; a block that
  // already shows its title and time has nothing to reveal.
  static tierHidesContent(sizeClass, isShort) {
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
      this.showTooltip(card);
    });

    this.blockLayer.addEventListener('mouseout', (e) => {
      const card = e.target.closest('.timeline-task-card');
      if (!card) return;
      if (e.relatedTarget && card.contains(e.relatedTarget)) return;
      this.hideTooltip();
    });
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
  // PLACEMENT
  // ==========================================

  // Flatten scheduled task segments into positioned placements for the visible
  // week, then mark the pairs that share a boundary.
  computePlacements() {
    const tasks = this.state.tasks || [];
    const days = this.state.days || [];
    const placements = [];

    tasks.forEach(task => {
      if (!task.start_times || task.start_times.length === 0) return;

      task.start_times.forEach((st, segIdx) => {
        const dur = task.durations[segIdx] || 60;
        const segDate = new Date(st * 1000);
        const dayIdx = days.findIndex(d =>
          d.date.getFullYear() === segDate.getFullYear() &&
          d.date.getMonth() === segDate.getMonth() &&
          d.date.getDate() === segDate.getDate()
        );
        if (dayIdx === -1) return;

        const startMin = (st - days[dayIdx].startTimestamp) / 60;
        placements.push({
          task,
          segIdx,
          dayIdx,
          startMin,
          endMin: startMin + dur,
          duration: dur,
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
    const { task, segIdx, duration } = placement;
    const geo = this.geometryFor(placement);

    const isSplit = task.start_times.length > 1;
    const isFirstSegment = segIdx === 0;
    const isLastSegment = segIdx === task.start_times.length - 1;

    const startLabel = this.canvas.formatTimeLabel(placement.startMin);
    const endLabel = this.canvas.formatTimeLabel(placement.endMin);
    const sizeClass = TimelineDOM.sizeClassForWidth(geo.width);
    const isShort = geo.height < 58;

    const card = document.createElement('div');
    card.className = [
      'timeline-task-card',
      sizeClass,
      isShort ? 'is-short' : '',
      task.completed ? 'is-completed' : '',
      isSplit ? 'is-split' : '',
      // A seamed edge widens its handle so the seam zone in the middle does not
      // eat the whole target.
      placement.hasLeftSeam ? 'has-seam-left' : '',
      placement.hasRightSeam ? 'has-seam-right' : ''
    ].filter(Boolean).join(' ');

    card.dataset.taskId = task.id;
    card.dataset.segmentIndex = segIdx;
    card.style.left = `${geo.left}px`;
    card.style.top = `${geo.top}px`;
    card.style.width = `${geo.width}px`;
    card.style.height = `${geo.height}px`;
    card.style.backgroundColor = task.color || '#9ae659';

    // Only blocks that are actually hiding something get a tooltip.
    if (TimelineDOM.tierHidesContent(sizeClass, isShort)) {
      card.dataset.tipTitle = task.title || 'Untitled Task';
      card.dataset.tipMeta = `${startLabel} – ${endLabel} · ${duration}m`;
      card.dataset.tipColor = task.color || '#9ae659';
      if (task.category) card.dataset.tipCategory = task.category;
    }

    const badge = document.createElement('div');
    badge.className = 'task-badge-circle';
    badge.innerHTML = TimelineDOM.getCategoryIconElement(task.icon);
    card.appendChild(badge);

    const checkbox = document.createElement('button');
    checkbox.type = 'button';
    checkbox.className = `task-checkbox ${task.completed ? 'checked' : ''}`;
    checkbox.title = task.completed ? 'Mark uncompleted' : 'Mark completed';
    checkbox.innerHTML = task.completed
      ? '<span class="material-symbols-outlined" style="font-size: 16px; color: #000; font-weight: 800;">check</span>'
      : '';
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onTaskInteraction('toggleComplete', { taskId: task.id, completed: !task.completed });
    });
    card.appendChild(checkbox);

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

    if (isSplit) {
      if (!isLastSegment) {
        const dot = document.createElement('div');
        dot.className = 'split-connection-dot split-dot-right';
        card.appendChild(dot);
      }
      if (!isFirstSegment) {
        const dot = document.createElement('div');
        dot.className = 'split-connection-dot split-dot-left';
        card.appendChild(dot);
      }
    }

    if (task.is_locked !== false && !isSplit && task.category !== 'Break') {
      const lockPill = document.createElement('div');
      lockPill.className = 'task-lock-indicator';
      lockPill.title = 'Locked Duration: pushes neighboring tasks when expanding';
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
      this.onTaskInteraction('openContextMenu', { task, clientX: e.clientX, clientY: e.clientY });
    });

    return card;
  }

  static buildEdgeHandle(side) {
    const handle = document.createElement('div');
    handle.className = `resize-handle resize-handle-${side}`;
    handle.dataset.handle = side;
    handle.title = side === 'left' ? 'Drag to adjust start time' : 'Drag to adjust duration';

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
    el.dataset.leftSegmentIndex = seam.left.segIdx;
    el.dataset.rightTaskId = seam.right.task.id;
    el.dataset.rightSegmentIndex = seam.right.segIdx;
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
