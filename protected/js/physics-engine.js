// Klndr Physics & Timeline Layout Engine
// Handles Cascading Ripples, Session Splitting, Collision Detection, and Snapping

const PhysicsEngine = {
  MIN_TASK_DURATION_MINUTES: 15,

  /**
   * Helper: Flatten task into individual segments with reference to parent task
   */
  getSegmentsForDay(tasks, dayStartTimestamp, dayEndTimestamp) {
    const segments = [];

    tasks.forEach(task => {
      if (!task.start_times || task.start_times.length === 0) return;

      task.start_times.forEach((st, idx) => {
        const dur = task.durations[idx] || task.total_duration || 60;
        const et = st + dur * 60;

        // Check if segment is in this day
        if (st < dayEndTimestamp && et > dayStartTimestamp) {
          segments.push({
            taskId: task.id,
            segmentIndex: idx,
            startTime: st,
            duration: dur,
            endTime: et,
            isLocked: task.is_locked !== false,
            taskRef: task
          });
        }
      });
    });

    // Sort chronologically by start time
    segments.sort((a, b) => a.startTime - b.startTime);
    return segments;
  },

  /**
   * Snapping logic: Snap timestamp to resolution (e.g. 15min, 30min, or custom bucket)
   */
  snapTimestamp(timestamp, snapMinutes = 15) {
    const snapSeconds = snapMinutes * 60;
    return Math.round(timestamp / snapSeconds) * snapSeconds;
  },

  /**
   * Detect collisions between a target segment and existing segments
   */
  findCollisions(targetSegment, existingSegments, excludeTaskId = null) {
    const collisions = [];
    const tStart = targetSegment.startTime;
    const tEnd = tStart + targetSegment.duration * 60;

    for (const seg of existingSegments) {
      if (excludeTaskId && seg.taskId === excludeTaskId) continue;

      const segStart = seg.startTime;
      const segEnd = seg.endTime;

      // Overlap condition: start < otherEnd && end > otherStart
      if (tStart < segEnd && tEnd > segStart) {
        collisions.push(seg);
      }
    }

    return collisions;
  },

  /**
   * Cascading Ripple Effect:
   * When targetSegment occupies [tStart, tEnd], any following segment that overlaps gets pushed or compressed.
   * If is_locked is true, the collided segment is pushed forward by the overlap delta.
   * If is_locked is false, it is compressed down to MIN_TASK_DURATION_MINUTES before sliding.
   * Returns a map of taskId -> { start_times, durations, total_duration } with updated values.
   */
  calculateRipple(allTasks, dayStartTimestamp, dayEndTimestamp, activeTaskId, activeSegmentIndex, newStartTime, newDuration) {
    const updates = new Map();
    const dayTasks = allTasks.filter(t => {
      if (!t.start_times || t.start_times.length === 0) return false;
      return t.start_times.some((st, idx) => {
        const et = st + (t.durations[idx] || 60) * 60;
        return st < dayEndTimestamp && et > dayStartTimestamp;
      });
    });

    // Clone all segments on this day
    const segments = [];
    dayTasks.forEach(task => {
      task.start_times.forEach((st, idx) => {
        const dur = task.durations[idx] || 60;
        const isTarget = task.id === activeTaskId && idx === activeSegmentIndex;
        segments.push({
          taskId: task.id,
          segmentIndex: idx,
          startTime: isTarget ? newStartTime : st,
          duration: isTarget ? newDuration : dur,
          endTime: isTarget ? newStartTime + newDuration * 60 : st + dur * 60,
          isLocked: task.is_locked !== false,
          isTarget,
          taskRef: task
        });
      });
    });

    // Sort all non-target segments starting at or after the target start time
    let targetSeg = segments.find(s => s.isTarget);

    // The active task may not be on this day yet — dragged in from another day or
    // straight from the sidebar. Inject it so the destination day still ripples
    // instead of silently doing nothing.
    if (!targetSeg) {
      const activeTask = allTasks.find(t => t.id === activeTaskId);
      if (!activeTask) return updates;

      targetSeg = {
        taskId: activeTaskId,
        segmentIndex: activeSegmentIndex || 0,
        startTime: newStartTime,
        duration: newDuration,
        endTime: newStartTime + newDuration * 60,
        isLocked: activeTask.is_locked !== false,
        isTarget: true,
        taskRef: activeTask
      };
      segments.push(targetSeg);
    }

    // Only segments that reach into or past the target can be displaced. Without
    // the endTime test a segment sitting hours EARLIER in the day still compares
    // as "before the push boundary" and gets dragged forward with everything
    // else, which scrambles the untouched part of the schedule.
    const otherSegments = segments
      .filter(s => !s.isTarget && s.endTime > targetSeg.startTime)
      .sort((a, b) => a.startTime - b.startTime);

    let currentPushBoundary = targetSeg.startTime + targetSeg.duration * 60;

    for (let i = 0; i < otherSegments.length; i++) {
      const seg = otherSegments[i];

      // If this segment starts before the current pushed boundary and overlaps
      if (seg.startTime < currentPushBoundary) {
        const overlapSeconds = currentPushBoundary - seg.startTime;
        const overlapMinutes = Math.ceil(overlapSeconds / 60);

        if (seg.isLocked) {
          // Locked: Push forward entirely
          seg.startTime = currentPushBoundary;
          seg.endTime = seg.startTime + seg.duration * 60;
          currentPushBoundary = seg.endTime;
        } else {
          // Unlocked: Try compressing first
          const currentDur = seg.duration;
          const maxCompressible = currentDur - this.MIN_TASK_DURATION_MINUTES;

          if (overlapMinutes <= maxCompressible) {
            // Can absorb overlap completely by compressing
            seg.startTime = currentPushBoundary;
            seg.duration = currentDur - overlapMinutes;
            seg.endTime = seg.startTime + seg.duration * 60;
            currentPushBoundary = seg.endTime;
          } else {
            // Compress to min duration and push the rest
            seg.duration = this.MIN_TASK_DURATION_MINUTES;
            seg.startTime = currentPushBoundary;
            seg.endTime = seg.startTime + seg.duration * 60;
            currentPushBoundary = seg.endTime;
          }
        }
      } else {
        // If not overlapping, update current boundary to this segment's end if it's beyond
        currentPushBoundary = Math.max(currentPushBoundary, seg.endTime);
      }
    }

    // Build the updates map for tasks whose segments changed
    segments.forEach(seg => {
      const task = seg.taskRef;
      if (!updates.has(task.id)) {
        updates.set(task.id, {
          id: task.id,
          start_times: [...task.start_times],
          durations: [...task.durations],
          total_duration: task.total_duration
        });
      }

      const taskUpdate = updates.get(task.id);
      taskUpdate.start_times[seg.segmentIndex] = seg.startTime;
      taskUpdate.durations[seg.segmentIndex] = seg.duration;
      taskUpdate.total_duration = taskUpdate.durations.reduce((sum, d) => sum + d, 0);
    });

    return updates;
  },

  /**
   * Session Splitting Engine:
   * When placing/expanding a task of totalDuration starting at idealStartTime,
   * if it collides with fixed obstacles (like Breaks or locked tasks),
   * split it across the available free gaps on the day.
   */
  calculateSessionSplit(allTasks, dayStartTimestamp, dayEndTimestamp, activeTaskId, idealStartTime, totalDurationMinutes) {
    // 1. Get all obstacle segments on this day (excluding active task)
    const existingSegments = this.getSegmentsForDay(allTasks, dayStartTimestamp, dayEndTimestamp)
      .filter(s => s.taskId !== activeTaskId);

    // 2. Find available time windows starting from idealStartTime
    let remainingMinutesToPlace = totalDurationMinutes;
    let currentCursor = idealStartTime;
    const splitSegments = [];

    // Max loop safeguard
    let iterations = 0;
    while (remainingMinutesToPlace > 0 && iterations < 20) {
      iterations++;

      // Check if currentCursor falls inside any existing segment
      const obstacleAtCursor = existingSegments.find(s => currentCursor >= s.startTime && currentCursor < s.endTime);
      if (obstacleAtCursor) {
        // Jump cursor to after the obstacle
        currentCursor = obstacleAtCursor.endTime;
        continue;
      }

      // Find the next upcoming obstacle after currentCursor
      const nextObstacle = existingSegments
        .filter(s => s.startTime > currentCursor)
        .sort((a, b) => a.startTime - b.startTime)[0];

      if (!nextObstacle) {
        // No more obstacles! Place all remaining minutes
        splitSegments.push({
          startTime: currentCursor,
          duration: remainingMinutesToPlace
        });
        remainingMinutesToPlace = 0;
      } else {
        // Available gap between currentCursor and nextObstacle.startTime
        const availableSeconds = nextObstacle.startTime - currentCursor;
        const availableMinutes = Math.floor(availableSeconds / 60);

        if (availableMinutes >= this.MIN_TASK_DURATION_MINUTES) {
          if (remainingMinutesToPlace <= availableMinutes) {
            // Fits completely in this gap
            splitSegments.push({
              startTime: currentCursor,
              duration: remainingMinutesToPlace
            });
            remainingMinutesToPlace = 0;
          } else {
            // Partially fits: consume the whole gap, then jump after nextObstacle
            splitSegments.push({
              startTime: currentCursor,
              duration: availableMinutes
            });
            remainingMinutesToPlace -= availableMinutes;
            currentCursor = nextObstacle.endTime;
          }
        } else {
          // Gap is too small (< MIN_TASK_DURATION_MINUTES), jump past obstacle
          currentCursor = nextObstacle.endTime;
        }
      }
    }

    // Return start_times array and durations array
    return {
      start_times: splitSegments.map(s => s.startTime),
      durations: splitSegments.map(s => s.duration),
      total_duration: totalDurationMinutes
    };
  }
};
