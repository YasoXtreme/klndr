// Klndr Physics & Timeline Layout Engine
//
// Everything here works on a flat list of SEGMENTS, not on tasks. A segment is
// one block on the calendar; a task's own blocks are ordinary obstacles to each
// other, exactly like anyone else's. That is the whole point of the model — a
// block is a real thing you can push, split and delete on its own.
//
// Entry shape: { taskId, segmentId, startTime, duration, endTime, isLocked, completed }

const PhysicsEngine = {
  MIN_TASK_DURATION_MINUTES: 15,

  // Below this, a shift is not a move. Without snapping on, a drop carries
  // arbitrary seconds, and the block after it in a cascade gets nudged by a
  // fraction of a minute -- invisible on screen, not worth a write, and not
  // something to count out loud. The commit path prunes at the same threshold.
  NEGLIGIBLE_SECONDS: 30,

  /**
   * Snapping logic: Snap timestamp to resolution (e.g. 15min, 30min, or custom bucket)
   */
  snapTimestamp(timestamp, snapMinutes = 15) {
    const snapSeconds = snapMinutes * 60;
    return Math.round(timestamp / snapSeconds) * snapSeconds;
  },

  /**
   * Every segment overlapping the given day, in time order. Siblings of the
   * active task are deliberately included: excluding them is what used to let a
   * block land on top of its own sibling with no collision detected.
   */
  daySegments(tasks, dayStartTimestamp, dayEndTimestamp, excludeSegmentId = null) {
    const entries = [];

    (tasks || []).forEach(task => {
      (task.segments || []).forEach(segment => {
        if (segment.id === excludeSegmentId) return;

        const end = segment.start_time + segment.duration * 60;
        if (segment.start_time >= dayEndTimestamp || end <= dayStartTimestamp) return;

        entries.push({
          taskId: task.id,
          segmentId: segment.id,
          startTime: segment.start_time,
          duration: segment.duration,
          endTime: end,
          isLocked: task.is_locked !== false,
          completed: Boolean(segment.completed)
        });
      });
    });

    entries.sort((a, b) => a.startTime - b.startTime);
    return entries;
  },

  /**
   * Cascading ripple: the target occupies [start, start + duration]; anything
   * reaching into or past it is pushed forward, compressing first when the task
   * is unlocked. Returns the entries that actually moved.
   *
   * Only segments that END after the target's start can be displaced — without
   * that test a block sitting hours earlier still compares as "before the push
   * boundary" and gets dragged along with everything else.
   */
  ripple(obstacles, targetStart, targetDuration) {
    const moved = [];
    let boundary = targetStart + targetDuration * 60;

    const affected = obstacles
      .filter(entry => entry.endTime > targetStart)
      .sort((a, b) => a.startTime - b.startTime);

    affected.forEach(entry => {
      if (entry.startTime >= boundary) {
        boundary = Math.max(boundary, entry.endTime);
        return;
      }

      const overlapMinutes = Math.ceil((boundary - entry.startTime) / 60);
      const wasStart = entry.startTime;
      const wasDuration = entry.duration;

      if (!entry.isLocked) {
        // Unlocked blocks give up time before they give up their place.
        const compressible = entry.duration - this.MIN_TASK_DURATION_MINUTES;
        entry.duration = overlapMinutes <= compressible
          ? entry.duration - overlapMinutes
          : this.MIN_TASK_DURATION_MINUTES;
      }

      entry.startTime = boundary;
      entry.endTime = entry.startTime + entry.duration * 60;
      // The cascade always advances past this block, but a sub-minute nudge is
      // not a displacement and must not be reported as one.
      boundary = entry.endTime;
      if (Math.abs(entry.startTime - wasStart) >= this.NEGLIGIBLE_SECONDS ||
          entry.duration !== wasDuration) {
        moved.push(entry);
      }
    });

    return moved;
  },

  /**
   * Place `totalMinutes` starting at `idealStart`, flowing around obstacles.
   * Returns the pieces it had to break into — one entry when it fits whole.
   */
  placeAround(obstacles, idealStart, totalMinutes, dayEndTimestamp) {
    const pieces = [];
    let remaining = totalMinutes;
    let cursor = idealStart;
    let guard = 0;

    while (remaining > 0 && guard++ < 40) {
      const blocking = obstacles.find(o => cursor >= o.startTime && cursor < o.endTime);
      if (blocking) {
        cursor = blocking.endTime;
        continue;
      }

      const next = obstacles
        .filter(o => o.startTime > cursor)
        .sort((a, b) => a.startTime - b.startTime)[0];

      const limit = next ? next.startTime : (dayEndTimestamp || Infinity);
      const availableMinutes = Math.floor((limit - cursor) / 60);

      if (!next && !Number.isFinite(limit)) {
        pieces.push({ startTime: cursor, duration: remaining });
        remaining = 0;
        break;
      }

      if (availableMinutes >= remaining) {
        pieces.push({ startTime: cursor, duration: remaining });
        remaining = 0;
        break;
      }

      if (availableMinutes >= this.MIN_TASK_DURATION_MINUTES) {
        pieces.push({ startTime: cursor, duration: availableMinutes });
        remaining -= availableMinutes;
      }

      if (!next) break;
      cursor = next.endTime;
    }

    // Nowhere legal to put it: leave it where the user dropped it rather than
    // silently discarding the block.
    if (!pieces.length) pieces.push({ startTime: idealStart, duration: totalMinutes });
    return pieces;
  },

  /**
   * Reflect the timeline about zero so a forward algorithm runs backwards.
   *
   * Dragging a block's LEFT edge grows it into the past, which is the mirror
   * image of every rule already written for growing into the future. Mirroring
   * the input beats keeping a second, subtly different copy of ripple() and
   * placeAround() in sync with the first.
   */
  mirrorEntry(entry) {
    return { ...entry, startTime: -entry.endTime, endTime: -entry.startTime, _source: entry };
  },

  // Write a mirrored entry's result back onto the real entry it came from.
  unmirrorEntry(mirrored) {
    const source = mirrored._source;
    source.startTime = -mirrored.endTime;
    source.duration = mirrored.duration;
    source.endTime = source.startTime + source.duration * 60;
    return source;
  },

  // Ripple into the past: blocks in the way are pushed EARLIER, compressing
  // first when unlocked, exactly as the forward ripple pushes them later.
  rippleBackward(obstacles, targetEnd, targetDuration) {
    const mirrored = obstacles.map(entry => this.mirrorEntry(entry));
    return this.ripple(mirrored, -targetEnd, targetDuration)
      .map(entry => this.unmirrorEntry(entry));
  },

  /**
   * Place `totalMinutes` ending at `idealEnd`, flowing backwards around
   * obstacles. The first piece is the one touching `idealEnd` — it is the piece
   * the user is actually dragging, so it keeps the block's identity.
   */
  placeAroundBackward(obstacles, idealEnd, totalMinutes, dayStartTimestamp) {
    const mirrored = obstacles.map(entry => this.mirrorEntry(entry));
    const limit = Number.isFinite(dayStartTimestamp) ? -dayStartTimestamp : null;

    return this.placeAround(mirrored, -idealEnd, totalMinutes, limit)
      .map(piece => ({
        startTime: -(piece.startTime + piece.duration * 60),
        duration: piece.duration
      }));
  },

  /**
   * A block dragged between two touching blocks of ONE task acts as the divider
   * between them: the pair's outer edges stay pinned and time transfers from one
   * side to the other. Moving a break inside a study session is meant to change
   * where the break falls, not to shove the rest of the day along.
   *
   * Returns null unless the moved block genuinely sits between two siblings that
   * it touches on both sides.
   */
  findDivider(obstacles, movedStart, movedEnd) {
    const before = obstacles
      .filter(entry => Math.abs(entry.endTime - movedStart) <= 30)
      .sort((a, b) => b.startTime - a.startTime)[0];
    if (!before) return null;

    const after = obstacles
      .filter(entry => Math.abs(entry.startTime - movedEnd) <= 30)
      .sort((a, b) => a.startTime - b.startTime)[0];
    if (!after) return null;

    if (before.taskId !== after.taskId) return null;
    if (before.segmentId === after.segmentId) return null;

    return { left: before, right: after };
  },

  /**
   * Apply a divider move. The left block ends where the moved block starts and
   * the right block begins where it ends; the pair's outer bounds never move.
   *
   * A side squeezed past the minimum is marked for removal rather than clamped —
   * eating a block is a deliberate gesture, and the preview shows it happening
   * before release. A side that is already COMPLETED is never eaten: the
   * schedule can be dragged back, a completion cannot.
   */
  applyDivider(divider, movedStart, movedEnd) {
    const { left, right } = divider;
    const leftOuter = left.startTime;
    const rightOuter = right.endTime;
    const floor = this.MIN_TASK_DURATION_MINUTES * 60;

    const result = { changed: [], removed: [], blockedByCompleted: false };

    let start = movedStart;
    let end = movedEnd;

    if (left.completed && start < leftOuter + floor) {
      start = leftOuter + floor;
      end = start + (movedEnd - movedStart);
      result.blockedByCompleted = true;
    }
    if (right.completed && end > rightOuter - floor) {
      end = rightOuter - floor;
      start = end - (movedEnd - movedStart);
      result.blockedByCompleted = true;
    }

    result.movedStart = start;
    result.movedEnd = end;

    const leftMinutes = Math.round((start - leftOuter) / 60);
    if (leftMinutes < this.MIN_TASK_DURATION_MINUTES) {
      result.removed.push(left);
    } else {
      left.duration = leftMinutes;
      left.endTime = leftOuter + leftMinutes * 60;
      result.changed.push(left);
    }

    const rightMinutes = Math.round((rightOuter - end) / 60);
    if (rightMinutes < this.MIN_TASK_DURATION_MINUTES) {
      result.removed.push(right);
    } else {
      right.startTime = end;
      right.duration = rightMinutes;
      result.changed.push(right);
    }

    return result;
  }
};
