// Klndr Task/Segment Model
//
// A task owns its identity (title, colour, icon, category, lock). A SEGMENT is
// one block of that task on the calendar. Segments are independent — each has
// its own start, duration and completion — but they all belong to one task, and
// the tasks panel only ever shows the task.
//
// Segments carry state, so they must not be identified by their position in an
// array: re-sorting after a drag would hand a segment's completion to a
// different block. Every segment therefore has a stable id, and `segments` is
// the source of truth.
//
// start_times / durations / total_duration / completed are kept in sync as
// DERIVED fields. The server queries the week by start_times and older records
// only have the parallel arrays, so they stay authoritative on the wire while
// segments are authoritative in memory.

const TaskModel = {
  MIN_SEGMENT_MINUTES: 15,

  newSegmentId() {
    return `seg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  },

  /**
   * Normalise a task in place and return its segments. Records written before
   * segments existed are migrated on read: every block inherits the task-level
   * completed flag, which is the only information the old shape carried.
   */
  ensureSegments(task) {
    if (!task) return [];

    if (!Array.isArray(task.segments)) {
      const starts = Array.isArray(task.start_times) ? task.start_times : [];
      const durations = Array.isArray(task.durations) ? task.durations : [];
      task.segments = starts.map((start, i) => ({
        id: this.newSegmentId(),
        start_time: start,
        duration: durations[i] || 60,
        completed: Boolean(task.completed)
      }));
    }

    // Guard against a partially-formed segment arriving from anywhere.
    task.segments = task.segments
      .filter(seg => seg && Number.isFinite(seg.start_time))
      .map(seg => ({
        id: seg.id || this.newSegmentId(),
        start_time: seg.start_time,
        duration: Math.max(this.MIN_SEGMENT_MINUTES, Number(seg.duration) || 60),
        completed: Boolean(seg.completed)
      }));

    this.sort(task);
    return task.segments;
  },

  // Segments are always held in time order: the pill numbering is positional,
  // so "2 of 3" always means the second block of the day, whatever order the
  // edits arrived in.
  sort(task) {
    task.segments.sort((a, b) => a.start_time - b.start_time);
    return task.segments;
  },

  /**
   * Rebuild the derived fields from segments. Everything that mutates segments
   * must end here, or the wire format and the in-memory model drift apart.
   */
  syncDerived(task) {
    const segs = task.segments || [];
    task.start_times = segs.map(s => s.start_time);
    task.durations = segs.map(s => s.duration);

    if (segs.length) {
      task.total_duration = segs.reduce((sum, s) => sum + s.duration, 0);
      // A task is done when every one of its blocks is done. For a scheduled
      // task this flag is never set directly — only computed.
      task.completed = segs.every(s => s.completed);
    }

    return task;
  },

  setSegments(task, segments) {
    task.segments = segments;
    this.ensureSegments(task);
    return this.syncDerived(task);
  },

  segmentById(task, segmentId) {
    return (task.segments || []).find(s => s.id === segmentId) || null;
  },

  indexById(task, segmentId) {
    return (task.segments || []).findIndex(s => s.id === segmentId);
  },

  isSplit(task) {
    return (task.segments || []).length > 1;
  },

  segmentEnd(segment) {
    return segment.start_time + segment.duration * 60;
  },

  /**
   * 'none' | 'partial' | 'all' — the tasks panel needs the middle one, which the
   * old boolean could not express.
   */
  completionState(task) {
    const segs = task.segments || [];
    if (!segs.length) return task.completed ? 'all' : 'none';

    const done = segs.filter(s => s.completed).length;
    if (done === 0) return 'none';
    if (done === segs.length) return 'all';
    return 'partial';
  },

  setAllSegmentsCompleted(task, completed) {
    (task.segments || []).forEach(seg => { seg.completed = completed; });
    if (!(task.segments || []).length) task.completed = completed;
    return this.syncDerived(task);
  },

  /**
   * Split one segment at an absolute timestamp. Both halves keep the parent's
   * completion state — splitting a finished block leaves two finished blocks.
   * Returns the new segment, or null when the cut would leave either side under
   * the minimum.
   */
  splitSegmentAt(task, segmentId, timestamp) {
    const seg = this.segmentById(task, segmentId);
    if (!seg) return null;

    const leftMinutes = Math.round((timestamp - seg.start_time) / 60);
    const rightMinutes = seg.duration - leftMinutes;
    if (leftMinutes < this.MIN_SEGMENT_MINUTES || rightMinutes < this.MIN_SEGMENT_MINUTES) {
      return null;
    }

    const right = {
      id: this.newSegmentId(),
      start_time: seg.start_time + leftMinutes * 60,
      duration: rightMinutes,
      completed: seg.completed
    };

    seg.duration = leftMinutes;
    task.segments.push(right);
    this.setSegments(task, task.segments);
    return right;
  },

  removeSegment(task, segmentId) {
    task.segments = (task.segments || []).filter(s => s.id !== segmentId);
    return this.syncDerived(task);
  },

  /**
   * The shape sent to the API. `segments` is what matters; the parallel arrays
   * ride along so the server's date-range query and any legacy reader still work.
   */
  updatePayload(task) {
    this.syncDerived(task);
    return {
      id: task.id,
      segments: (task.segments || []).map(s => ({ ...s })),
      start_times: [...task.start_times],
      durations: [...task.durations],
      total_duration: task.total_duration,
      completed: task.completed
    };
  },

  /**
   * Build a commit payload from a set of segments WITHOUT touching the live
   * task, so the commit path can still snapshot the pre-edit state for rollback.
   * Callers mutate a clone and hand it here.
   */
  payloadFrom(task, segments) {
    if (!task) return null;
    const sorted = [...segments].sort((a, b) => a.start_time - b.start_time);
    return {
      id: task.id,
      segments: sorted.map(seg => ({ ...seg })),
      start_times: sorted.map(seg => seg.start_time),
      durations: sorted.map(seg => seg.duration),
      total_duration: sorted.length
        ? sorted.reduce((sum, seg) => sum + seg.duration, 0)
        : task.total_duration,
      completed: sorted.length ? sorted.every(seg => seg.completed) : task.completed
    };
  },

  // Clone segments for speculative work (previews, physics) without touching
  // the live task.
  cloneSegments(task) {
    return (task.segments || []).map(s => ({ ...s }));
  }
};
