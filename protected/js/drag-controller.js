// Klndr Real-Time Drag & Drop, Resizing, and Physics Controller
//
// Every drag resolves through one function, resolveDragOutcome(), which is used
// both to preview the drag live and to commit it on release. That is deliberate:
// the ghost blocks the user sees during a drag are produced by exactly the same
// physics call that will run when they let go, so the preview cannot lie.

class DragController {
  static SEAM_MIN_MINUTES = PhysicsEngine.MIN_TASK_DURATION_MINUTES;

  constructor(canvasRenderer, domRenderer, state, onCommitChanges, onReorderTasks) {
    this.canvas = canvasRenderer;
    this.dom = domRenderer;
    this.state = state;
    this.onCommitChanges = onCommitChanges;
    this.onReorderTasks = onReorderTasks;

    this.activeDrag = null;
    this.isShiftPressed = false;
    this.isCtrlPressed = false;
    this.isAltPressed = false;

    // Touch has no modifier keys, and the two that matter change what a drag
    // MEANS rather than where it lands - so they get sticky equivalents the UI
    // can drive. Mouse events still overwrite isCtrlPressed every frame through
    // syncModifiersFromEvent, so nothing about the desktop gesture changes.
    this.touchRippleMode = false;
    this.touchSnapMode = null; // null = follow settings; 'off' | 'tick' | 'bucket'

    // One pointer owns a drag. A second finger arriving mid-gesture is not a
    // second drag, and its moves must not be read as this one's.
    this.activePointerId = null;
    this.lastPointerType = 'mouse';
    this._pendingTouch = null;

    this.globalGhostEl = null;
    this.hintChipEl = null;
    this.modeChipEl = null;
    this._projectionRaf = null;

    this.dom.isDragActive = () => Boolean(this.activeDrag);
    // Set by the app; Alt-click has nothing to do until it is.
    this.onSplitSegment = null;
    this.initListeners();
  }

  // What Ctrl means during a drag: split around the obstacle rather than trade
  // time with it. Touch reaches the same flag through the mode chip, so the two
  // are one signal arriving by two routes.
  get rippleMode() {
    return this.isCtrlPressed || this.touchRippleMode;
  }

  // The mode chip. Re-runs the projection so the preview answers the toggle
  // immediately, exactly as a Ctrl press does mid-drag.
  setTouchRippleMode(enabled) {
    const next = Boolean(enabled);
    if (this.touchRippleMode === next) return;
    this.touchRippleMode = next;
    this.replayDragUnderNewModifiers();
  }

  // 'off' | 'tick' | 'bucket', or null to follow the settings modal. Sticky
  // rather than held: a gesture that already needs both thumbs cannot also hold
  // a key down, so the transient reading of Shift is the wrong translation.
  setTouchSnapMode(mode) {
    this.touchSnapMode = mode || null;
    this.canvas.setShiftMode(mode === 'bucket');
    this.replayDragUnderNewModifiers();
  }

  setModifiers(shift, ctrl) {
    if (!this.isCalendarActiveAndFocused()) {
      if (this.isShiftPressed || this.isCtrlPressed) {
        this.isShiftPressed = false;
        this.isCtrlPressed = false;
        this.canvas.setShiftMode(false);
      }
      return;
    }

    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT' || activeEl.isContentEditable)) {
      if (this.isShiftPressed || this.isCtrlPressed) {
        this.isShiftPressed = false;
        this.isCtrlPressed = false;
        this.canvas.setShiftMode(false);
      }
      return;
    }

    const newShift = Boolean(shift);
    const newCtrl = Boolean(ctrl);

    if (this.isShiftPressed !== newShift || this.isCtrlPressed !== newCtrl) {
      this.isShiftPressed = newShift;
      this.isCtrlPressed = newCtrl;
      this.canvas.setShiftMode(this.isShiftPressed);
    }
  }

  // Mid-drag the mouse event is the authority on modifier state: a keydown that
  // lands while the pointer is captured can otherwise be missed entirely.
  syncModifiersFromEvent(e) {
    const shift = Boolean(e.shiftKey);
    const ctrl = Boolean(e.ctrlKey || e.metaKey);
    const alt = Boolean(e.altKey);
    const changed = shift !== this.isShiftPressed || ctrl !== this.isCtrlPressed || alt !== this.isAltPressed;

    this.isShiftPressed = shift;
    this.isCtrlPressed = ctrl;
    this.isAltPressed = alt;
    if (shift !== this.canvas.isShiftMode) this.canvas.setShiftMode(shift);
    return changed;
  }

  // Keep a block's legibility tier in step with its live extent while dragging,
  // so it does not sit in a tier it has outgrown until the next full render.
  // Writes whichever CSS property carries time - putting a duration into `width`
  // while time runs downward would stretch the block across days instead.
  applyBlockExtent(element, rawMain) {
    const main = Math.max(TimelineCanvas.MIN_BLOCK_MAIN, rawMain);
    if (this.canvas.mainIsX) element.style.width = `${main}px`;
    else element.style.height = `${main}px`;

    // The main extent in both orientations, matching buildCard. It used to read
    // the lane width when time ran downward, which cannot change during a
    // resize - so the tier never updated and a vertical block kept the chrome of
    // whatever size it started at.
    const next = TimelineDOM.sizeClassForWidth(main);
    ['is-lg', 'is-md', 'is-sm', 'is-xs', 'is-min'].forEach(cls => {
      element.classList.toggle(cls, cls === next);
    });
  }

  isModalOrOverlayActive() {
    // Placing a split point is a mode, not a modal, but it wants exactly the
    // same silence: no drags, no seam arming, no tooltips, no hover playhead.
    // Routing it through the one gate every consumer already checks is what
    // keeps that consistent.
    if (document.body.classList.contains('is-placing-split')) return true;
    return Boolean(document.querySelector('.modal-container.active, .context-menu.active'));
  }

  isCalendarActiveAndFocused() {
    if (this.isModalOrOverlayActive()) return false;
    const calPane = document.getElementById('calendarPane');
    if (calPane && calPane.classList.contains('is-collapsed')) return false;
    return true;
  }

  dayIndexForTimestamp(timestamp) {
    const idx = this.state.days.findIndex(
      day => timestamp >= day.startTimestamp && timestamp < day.startTimestamp + 86400
    );
    return idx === -1 ? 0 : idx;
  }

  snapMinutes() {
    const bucketMinutes = (this.state.bucketHours || 2) * 60;
    const tickMinutes = () => bucketMinutes * ((this.state.tickPercent || 25) / 100);

    // The sticky touch choice outranks both, because it is the only grid
    // control a finger has - and for the same reason it applies ONLY to a
    // finger. Shift is still the answer on a mouse, and someone who set this
    // once on a touchscreen laptop should not find their Shift key overridden
    // the next time they use the trackpad.
    if (TimelineDOM.isTouchInput()) {
      if (this.touchSnapMode === 'off') return 0;
      if (this.touchSnapMode === 'tick') return tickMinutes();
      if (this.touchSnapMode === 'bucket') return bucketMinutes;
    }

    if (this.isShiftPressed) return bucketMinutes;
    if (this.state.snapToRuler) return tickMinutes();
    return 0;
  }

  // How long a finger must rest on a block before the gesture is read as a drag
  // rather than as a tap or the start of a scroll.
  static LONG_PRESS_MS = 400;
  // Movement inside this radius is still a press; beyond it the browser is
  // scrolling and the candidate drag is abandoned.
  static TOUCH_SLOP_PX = 10;

  // Pointer Events rather than mouse events: one path serves mouse, touch and
  // pen, and setPointerCapture guarantees the move/up pair even when the gesture
  // leaves the window - which the old window-bound mouseup silently lost,
  // stranding the drag.
  initListeners() {
    const timelineContainer = document.getElementById('timeline-workspace');
    if (!timelineContainer) return;

    timelineContainer.addEventListener('pointermove', (e) => {
      // A finger travelling across the glass is not a hover. The playhead is a
      // mouse affordance and stays one.
      if (e.pointerType !== 'mouse') return;
      if (this.activeDrag) return;
      if (!this.isCalendarActiveAndFocused()) {
        this.canvas.setPlayhead(null);
        this.canvas.setSnapGuide(null);
        return;
      }
      const { main } = this.canvas.clientToLocal(e.clientX, e.clientY);
      if (main >= 0 && main <= this.canvas.mainSpan) {
        this.canvas.setPlayhead(main);
      } else {
        this.canvas.setPlayhead(null);
      }
    });

    timelineContainer.addEventListener('pointerleave', () => {
      if (!this.activeDrag) {
        this.canvas.setPlayhead(null);
        this.canvas.setSnapGuide(null);
      }
    });

    timelineContainer.addEventListener('pointerdown', (e) => this.handlePointerDown(e));

    // Android raises its own contextmenu on a long press. Ours already means
    // "drag", so the OS callout has to be refused or it lands mid-gesture.
    timelineContainer.addEventListener('contextmenu', (e) => {
      if (this.lastPointerType !== 'mouse') e.preventDefault();
    });

    // passive:false because an armed touch drag has to preventDefault() every
    // move to stop the browser reclaiming the gesture as a scroll.
    window.addEventListener('pointermove', (e) => this.handlePointerMove(e), { passive: false });
    window.addEventListener('pointerup', (e) => this.handlePointerUp(e));
    window.addEventListener('pointercancel', (e) => this.handlePointerCancel(e));

    // A modifier changes what the drop will DO, so the preview has to change the
    // instant the key goes down — not on the next mouse move. Ctrl switches
    // split/ripple and Shift switches the snap grid, both of which alter the
    // outcome for a pointer that has not moved at all.
    window.addEventListener('keydown', (e) => this.handleDragModifierKey(e));
    window.addEventListener('keyup', (e) => this.handleDragModifierKey(e));
  }

  // Alt is deliberately absent: nothing binds to it any more, and reacting to it
  // would only trigger a pointless recompute (on Windows it also pulls focus to
  // the menu bar mid-drag).
  static MODIFIER_KEYS = ['Control', 'Meta', 'Shift'];

  handleDragModifierKey(e) {
    if (!this.activeDrag) return;
    if (!DragController.MODIFIER_KEYS.includes(e.key)) return;
    if (!this.syncModifiersFromEvent(e)) return;
    this.replayDragUnderNewModifiers();
  }

  // Re-run the drag from the last known pointer position under the current
  // modifier state, so snapping and the projection catch up together. Shared by
  // the keyboard modifiers and by the touch mode chips, which mean the same
  // thing to a drag already in flight.
  replayDragUnderNewModifiers() {
    if (!this.activeDrag) return;

    if (this._lastPointer) {
      this.handleDragMove({
        clientX: this._lastPointer.x,
        clientY: this._lastPointer.y,
        shiftKey: this.isShiftPressed,
        ctrlKey: this.isCtrlPressed,
        metaKey: false,
        altKey: this.isAltPressed
      });
    } else {
      this.scheduleProjection();
    }
  }

  // ==========================================
  // DRAG START
  // ==========================================

  // A plain record of where and how a gesture started. A touch drag is decided
  // 400ms after the event object has been recycled, so the numbers have to be
  // copied out rather than held by reference.
  static snapshotPointer(e) {
    return {
      clientX: e.clientX,
      clientY: e.clientY,
      pointerId: e.pointerId,
      pointerType: e.pointerType || 'mouse',
      shiftKey: Boolean(e.shiftKey),
      ctrlKey: Boolean(e.ctrlKey),
      metaKey: Boolean(e.metaKey),
      altKey: Boolean(e.altKey)
    };
  }

  handlePointerDown(e) {
    this.lastPointerType = e.pointerType || 'mouse';
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this.activeDrag || this._pendingTouch) return;
    if (this.isModalOrOverlayActive()) return;

    const snap = DragController.snapshotPointer(e);

    // A press on a handle is unambiguous - nothing else could be meant by it -
    // so it skips the long press and starts resizing on contact. Only whole
    // block moves pay the 400ms.
    const onHandle = Boolean(e.target.closest('.resize-handle, .timeline-seam-handle'));

    if (e.pointerType === 'mouse' || onHandle) {
      this.beginDrag(snap, e.target);
      return;
    }

    // Touch on the body of a block is ambiguous between drag, tap and scroll,
    // and the browser owns the scroll until we know which. Watch it; do not
    // preventDefault, or the page stops scrolling for every tap.
    if (!e.target.closest('.timeline-task-card')) return;

    this._pendingTouch = {
      snap,
      target: e.target,
      timer: setTimeout(() => this.armPendingTouch(), DragController.LONG_PRESS_MS)
    };
  }

  armPendingTouch() {
    const pending = this._pendingTouch;
    if (!pending) return;
    this._pendingTouch = null;
    if (!pending.target.isConnected) return;

    // Two fingers on the grid mean a zoom, not a very slow drag. The canvas
    // reads the same pointers off the same element, so this is the handoff.
    if (this.canvas.isPinching && this.canvas.isPinching()) return;

    if (navigator.vibrate) navigator.vibrate(10);
    this.beginDrag(pending.snap, pending.target);

    /*
     * Hold to read. Hover is the only thing that opens a tooltip, and touch has
     * no hover, so on a phone the blocks that most need one - the tiers with no
     * room to print a title - were the ones with no way to be read at all.
     *
     * It costs no gesture: the press has already matured into a drag by now, so
     * this is the moment BETWEEN "the block is armed" and "the finger moved".
     * Stay still and you read the block; move and handleDragMove takes it away
     * again. beginDrag hides the tooltip on its way through, which is why this
     * comes after it rather than before.
     */
    const card = pending.target.closest && pending.target.closest('.timeline-task-card');
    if (this.activeDrag && card && card.dataset.tipTitle) {
      this._pressTooltipFrom = { x: pending.snap.clientX, y: pending.snap.clientY };
      this.dom.showTooltip(card);
    }
  }

  // The tooltip a long press opened survives small wobble - a finger resting on
  // glass is never perfectly still - and goes the moment the block is actually
  // being moved.
  static PRESS_TOOLTIP_SLOP_PX = 6;

  updatePressTooltip(clientX, clientY) {
    const from = this._pressTooltipFrom;
    if (!from) return;
    if (Math.abs(clientX - from.x) < DragController.PRESS_TOOLTIP_SLOP_PX &&
        Math.abs(clientY - from.y) < DragController.PRESS_TOOLTIP_SLOP_PX) return;
    this._pressTooltipFrom = null;
    this.dom.hideTooltip();
  }

  cancelPendingTouch() {
    const pending = this._pendingTouch;
    if (!pending) return null;
    clearTimeout(pending.timer);
    this._pendingTouch = null;
    return pending;
  }

  // Capture routes every later event for this pointer here, including ones that
  // leave the element or the window entirely, and releases implicitly on up.
  capturePointer(pointerId) {
    if (pointerId == null) return;
    this.activePointerId = pointerId;
    const el = document.getElementById('timeline-workspace');
    try {
      if (el) el.setPointerCapture(pointerId);
    } catch (err) { /* pointer already gone; window listeners still cover it */ }
  }

  releasePointer() {
    if (this.activePointerId == null) return;
    const el = document.getElementById('timeline-workspace');
    try {
      if (el && el.hasPointerCapture(this.activePointerId)) {
        el.releasePointerCapture(this.activePointerId);
      }
    } catch (err) { /* already released */ }
    this.activePointerId = null;
  }

  // NB: no preventDefault here. On a mouse pointerdown it would suppress the
  // compatibility mouse events and the click that follows, taking the segment
  // pill, the checkbox and dblclick-to-edit down with it. Text selection was
  // the only thing it bought, and .timeline-task-card is already user-select:none.
  beginDrag(snap, target) {
    this.syncModifiersFromEvent(snap);

    // Set here rather than on the long-press path alone, because a touch press
    // on a handle reaches this method directly. The flag is what tells the
    // stylesheet to stop panning and the canvas to refuse a pinch, so anything
    // that starts a touch drag has to raise it.
    if (snap.pointerType !== 'mouse') {
      document.body.classList.add('is-touch-dragging');
    }

    const seamEl = target.closest('.timeline-seam-handle');
    if (seamEl) {
      this.startSeamDrag(snap, seamEl);
      this.capturePointer(snap.pointerId);
      return;
    }

    const handleEl = target.closest('.resize-handle');
    const taskCard = target.closest('.timeline-task-card');
    if (!taskCard) return;

    const taskId = taskCard.dataset.taskId;
    const segmentId = taskCard.dataset.segmentId;
    const task = this.state.tasks.find(t => t.id === taskId);
    if (!task) return;

    // Segments carry their own completion, so they are addressed by id. An index
    // would hand the wrong block to a drag whenever a re-sort landed in between.
    const segment = TaskModel.segmentById(task, segmentId);
    if (!segment) return;

    const startTime = segment.start_time;
    const duration = segment.duration;

    // Alt-click cuts the block under the pointer, no menu. Windows only for now.
    if (!handleEl && snap.altKey && DragController.supportsAltSplit()) {
      this.dom.hideTooltip();
      this.onSplitSegment(task, segmentId, this.timestampAtPointer(snap.clientX, snap.clientY, startTime));
      return;
    }

    if (handleEl) {
      const resizeDayIndex = this.dayIndexForTimestamp(startTime);

      this.activeDrag = {
        type: handleEl.dataset.handle === 'left' ? 'resize-left' : 'resize-right',
        taskId,
        segmentId,
        taskRef: task,
        domElement: taskCard,
        initialClientX: snap.clientX,
        // Captured for resizes too, not just moves: once the timeline can be
        // transposed, a resize reads its delta off whichever axis carries time.
        initialClientY: snap.clientY,
        initialStartTime: startTime,
        initialDuration: duration,
        currentStartTime: startTime,
        currentDuration: duration,
        // Without this the resize maths falls back to day 0, which throws the
        // block off the right-hand edge of the grid for any task not on the
        // first day of the week.
        currentDayIndex: resizeDayIndex,
        // A resize runs the same physics as a move, so it needs the same
        // sandwich check: an edge dragged into a sibling pair trades time inside
        // the pair rather than shoving the day around.
        divider: this.findDividerAt(task, segment, resizeDayIndex)
      };
      taskCard.classList.add('is-resizing');
      this.dom.hideTooltip();
      this.capturePointer(snap.pointerId);
      return;
    }

    if (target.closest('.segment-pill')) return;

    const rect = taskCard.getBoundingClientRect();
    const dayIndex = this.dayIndexForTimestamp(startTime);

    this.activeDrag = {
      type: 'move',
      taskId,
      segmentId,
      taskRef: task,
      domElement: taskCard,
      initialClientX: snap.clientX,
      initialClientY: snap.clientY,
      offsetX: snap.clientX - rect.left,
      offsetY: snap.clientY - rect.top,
      // Where inside the block the pointer grabbed it, along the TIME axis. The
      // block's start must stay under that same grip for the whole drag.
      offsetMain: this.canvas.mainIsX
        ? snap.clientX - rect.left
        : snap.clientY - rect.top,
      initialStartTime: startTime,
      initialDuration: duration,
      currentStartTime: startTime,
      currentDuration: duration,
      currentDayIndex: dayIndex,
      initialDayIndex: dayIndex,
      // Captured once, at drag start: recomputing the pair every frame would
      // change what the gesture means halfway through it.
      divider: this.findDividerAt(task, segment, dayIndex)
    };
    taskCard.classList.add('is-dragging');
    this.dom.hideTooltip();
    this.capturePointer(snap.pointerId);
  }

  /**
   * Which way a ripple pushes. The blocks in the way are shoved AHEAD of the
   * gesture, so the answer is simply: whichever way you are dragging.
   *
   * Pushing forward regardless is what made dragging a block earlier shove its
   * neighbour later — past the block you were dragging, reordering the day in
   * the opposite direction to the gesture that asked for it.
   */
  static ripplesBackward(drag) {
    if (drag.type === 'resize-left') return true;
    if (drag.type !== 'move') return false;

    // A drop from the sidebar has no previous position, and a block arriving
    // from another day has none within the day it landed in. "Insert here and
    // push down" is the only meaning available.
    if (drag.currentDayIndex !== drag.initialDayIndex) return false;

    return drag.currentStartTime < drag.initialStartTime;
  }

  static supportsAltSplit() {
    return /Win/i.test(navigator.platform || navigator.userAgent || '');
  }

  timestampAtPointer(clientX, clientY, referenceTimestamp) {
    const dayIndex = this.dayIndexForTimestamp(referenceTimestamp);
    const day = this.state.days[dayIndex];
    if (!day) return referenceTimestamp;
    const { main } = this.canvas.clientToLocal(clientX, clientY);
    return day.startTimestamp + this.canvas.mainToTime(main) * 60;
  }

  findDividerAt(task, segment, dayIndex) {
    const day = this.state.days[dayIndex];
    if (!day) return null;

    const obstacles = PhysicsEngine.daySegments(
      this.state.tasks, day.startTimestamp, day.startTimestamp + 86400, segment.id
    );
    const found = PhysicsEngine.findDivider(
      obstacles, segment.start_time, segment.start_time + segment.duration * 60
    );
    if (!found) return null;

    return {
      taskId: found.left.taskId,
      leftId: found.left.segmentId,
      rightId: found.right.segmentId
    };
  }

  startSeamDrag(snap, seamEl) {
    const leftTask = this.state.tasks.find(t => t.id === seamEl.dataset.leftTaskId);
    const rightTask = this.state.tasks.find(t => t.id === seamEl.dataset.rightTaskId);
    if (!leftTask || !rightTask) return;

    const leftSegment = TaskModel.segmentById(leftTask, seamEl.dataset.leftSegmentId);
    const rightSegment = TaskModel.segmentById(rightTask, seamEl.dataset.rightSegmentId);
    if (!leftSegment || !rightSegment) return;

    this.activeDrag = {
      type: 'seam',
      taskId: leftTask.id,
      segmentId: leftSegment.id,
      domElement: seamEl,
      initialClientX: snap.clientX,
      initialClientY: snap.clientY,
      currentDayIndex: parseInt(seamEl.dataset.dayIndex || '0', 10),
      left: { task: leftTask, segmentId: leftSegment.id, start: leftSegment.start_time, duration: leftSegment.duration },
      right: { task: rightTask, segmentId: rightSegment.id, start: rightSegment.start_time, duration: rightSegment.duration },
      initialBoundary: rightSegment.start_time,
      currentBoundary: rightSegment.start_time
    };

    seamEl.classList.add('is-active');
    document.body.classList.add('is-seam-dragging');
    this.dom.hideTooltip();
  }

  startSidebarTaskDrag(task, clientX, clientY, pointerId) {
    if (this.isModalOrOverlayActive()) return;

    const duration = task.default_timing || task.total_duration || 120;

    const ghost = document.createElement('div');
    ghost.className = 'global-drag-ghost';
    ghost.style.backgroundColor = task.color || '#3ba4f6';
    ghost.style.left = `${clientX}px`;
    ghost.style.top = `${clientY}px`;
    ghost.style.width = '180px';
    ghost.style.height = '48px';
    ghost.innerHTML = `
      <div class="task-badge-circle">
        <span class="material-symbols-outlined task-icon-symbol">${task.icon || 'task_alt'}</span>
      </div>
      <div class="task-content-inner">
        <div class="task-title-text" style="font-size:13px;">${task.title}</div>
        <div class="task-meta-text">${duration} min</div>
      </div>
    `;
    document.body.appendChild(ghost);
    this.globalGhostEl = ghost;

    this.activeDrag = {
      type: 'sidebar-drop',
      taskId: task.id,
      taskRef: task,
      segmentId: null,
      initialDuration: duration,
      currentDuration: duration,
      initialClientX: clientX,
      initialClientY: clientY,
      currentStartTime: null,
      currentDayIndex: 0,
      isOverCalendar: false,
      hoveredSidebarTask: null
    };

    // The one touch drag that never went through beginDrag(), and so never
    // suppressed the list's own scrolling. See the touch-action rule keyed on
    // this class; endDrag() removes it for every drag type alike.
    if (TimelineDOM.isTouchInput()) document.body.classList.add('is-touch-dragging');

    // On a phone the calendar is not on screen when this drag begins, so a drag
    // from the list could never reach it - #timeline-workspace sat inside a
    // display:none ancestor, reported a zero rect, and every drop was read as a
    // reorder. Handing the pane over now is the whole fix: the ghost is fixed to
    // <body> and carries on tracking, the pointer stream comes from window
    // listeners rather than from the capture below, and moveSidebarDrop re-reads
    // that rect every frame - so the very next move produces a real time.
    if (this.onNeedsCalendar) this.onNeedsCalendar();

    this.capturePointer(pointerId);
  }

  // ==========================================
  // OUTCOME RESOLUTION (preview and commit share this)
  // ==========================================

  /**
   * Work out the full set of task updates this drag would commit right now,
   * including every knock-on change the physics engine produces.
   * Returns [] when the drag has nothing to place yet.
   */
  resolveDragOutcome(drag) {
    return this.pruneUnchanged(this.computeDragOutcome(drag));
  }

  // The ripple engine reports every segment it considered, changed or not. Drop
  // the no-ops so the hint counts only real movement and the commit does not
  // write rows that did not move.
  // The engines report every segment they considered, changed or not. Drop the
  // no-ops so the hint counts only real movement and the commit does not write
  // rows that did not move.
  pruneUnchanged(updates) {
    return updates.filter(update => {
      const task = this.state.tasks.find(t => t.id === update.id);
      if (!task) return true;

      const before = task.segments || [];
      const after = update.segments || [];
      if (before.length !== after.length) return true;

      return !after.every((seg, i) => (
        Math.abs(seg.start_time - before[i].start_time) < PhysicsEngine.NEGLIGIBLE_SECONDS &&
        Math.abs(seg.duration - before[i].duration) < 0.5 &&
        Boolean(seg.completed) === Boolean(before[i].completed)
      ));
    });
  }

  /**
   * A scratch copy of the segments of every task a drag touches. Mutations land
   * here, never on live tasks, so the preview can be recomputed every frame and
   * the commit path can still snapshot the pre-edit state for rollback.
   */
  createWorkspace() {
    const byTask = new Map();
    const self = this;

    return {
      segments(taskId) {
        if (!byTask.has(taskId)) {
          const task = self.state.tasks.find(t => t.id === taskId);
          byTask.set(taskId, task ? TaskModel.cloneSegments(task) : []);
        }
        return byTask.get(taskId);
      },
      set(taskId, segmentId, startTime, duration) {
        const segment = this.segments(taskId).find(seg => seg.id === segmentId);
        if (!segment) return;
        segment.start_time = startTime;
        if (duration != null) segment.duration = duration;
      },
      remove(taskId, segmentId) {
        byTask.set(taskId, this.segments(taskId).filter(seg => seg.id !== segmentId));
      },
      payloads() {
        return [...byTask.entries()].map(([taskId, segments]) => {
          const task = self.state.tasks.find(t => t.id === taskId);
          return TaskModel.payloadFrom(task, segments);
        }).filter(Boolean);
      }
    };
  }

  computeDragOutcome(drag) {
    if (!drag) return [];
    if (drag.type === 'seam') return this.resolveSeamOutcome(drag);

    const day = this.state.days[drag.currentDayIndex ?? 0];
    if (!day) return [];

    const startTime = drag.currentStartTime;
    if (startTime === null || startTime === undefined) return [];

    const task = this.state.tasks.find(t => t.id === drag.taskId);
    if (!task) return [];

    const duration = drag.currentDuration || drag.initialDuration;
    const dayStart = day.startTimestamp;
    const dayEnd = dayStart + 86400;
    const endTime = startTime + duration * 60;
    const workspace = this.createWorkspace();

    // Two different questions, deliberately answered separately.
    //
    // Which way does the block GROW? Only a left edge grows into the past, so
    // only a left edge makes its overflow flow backwards.
    const growsBackward = drag.type === 'resize-left';
    // Which way is the gesture PLOWING? A ripple shoves what is in front of it,
    // and "in front" is the direction you are dragging.
    const pushesBackward = DragController.ripplesBackward(drag);

    const obstacles = PhysicsEngine.daySegments(this.state.tasks, dayStart, dayEnd, drag.segmentId);

    // DIVIDER: this block sits between two touching blocks of one task, so it
    // acts as the boundary between them — time moves from one side to the other
    // and the pair's outer edges stay put.
    if (!this.rippleMode && drag.divider) {
      const resolved = this.resolveDivider(drag, startTime, duration, dayStart, dayEnd);
      if (resolved) {
        resolved.changed.forEach(entry => {
          workspace.set(entry.taskId, entry.segmentId, entry.startTime, entry.duration);
        });
        resolved.removed.forEach(entry => workspace.remove(entry.taskId, entry.segmentId));
        this.placeDraggedSegment(workspace, task, drag, resolved.movedStart, duration);
        drag.lastOutcome = {
          kind: 'divider',
          removed: resolved.removed.length,
          blockedByCompleted: resolved.blockedByCompleted,
          taskTitle: resolved.taskTitle
        };
        return workspace.payloads();
      }
    }

    if (this.rippleMode) {
      const moved = pushesBackward
        ? PhysicsEngine.rippleBackward(obstacles, endTime, duration)
        : PhysicsEngine.ripple(obstacles, startTime, duration);
      moved.forEach(entry => {
        workspace.set(entry.taskId, entry.segmentId, entry.startTime, entry.duration);
      });
      this.placeDraggedSegment(workspace, task, drag, startTime, duration);
      drag.lastOutcome = { kind: 'ripple', moved: moved.length, backward: pushesBackward };
      return workspace.payloads();
    }

    // DEFAULT: flow around whatever is in the way, splitting only THIS block.
    // The task's other blocks are untouched — they are obstacles, not cargo.
    const pieces = growsBackward
      ? PhysicsEngine.placeAroundBackward(obstacles, endTime, duration, dayStart)
      : PhysicsEngine.placeAround(obstacles, startTime, duration, dayEnd);
    this.placeDraggedSegment(workspace, task, drag, startTime, duration, pieces);
    drag.lastOutcome = { kind: 'split', pieces: pieces.length };
    return workspace.payloads();
  }

  /**
   * Put the dragged block down. The first piece keeps the original segment id so
   * its completion travels with it; extra pieces are new blocks of the same task.
   */
  placeDraggedSegment(workspace, task, drag, startTime, duration, pieces = null) {
    const segments = workspace.segments(task.id);
    const index = segments.findIndex(seg => seg.id === drag.segmentId);
    const completed = index !== -1 ? segments[index].completed : false;

    if (!pieces || pieces.length <= 1) {
      const only = pieces && pieces.length ? pieces[0] : { startTime, duration };
      if (index === -1) {
        segments.push({
          id: drag.segmentId || TaskModel.newSegmentId(),
          start_time: only.startTime,
          duration: only.duration,
          completed: false
        });
      } else {
        segments[index].start_time = only.startTime;
        segments[index].duration = only.duration;
      }
      return;
    }

    if (index !== -1) segments.splice(index, 1);
    pieces.forEach((piece, i) => {
      segments.push({
        id: i === 0 && drag.segmentId ? drag.segmentId : TaskModel.newSegmentId(),
        start_time: piece.startTime,
        duration: piece.duration,
        completed
      });
    });
  }

  resolveDivider(drag, startTime, duration, dayStart, dayEnd) {
    const owner = this.state.tasks.find(t => t.id === drag.divider.taskId);
    if (!owner) return null;

    const entries = PhysicsEngine.daySegments([owner], dayStart, dayEnd);
    const left = entries.find(e => e.segmentId === drag.divider.leftId);
    const right = entries.find(e => e.segmentId === drag.divider.rightId);
    if (!left || !right) return null;

    const result = PhysicsEngine.applyDivider({ left, right }, startTime, startTime + duration * 60);
    result.taskTitle = owner.title || 'that task';
    return result;
  }

  resolveSeamOutcome(drag) {
    const { left, right } = drag;
    const boundary = drag.currentBoundary;
    const rightEnd = right.start + right.duration * 60;

    const workspace = this.createWorkspace();
    workspace.set(left.task.id, left.segmentId, left.start, Math.round((boundary - left.start) / 60));
    workspace.set(right.task.id, right.segmentId, boundary, Math.round((rightEnd - boundary) / 60));
    return workspace.payloads();
  }

  // ==========================================
  // LIVE PREVIEW
  // ==========================================

  scheduleProjection() {
    if (this._projectionRaf) return;
    this._projectionRaf = requestAnimationFrame(() => {
      this._projectionRaf = null;
      if (!this.activeDrag) {
        this.dom.clearProjection();
        this.hideHint();
        this.hideTouchModeChip();
        return;
      }
      const updates = this.resolveDragOutcome(this.activeDrag);
      this.dom.renderProjection(updates, { activeTaskId: this.activeDrag.taskId });
      this.updateHint(this.activeDrag, updates);
      this.updateTouchModeChip(this.activeDrag);
    });
  }

  hintTextFor(drag) {
    if (drag.type === 'seam') {
      return 'Moving the shared boundary — both blocks, same total time';
    }

    const outcome = drag.lastOutcome || {};

    if (outcome.kind === 'divider') {
      if (outcome.removed > 0) {
        return `Trading time inside ${outcome.taskTitle} — ${outcome.removed} block${outcome.removed > 1 ? 's' : ''} will be removed`;
      }
      if (outcome.blockedByCompleted) {
        return `Trading time inside ${outcome.taskTitle} — stopped at a completed block`;
      }
      return `Trading time between the blocks of ${outcome.taskTitle}`;
    }

    if (outcome.kind === 'ripple') {
      // Counted in blocks, not tasks. A resize that pushes the task's own later
      // blocks along displaces nothing "other" -- and reporting that as "nothing
      // affected" while three of its blocks slide across the day is a lie.
      const moved = outcome.moved || 0;
      if (moved === 0) return 'Ripple — nothing else affected';
      const where = outcome.backward ? 'earlier' : 'later';
      return `Ripple — ${moved} block${moved > 1 ? 's' : ''} pushed ${where}`;
    }

    if (outcome.kind === 'split' && outcome.pieces > 1) {
      return `Breaks into ${outcome.pieces} blocks around what's in the way`;
    }

    if (drag.type === 'move' || drag.type === 'sidebar-drop') {
      // There is no Ctrl to hold on touch, and the mode chip is already on
      // screen saying the same thing, so repeating it here is noise.
      return TimelineDOM.isTouchInput()
        ? null
        : 'Hold Ctrl to push the blocks in the way instead of splitting';
    }
    return null;
  }

  /**
   * The touch stand-in for holding Ctrl.
   *
   * Bottom-centre, for the thumb that is not dragging: the gesture owns one
   * pointer and pointer capture keeps every later event for it, so a second
   * finger on this chip routes normally and the two cannot be confused.
   *
   * Sticky between drags rather than per-gesture. Ctrl is transient because a
   * hand can hold it; a finger cannot hold anything while dragging, and the
   * chip states its mode on screen the whole time, so nothing is hidden.
   */
  updateTouchModeChip(drag) {
    // The chip names how the block will settle among the blocks already on the
    // day, so it has nothing to say until the drag is actually over the
    // calendar. On a phone the list and the calendar are never both on screen,
    // which means isOverCalendar is simply never true while the drag is still
    // in the panel - no width test needed.
    const wanted = TimelineDOM.isTouchInput() &&
      (drag.type === 'move' || (drag.type === 'sidebar-drop' && drag.isOverCalendar));

    if (!wanted) {
      this.hideTouchModeChip();
      return;
    }

    if (!this.modeChipEl) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'drag-mode-chip';
      // Must not reach the timeline: this is a control, not a second drag.
      chip.addEventListener('pointerdown', (e) => e.stopPropagation());
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setTouchRippleMode(!this.touchRippleMode);
        if (this.activeDrag) this.updateTouchModeChip(this.activeDrag);
      });
      document.body.appendChild(chip);
      this.modeChipEl = chip;
    }

    this.modeChipEl.textContent = this.touchRippleMode ? 'Push others' : 'Split around';
    this.modeChipEl.classList.toggle('is-ripple', this.touchRippleMode);
    this.modeChipEl.style.display = 'flex';
  }

  hideTouchModeChip() {
    if (this.modeChipEl) this.modeChipEl.style.display = 'none';
  }

  updateHint(drag, updates) {
    const text = this.hintTextFor(drag);
    if (!text) {
      this.hideHint();
      return;
    }

    if (!this.hintChipEl) {
      this.hintChipEl = document.createElement('div');
      this.hintChipEl.className = 'drag-hint-chip';
      document.body.appendChild(this.hintChipEl);
    }

    this.hintChipEl.textContent = text;
    const removing = Boolean(drag.lastOutcome && drag.lastOutcome.removed);
    this.hintChipEl.classList.toggle(
      'is-warning',
      removing || (this.rippleMode && updates.length > 1)
    );
    this.hintChipEl.style.display = 'block';

    const x = this._lastPointer ? this._lastPointer.x : 0;
    const y = this._lastPointer ? this._lastPointer.y : 0;
    const width = this.hintChipEl.offsetWidth;
    this.hintChipEl.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, x - width / 2))}px`;
    this.hintChipEl.style.top = `${Math.max(8, y - 46)}px`;
  }

  hideHint() {
    if (this.hintChipEl) this.hintChipEl.style.display = 'none';
  }

  // ==========================================
  // DRAG MOVE
  // ==========================================

  handlePointerMove(e) {
    // A second finger during a drag is not a second drag.
    if (this.activePointerId != null && e.pointerId !== this.activePointerId) return;

    if (this._pendingTouch) {
      const start = this._pendingTouch.snap;
      const dx = e.clientX - start.clientX;
      const dy = e.clientY - start.clientY;
      // Moved before the press matured, so this is a scroll. touch-action was
      // consulted when the gesture began and cannot be revoked now, which is
      // exactly why the candidate has to be abandoned rather than upgraded.
      if (Math.sqrt(dx * dx + dy * dy) > DragController.TOUCH_SLOP_PX) {
        this.cancelPendingTouch();
      }
      return;
    }

    if (!this.activeDrag) return;

    // What actually holds an armed touch gesture: every move is refused so the
    // browser cannot reclaim it as a pan.
    if (e.pointerType !== 'mouse' && e.cancelable) e.preventDefault();

    this.handleDragMove(e);
  }

  handlePointerUp(e) {
    if (this.activePointerId != null && e.pointerId !== this.activePointerId) return;

    // Released before the long press matured: that was a tap.
    const pending = this.cancelPendingTouch();
    if (pending) {
      this.handleTouchTap(pending.target);
      return;
    }

    this.endDrag(true);
  }

  // A cancelled pointer (a system gesture, an incoming call, capture lost to
  // the OS) is not a drop. There was no rollback path here at all before.
  handlePointerCancel(e) {
    if (this.activePointerId != null && e.pointerId !== this.activePointerId) return;
    this.cancelPendingTouch();
    this.endDrag(false);
  }

  // Tap opens the editor, which is what dblclick does on desktop. Long press is
  // already spoken for by the drag, so the context menu's actions move into the
  // editor rather than hide behind a gesture touch cannot spare.
  handleTouchTap(target) {
    if (target.closest('.segment-pill') || target.closest('.resize-handle')) return;
    const card = target.closest('.timeline-task-card');
    if (!card) return;

    const task = this.state.tasks.find(t => t.id === card.dataset.taskId);
    if (task && this.dom.onTaskInteraction) {
      this.dom.hideTooltip();
      // Which block was tapped, not just which task. The editor needs it to
      // offer the per-block actions a right-click reaches on a desktop; without
      // it, "split" and "remove this block" have nothing to act on.
      this.dom.onTaskInteraction('openEditModal', {
        task,
        segmentId: card.dataset.segmentId || null
      });
    }
  }

  // How close to an edge a drag has to come before the view starts moving, and
  // the fastest it will move, in pixels per frame at the very edge.
  static EDGE_SCROLL_BAND_PX = 56;
  static EDGE_SCROLL_MAX_PX = 14;

  /**
   * Scroll the timeline when a drag reaches its edge.
   *
   * Needed the moment blocks stopped granting the browser a pan (see the
   * touch-action rule on .timeline-task-card): without it a block can only be
   * moved as far as the visible window, which on a phone is a third of a day.
   *
   * The tick has to re-run the move itself. A finger held still at the edge
   * emits no pointer events, so nothing else would recompute the time as the
   * view slides underneath it - the same reason replayDragUnderNewModifiers
   * exists, and the same shape.
   */
  updateEdgeScroll(clientX, clientY) {
    const el = document.getElementById('timeline-workspace');
    if (!el || !this.activeDrag) return this.stopEdgeScroll();

    const r = el.getBoundingClientRect();

    // Only while the pointer is actually over the timeline. Without this a
    // desktop drag held over the sidebar reads as "past the right edge" and
    // scrolls the calendar at full speed the whole time it sits there.
    const inside = clientX >= r.left && clientX <= r.right &&
      clientY >= r.top && clientY <= r.bottom;
    // And not while aiming at the cancel tab, which overlaps the bottom edge.
    if (!inside || this.activeDrag.overCancelTab) return this.stopEdgeScroll();

    const band = DragController.EDGE_SCROLL_BAND_PX;
    const speed = (near, far) => {
      // Ramped by how deep into the band the pointer is, so easing up to the
      // edge slows down rather than stopping dead.
      if (near < band) return -DragController.EDGE_SCROLL_MAX_PX * (1 - Math.max(0, near) / band);
      if (far < band) return DragController.EDGE_SCROLL_MAX_PX * (1 - Math.max(0, far) / band);
      return 0;
    };

    const dy = speed(clientY - r.top, r.bottom - clientY);
    const dx = speed(clientX - r.left, r.right - clientX);

    if (!dx && !dy) return this.stopEdgeScroll();

    this._edgeScroll = { dx, dy };
    if (this._edgeScrollRaf) return;

    const tick = () => {
      if (!this.activeDrag || !this._edgeScroll) {
        this._edgeScrollRaf = null;
        return;
      }
      const before = { top: el.scrollTop, left: el.scrollLeft };
      el.scrollTop += this._edgeScroll.dy;
      el.scrollLeft += this._edgeScroll.dx;

      // Nothing moved, so the view is already at that end - stop rather than
      // spin a frame loop forever.
      if (el.scrollTop === before.top && el.scrollLeft === before.left) {
        this._edgeScrollRaf = null;
        this._edgeScroll = null;
        return;
      }

      this.replayDragUnderNewModifiers();
      this._edgeScrollRaf = requestAnimationFrame(tick);
    };
    this._edgeScrollRaf = requestAnimationFrame(tick);
  }

  stopEdgeScroll() {
    if (this._edgeScrollRaf) cancelAnimationFrame(this._edgeScrollRaf);
    this._edgeScrollRaf = null;
    this._edgeScroll = null;
  }

  handleDragMove(e) {
    if (!this.activeDrag) return;
    if (this.isModalOrOverlayActive()) return;

    this._lastPointer = { x: e.clientX, y: e.clientY };
    this.updatePressTooltip(e.clientX, e.clientY);
    this.updateEdgeScroll(e.clientX, e.clientY);
    this.syncModifiersFromEvent(e);

    const drag = this.activeDrag;

    if (this.globalGhostEl) {
      this.globalGhostEl.style.left = `${e.clientX}px`;
      this.globalGhostEl.style.top = `${e.clientY}px`;
    }

    switch (drag.type) {
      case 'sidebar-drop':
        this.moveSidebarDrop(e, drag);
        break;
      case 'move':
        this.moveBlock(e, drag);
        break;
      case 'resize-right':
        this.resizeRight(e, drag);
        break;
      case 'resize-left':
        this.resizeLeft(e, drag);
        break;
      case 'seam':
        this.moveSeam(e, drag);
        break;
      default:
        break;
    }

    this.scheduleProjection();
  }

  snapMinutesValue(minutes) {
    const snap = this.snapMinutes();
    return snap > 0 ? Math.round(minutes / snap) * snap : minutes;
  }

  moveSidebarDrop(e, drag) {
    const timelineWorkspace = document.getElementById('timeline-workspace');
    const workspaceRect = timelineWorkspace
      ? timelineWorkspace.getBoundingClientRect()
      : this.canvas.canvas.getBoundingClientRect();

    // Asked BEFORE the calendar test, not after: the tab bar is fixed to the
    // bottom of the viewport and sits over the workspace, so a finger on it is
    // also inside that rect. Whichever question is asked first wins, and this
    // one has to.
    const overCancel = Boolean(
      document.elementFromPoint(e.clientX, e.clientY)?.closest('#mobileTabTasks')
    );
    if (overCancel !== Boolean(drag.overCancelTab)) {
      drag.overCancelTab = overCancel;
      document.getElementById('mobileTabTasks')?.classList.toggle('is-drop-target', overCancel);
    }

    const isInsideCalendar = !overCancel && (
      e.clientX >= workspaceRect.left && e.clientX <= workspaceRect.right &&
      e.clientY >= workspaceRect.top && e.clientY <= workspaceRect.bottom
    );
    drag.isOverCalendar = isInsideCalendar;

    if (!isInsideCalendar) {
      if (this.globalGhostEl) this.globalGhostEl.style.opacity = '0.9';
      this.canvas.setPlayhead(null);
      this.canvas.setSnapGuide(null);
      drag.currentStartTime = null;

      const hovered = document.elementFromPoint(e.clientX, e.clientY);
      drag.hoveredSidebarTask = hovered?.closest('.sidebar-task-card')?.dataset.taskId || null;
      drag.hoveredCategory = hovered?.closest('.category-column-body')?.dataset.category || null;
      return;
    }

    if (this.globalGhostEl) this.globalGhostEl.style.opacity = '0.4';

    const point = this.canvas.pointToTimeDay(e.clientX, e.clientY);
    const targetDay = this.state.days[point.dayIndex];

    const minutes = this.snapMinutesValue(point.minutes);
    const clamped = Math.max(0, Math.min(1440 - drag.currentDuration, minutes));

    drag.currentStartTime = targetDay.startTimestamp + clamped * 60;
    drag.currentDayIndex = point.dayIndex;

    const main = this.canvas.timeToMain(clamped);
    this.canvas.setSnapGuide(this.isShiftPressed ? main : null);
    this.canvas.setPlayhead(main);
  }

  moveBlock(e, drag) {
    const { main, cross } = this.canvas.clientToLocal(e.clientX, e.clientY);

    const targetDayIndex = this.canvas.crossToDay(cross);
    const targetDay = this.state.days[targetDayIndex];

    const blockStartMain = main - (drag.offsetMain || 0);
    const minutes = this.snapMinutesValue(this.canvas.mainToTime(blockStartMain));
    const clamped = Math.max(0, Math.min(1440 - drag.currentDuration, minutes));

    drag.currentStartTime = targetDay.startTimestamp + clamped * 60;
    drag.currentDayIndex = targetDayIndex;

    if (drag.domElement) {
      const rect = this.blockRect(targetDayIndex, clamped, clamped + drag.currentDuration);
      drag.domElement.style.left = `${rect.left}px`;
      drag.domElement.style.top = `${rect.top}px`;
      this.applyBlockExtent(drag.domElement, this.mainSizeOf(rect));
      this.setMetaText(drag.domElement, clamped, drag.currentDuration);
    }

    const startMain = this.canvas.timeToMain(clamped);
    this.canvas.setSnapGuide(this.isShiftPressed ? startMain : null);
    this.canvas.setPlayhead(startMain);
  }

  // The two shapes every live drag update needs, in one place so each handler
  // does not repeat the option bag or the which-axis-is-size question.
  blockRect(dayIdx, startMin, endMin) {
    return this.canvas.rectFor(dayIdx, startMin, endMin, {
      crossInset: TimelineCanvas.LANE_INSET,
      minMain: TimelineCanvas.MIN_BLOCK_MAIN
    });
  }

  mainSizeOf(rect) {
    return this.canvas.mainIsX ? rect.width : rect.height;
  }

  resizeRight(e, drag) {
    const deltaMins = Math.round(this.canvas.deltaToMinutes(
      e.clientX - drag.initialClientX,
      e.clientY - drag.initialClientY
    ));
    const snap = this.snapMinutes();
    let newDur = Math.max(PhysicsEngine.MIN_TASK_DURATION_MINUTES, drag.initialDuration + deltaMins);
    if (snap > 0) newDur = Math.max(snap, Math.round(newDur / snap) * snap);

    const day = this.state.days[drag.currentDayIndex];
    const startMins = (drag.initialStartTime - day.startTimestamp) / 60;
    newDur = Math.min(newDur, 1440 - startMins);

    drag.currentDuration = newDur;
    drag.currentStartTime = drag.initialStartTime;

    if (drag.domElement) {
      this.applyBlockExtent(
        drag.domElement,
        this.mainSizeOf(this.blockRect(drag.currentDayIndex, startMins, startMins + newDur))
      );
      this.setMetaText(drag.domElement, startMins, newDur);
    }
    this.canvas.setPlayhead(this.canvas.timeToMain(startMins + newDur));
  }

  resizeLeft(e, drag) {
    const deltaMins = Math.round(this.canvas.deltaToMinutes(
      e.clientX - drag.initialClientX,
      e.clientY - drag.initialClientY
    ));
    const day = this.state.days[drag.currentDayIndex];
    const endTime = drag.initialStartTime + drag.initialDuration * 60;

    let newStartTime = drag.initialStartTime + deltaMins * 60;
    const snap = this.snapMinutes();
    if (snap > 0) newStartTime = PhysicsEngine.snapTimestamp(newStartTime, snap);

    // Keep the block inside the day and never below the minimum duration.
    newStartTime = Math.max(day.startTimestamp, newStartTime);
    newStartTime = Math.min(newStartTime, endTime - PhysicsEngine.MIN_TASK_DURATION_MINUTES * 60);

    const newDur = Math.round((endTime - newStartTime) / 60);
    drag.currentStartTime = newStartTime;
    drag.currentDuration = newDur;

    const startMins = (newStartTime - day.startTimestamp) / 60;

    if (drag.domElement) {
      const rect = this.blockRect(drag.currentDayIndex, startMins, startMins + newDur);
      drag.domElement.style.left = `${rect.left}px`;
      drag.domElement.style.top = `${rect.top}px`;
      this.applyBlockExtent(drag.domElement, this.mainSizeOf(rect));
      this.setMetaText(drag.domElement, startMins, newDur);
    }
    this.canvas.setPlayhead(this.canvas.timeToMain(startMins));
  }

  moveSeam(e, drag) {
    const deltaMins = Math.round(this.canvas.deltaToMinutes(
      e.clientX - drag.initialClientX,
      e.clientY - drag.initialClientY
    ));
    let boundary = drag.initialBoundary + deltaMins * 60;

    const snap = this.snapMinutes();
    if (snap > 0) boundary = PhysicsEngine.snapTimestamp(boundary, snap);

    // The boundary may travel anywhere between the two blocks' outer edges, as
    // long as neither side drops below the minimum duration.
    const minBoundary = drag.left.start + DragController.SEAM_MIN_MINUTES * 60;
    const rightEnd = drag.right.start + drag.right.duration * 60;
    const maxBoundary = rightEnd - DragController.SEAM_MIN_MINUTES * 60;

    drag.currentBoundary = Math.max(minBoundary, Math.min(maxBoundary, boundary));

    this.applySeamToDom(drag);

    const day = this.state.days[drag.currentDayIndex];
    if (day) this.canvas.setPlayhead(this.canvas.timeToMain((drag.currentBoundary - day.startTimestamp) / 60));
  }

  // Both blocks move under the cursor as the seam is dragged, so a joint resize
  // reads as one gesture rather than two separate edits.
  applySeamToDom(drag) {
    const day = this.state.days[drag.currentDayIndex];
    if (!day) return;

    const boundaryMin = (drag.currentBoundary - day.startTimestamp) / 60;
    const boundaryMain = this.canvas.timeToMain(boundaryMin);
    // Which CSS property positions along time. Everything a seam moves - both
    // cards and the handle itself - travels on that one axis.
    const mainProp = this.canvas.mainIsX ? 'left' : 'top';

    const leftStartMin = (drag.left.start - day.startTimestamp) / 60;
    const leftCard = this.cardFor(drag.left.segmentId);
    if (leftCard) {
      this.applyBlockExtent(leftCard, boundaryMain - this.canvas.timeToMain(leftStartMin));
      this.setMetaText(leftCard, leftStartMin, Math.round(boundaryMin - leftStartMin));
      leftCard.classList.add('is-resizing');
    }

    const rightCard = this.cardFor(drag.right.segmentId);
    if (rightCard) {
      const rightEndMin = (drag.right.start - day.startTimestamp) / 60 + drag.right.duration;
      rightCard.style[mainProp] = `${boundaryMain}px`;
      this.applyBlockExtent(rightCard, this.canvas.timeToMain(rightEndMin) - boundaryMain);
      this.setMetaText(rightCard, boundaryMin, Math.round(rightEndMin - boundaryMin));
      rightCard.classList.add('is-resizing');
    }

    if (drag.domElement) drag.domElement.style[mainProp] = `${boundaryMain}px`;
  }

  cardFor(segmentId) {
    return this.dom.blockLayer.querySelector(
      `.timeline-task-card[data-segment-id="${segmentId}"]`
    );
  }

  setMetaText(cardEl, startMinutes, durationMinutes) {
    const metaEl = cardEl.querySelector('.task-meta-text');
    if (!metaEl) return;
    const start = this.canvas.formatTimeLabel(startMinutes);
    const end = this.canvas.formatTimeLabel(startMinutes + durationMinutes);
    metaEl.textContent = `${start} - ${end} (${durationMinutes}m)`;
  }

  // ==========================================
  // DRAG END
  // ==========================================

  async endDrag(commit) {
    this.releasePointer();
    this.stopEdgeScroll();
    this._pressTooltipFrom = null;
    this.dom.hideTooltip();
    document.body.classList.remove('is-touch-dragging');
    document.getElementById('mobileTabTasks')?.classList.remove('is-drop-target');
    if (!this.activeDrag) return;

    const drag = this.activeDrag;
    this.activeDrag = null;

    if (this._projectionRaf) {
      cancelAnimationFrame(this._projectionRaf);
      this._projectionRaf = null;
    }

    this.dom.clearProjection();
    this.hideHint();
    this.hideTouchModeChip();
    this.canvas.setPlayhead(null);
    this.canvas.setSnapGuide(null);
    document.body.classList.remove('is-seam-dragging');

    if (drag.domElement) {
      drag.domElement.classList.remove('is-dragging', 'is-resizing', 'is-active');
    }
    this.dom.blockLayer.querySelectorAll('.is-resizing').forEach(el => {
      el.classList.remove('is-resizing');
    });

    if (this.globalGhostEl) {
      this.globalGhostEl.remove();
      this.globalGhostEl = null;
    }

    // A cancelled gesture leaves every card sitting at its dragged pixels with
    // the model untouched, so a re-render IS the rollback.
    if (!commit) {
      this.dom.render();
      return;
    }

    // Dropped on the Tasks tab: put it back, unscheduled. The only way out of a
    // drag once the pane has been handed over, since the list it came from is
    // no longer on screen to drop back into.
    if (drag.type === 'sidebar-drop' && drag.overCancelTab) {
      this.dom.render();
      return;
    }

    // Dropped back into the sidebar: this is a reorder, not a schedule change.
    if (drag.type === 'sidebar-drop' && !drag.isOverCalendar) {
      if (this.onReorderTasks) {
        this.onReorderTasks(drag.taskId, drag.hoveredSidebarTask, drag.hoveredCategory);
      }
      return;
    }

    const updates = this.resolveDragOutcome(drag);
    if (!updates.length) {
      this.dom.render();
      return;
    }

    await this.onCommitChanges(updates, DragController.historyLabelFor(drag));
  }

  // What the undo entry for this gesture is called. Named after what the user
  // did, not after which branch of the physics ran.
  static historyLabelFor(drag) {
    if (drag.type === 'seam') return 'Move shared boundary';
    if (drag.type === 'sidebar-drop') return 'Schedule task';

    const kind = drag.lastOutcome && drag.lastOutcome.kind;
    if (kind === 'divider') return 'Trade time between blocks';

    if (drag.type === 'resize-left' || drag.type === 'resize-right') return 'Resize block';
    return 'Move block';
  }
}
