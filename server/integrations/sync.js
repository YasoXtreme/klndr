const db = require("../db");
const categories = require("../categories");
const KlndrPalette = require("../../protected/js/palette");
const { getAccessToken } = require("./tokens");

// Turns NormalizedItems into klndr tasks.
//
// This file knows nothing about any particular source app: it sees the shape
// from connector.js and the klndr task collection, and nothing else.
//
// The rule that makes the whole thing safe: **the source owns what the work
// is, klndr owns when it happens and what it looks like.** Titles, category
// NAMES and completion come from the source. Segments, start times and
// durations of scheduled blocks are the person's and are never written by a
// sync.
//
// Colour and icon used to come from the source too. They no longer do: a
// subject name is resolved to one of the person's categories, and that category
// hands over its own default colour and icon. Otherwise an imported task would
// ignore the look its category already has, and a subject the person had
// already styled would be repainted on the next revision bump.

const THROTTLE_SECONDS = 5 * 60;

function now() {
  return Math.floor(Date.now() / 1000);
}

function isScheduled(task) {
  return Array.isArray(task.start_times) && task.start_times.length > 0;
}

/**
 * Applies completion to a task the way klndr represents it.
 *
 * An unscheduled task carries the flag itself. A scheduled one does not: the
 * client recomputes `completed` from its segments on every render
 * (TaskModel.syncDerived), so setting the task-level flag alone would be
 * overwritten the moment anything redrew. Both shapes have to be handled.
 */
function completionPatch(task, completed) {
  const segments = Array.isArray(task.segments) ? task.segments : [];
  if (segments.length === 0) return { completed };
  return {
    completed,
    segments: segments.map((segment) => ({ ...segment, completed })),
  };
}

/**
 * One pass over a provider's items.
 *
 * Returns counts rather than tasks: the client reloads its own week
 * afterwards, and handing back a partial task list would only invite the two
 * to disagree.
 */
async function syncProvider(userId, connector, options = {}) {
  const integration = await db.getIntegration(userId, connector.id);
  if (!integration) {
    const error = new Error(`No ${connector.id} connection for this account.`);
    error.status = 404;
    throw error;
  }

  if (
    !options.force &&
    integration.last_synced_at &&
    now() - integration.last_synced_at < THROTTLE_SECONDS
  ) {
    return { skipped: true, reason: "throttled", ...emptyCounts() };
  }

  const accessToken = await getAccessToken(userId, connector);

  let items;
  try {
    items = await connector.fetchItems(accessToken);
  } catch (err) {
    await db.updateIntegration(userId, connector.id, { last_sync_error: err.message });
    throw err;
  }

  const dismissed = new Set(integration.dismissed_ids || []);
  const existing = await db.getTasksBySource(userId, connector.id);
  const bySourceId = new Map(existing.map((task) => [task.source_id, task]));

  // Resolve every subject in one pass, before the loop. A name the person
  // already has a category for is matched to it; anything new becomes a
  // category with a colour no other category has taken. Doing this per item
  // would be a settings read and write per imported row, and two new subjects
  // in the same sync would each pick a colour without seeing the other's.
  //
  // Only the items that will actually become or update a task count. A subject
  // whose sessions are all finished or all dismissed never reaches the tasks
  // panel, and inventing a category for it would leave the person with a
  // colour, a column and a filter pill for work they will never see.
  const wanted = items
    .filter(
      (item) =>
        bySourceId.has(item.external_id) ||
        (!item.completed && !dismissed.has(item.external_id)),
    )
    .map((item) => ({ name: item.category, fallbackIcon: item.icon }));
  const categoriesByName = await categories.ensureCategories(userId, wanted);

  // A source that gives no category leaves the task uncategorised, keeping the
  // connector's icon and falling back to the default colour - there is no
  // category to ask, and connectors no longer carry a colour of their own.
  const styleFor = (item) => {
    const category = categoriesByName.get(String(item.category || "").toLowerCase());
    return category
      ? { category: category.name, color: category.color, icon: category.icon }
      : { category: null, color: KlndrPalette.DEFAULT_COLOR, icon: item.icon };
  };

  const counts = emptyCounts();
  // Completion changes made in klndr since the last sync, pushed back after
  // the pass so one failure cannot abandon the rest of it.
  const toPush = [];

  for (const item of items) {
    const task = bySourceId.get(item.external_id);

    if (!task) {
      // Never seen it. Import only outstanding work: importing something the
      // person already finished would just be clutter.
      if (item.completed || dismissed.has(item.external_id)) continue;

      const style = styleFor(item);
      await db.createTask(userId, {
        title: item.title,
        // No segments and no start times, so it lands in the tasks panel to be
        // dragged onto the week. This is also what makes it survive the week
        // filter in getTasks, which passes anything unscheduled.
        segments: [],
        start_times: [],
        durations: [],
        total_duration: item.duration_minutes,
        default_timing: item.duration_minutes,
        color: style.color,
        icon: style.icon,
        category: style.category,
        completed: false,
        source_app: connector.id,
        source_id: item.external_id,
        source_url: item.url,
        source_revision: item.revision,
        source_completed: false,
        // Namespaced under `source` so a connector can never collide with
        // whatever klndr itself decides to put in metadata later.
        metadata: item.metadata ? { source: item.metadata } : {},
      });
      counts.created += 1;
      continue;
    }

    const patch = {};

    // Identity: the source owns it, so re-apply whenever the item changed.
    // Colour and icon follow the resolved category rather than the source, and
    // are only re-asserted when the subject actually moved the task to a
    // different category - repainting on every revision bump would undo a
    // colour the person chose on that task.
    if (task.source_revision !== item.revision) {
      const style = styleFor(item);
      patch.title = item.title;
      patch.source_url = item.url;
      patch.source_revision = item.revision;
      if (item.metadata) patch.metadata = { ...task.metadata, source: item.metadata };
      if (style.category !== task.category) {
        patch.category = style.category;
        patch.color = style.color;
        patch.icon = style.icon;
      }
      // Duration is the source's only while the person has not placed the
      // task. Once there are segments on the calendar, the length of those
      // blocks is theirs and a sync must not rewrite it.
      if (!isScheduled(task)) {
        patch.default_timing = item.duration_minutes;
        patch.total_duration = item.duration_minutes;
      }
    }

    // Completion, reconciled three ways against what the source last said.
    const sourceChanged = item.completed !== Boolean(task.source_completed);
    const localChanged = Boolean(task.completed) !== Boolean(task.source_completed);

    if (sourceChanged) {
      // The source is the system of record for whether work is done, so it
      // wins even when both sides moved.
      Object.assign(patch, completionPatch(task, item.completed));
      patch.source_completed = item.completed;
      counts.completionPulled += 1;
    } else if (localChanged) {
      toPush.push({ externalId: item.external_id, completed: Boolean(task.completed) });
    }

    if (Object.keys(patch).length > 0) {
      await db.updateTask(userId, task.id, patch);
      counts.updated += 1;
    }

    bySourceId.delete(item.external_id);
  }

  // Anything left was imported once and no longer exists upstream. Drop the
  // ones nobody has scheduled; detach the ones that are on the calendar rather
  // than deleting work the person has already planned around.
  for (const orphan of bySourceId.values()) {
    if (isScheduled(orphan)) {
      await db.updateTask(userId, orphan.id, {
        source_app: null,
        source_id: null,
        source_url: null,
        source_revision: null,
      });
      counts.detached += 1;
    } else {
      await db.deleteTask(userId, orphan.id);
      counts.removed += 1;
    }
  }

  for (const push of toPush) {
    try {
      await connector.pushCompletion(accessToken, push.externalId, push.completed);
      const task = existing.find((row) => row.source_id === push.externalId);
      if (task) {
        await db.updateTask(userId, task.id, { source_completed: push.completed });
      }
      counts.completionPushed += 1;
    } catch (err) {
      // One rejected item must not fail the sync. It will be retried next time,
      // because source_completed is only advanced on success.
      console.error(`Failed to push completion for ${push.externalId}:`, err.message);
    }
  }

  await db.updateIntegration(userId, connector.id, {
    last_synced_at: now(),
    last_sync_error: null,
  });

  return { skipped: false, ...counts };
}

/**
 * Pushes one task's completion immediately, so ticking something off does not
 * wait for the next sync. Failures are swallowed: the reconciliation above
 * will catch up, and a toast about a background push would be noise.
 */
async function pushCompletionNow(userId, connector, taskId) {
  const tasks = await db.getTasksBySource(userId, connector.id);
  const task = tasks.find((row) => row.id === taskId);
  if (!task || !task.source_id) return false;

  const completed = Boolean(task.completed);
  if (completed === Boolean(task.source_completed)) return false;

  const accessToken = await getAccessToken(userId, connector);
  await connector.pushCompletion(accessToken, task.source_id, completed);
  await db.updateTask(userId, task.id, { source_completed: completed });
  return true;
}

function emptyCounts() {
  return {
    created: 0,
    updated: 0,
    removed: 0,
    detached: 0,
    completionPulled: 0,
    completionPushed: 0,
  };
}

module.exports = { syncProvider, pushCompletionNow, THROTTLE_SECONDS };
