// Klndr Categories
//
// A category is the person's own: a name, a default colour and a default icon.
// klndr ships none. Everything here operates on one array stored at
// `settings.values.categories`, and the *absence* of that key is the migration
// marker - see db.initCategoriesIfAbsent.
//
// Tasks reference a category by NAME, not by id. That is deliberate: an
// integration hands us a subject name and nothing else, so the name has to be
// the thing that matches. The id exists only so a rename is one addressable
// edit rather than a lookup by the value being changed.

const crypto = require("crypto");
const db = require("./db");
const KlndrPalette = require("../protected/js/palette");

const MAX_NAME_LENGTH = 40;

function newCategoryId() {
  return "cat_" + crypto.randomBytes(6).toString("hex");
}

function cleanName(name) {
  return String(name || "")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

// Names are the foreign key, so they collide the way a person would expect
// them to: "Physics" and "physics" are the same category.
function sameName(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

/**
 * Hand out colours no existing category is using, one at a time and without
 * replacement, so a sync that invents three categories at once cannot give two
 * of them the same colour. Once all twenty are spoken for the whole palette
 * comes back into play - a twenty-first category with no colour at all would be
 * worse than a repeated one.
 */
function colourDrawer(taken) {
  const takenSet = new Set(taken);
  let pool = KlndrPalette.colors.filter((colour) => !takenSet.has(colour));
  return function draw() {
    if (!pool.length) pool = [...KlndrPalette.colors];
    return pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
  };
}

// The value that appears most often, ties going to the one seen first. Used to
// ask a rescued category what its tasks already looked like.
function modeOf(values, fallback) {
  const counts = new Map();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best || fallback;
}

/**
 * The user's categories, migrating them once if they have never had any.
 *
 * The migration derives the list from the categories their TASKS actually
 * carry - not from the eleven names klndr used to hardcode. Someone who never
 * filed a task under "Mechanics" never really had that category; they had a
 * menu entry. Each rescued category takes the colour and icon most of its own
 * tasks already wear, so nothing on screen changes appearance.
 */
async function loadOrMigrate(userId) {
  const settings = await db.getSettings(userId);
  if (Array.isArray(settings.categories)) return settings.categories;

  // No date filter: a category proved by a task three months back still counts.
  const tasks = await db.getTasks(userId);
  const byName = new Map();
  for (const task of tasks) {
    const name = cleanName(task.category);
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(task);
  }

  const draw = colourDrawer([]);
  const migrated = [...byName.entries()].map(([name, owned]) => ({
    id: newCategoryId(),
    name,
    color: modeOf(
      owned.map((task) => task.color),
      draw(),
    ),
    icon: modeOf(
      owned.map((task) => task.icon),
      KlndrPalette.DEFAULT_ICON,
    ),
  }));

  return db.initCategoriesIfAbsent(userId, migrated);
}

async function saveCategories(userId, list) {
  const saved = await db.updateSettings(userId, { categories: list });
  return saved.categories || [];
}

/**
 * The list, each entry carrying how many tasks actually use it. Counted across
 * every task, because it is what a "this will change 23 tasks" confirmation
 * quotes and the client only ever holds one week.
 */
async function listCategories(userId) {
  const [categories, counts] = await Promise.all([
    loadOrMigrate(userId),
    db.countTasksByCategory(userId),
  ]);
  return categories.map((category) => ({
    ...category,
    task_count: counts[category.name] || 0,
  }));
}

async function createCategory(userId, { name, color, icon }) {
  const categories = await loadOrMigrate(userId);
  const clean = cleanName(name);
  if (!clean) throw new Error("Category name is required");
  if (categories.some((category) => sameName(category.name, clean))) {
    throw new Error('You already have a category called "' + clean + '"');
  }

  const category = {
    id: newCategoryId(),
    name: clean,
    color: color || colourDrawer(categories.map((c) => c.color))(),
    icon: icon || KlndrPalette.DEFAULT_ICON,
  };
  await saveCategories(userId, [...categories, category]);
  return { ...category, task_count: 0 };
}

/**
 * Edit one category. A rename cascades to every task carrying the old name -
 * names are the foreign key, so not cascading would orphan them. The new colour
 * and icon only reach existing tasks when `applyToTasks` says so: the defaults
 * are for the next task that picks this category, and silently repainting a
 * board someone has already coloured by hand is not a default.
 */
async function updateCategory(userId, id, patch) {
  const categories = await loadOrMigrate(userId);
  const index = categories.findIndex((category) => category.id === id);
  if (index === -1) throw new Error("Category not found");

  const before = categories[index];
  const name = patch.name === undefined ? before.name : cleanName(patch.name);
  if (!name) throw new Error("Category name is required");
  if (categories.some((c, i) => i !== index && sameName(c.name, name))) {
    throw new Error('You already have a category called "' + name + '"');
  }

  const after = {
    ...before,
    name,
    color: patch.color || before.color,
    icon: patch.icon || before.icon,
  };
  const next = [...categories];
  next[index] = after;
  await saveCategories(userId, next);

  // Compared exactly, not case-insensitively: fixing "physics" to "Physics" is
  // a rename that every task still has to follow.
  const renamed = before.name !== after.name;
  const retagged = renamed
    ? await db.retagTasksByCategory(userId, before.name, after.name)
    : 0;

  const restyled = before.color !== after.color || before.icon !== after.icon;
  const recoloured =
    patch.applyToTasks && restyled
      ? await db.recolourTasksByCategory(userId, after.name, {
          color: after.color,
          icon: after.icon,
        })
      : 0;

  const counts = await db.countTasksByCategory(userId);
  return {
    category: { ...after, task_count: counts[after.name] || 0 },
    renamedFrom: renamed ? before.name : null,
    retagged,
    recoloured,
  };
}

// Deleting a category does not delete its work. Those tasks become
// uncategorised, which is a real state here, so they stay on the board.
async function deleteCategory(userId, id) {
  const categories = await loadOrMigrate(userId);
  const category = categories.find((entry) => entry.id === id);
  if (!category) throw new Error("Category not found");

  await saveCategories(
    userId,
    categories.filter((entry) => entry.id !== id),
  );
  const cleared = await db.retagTasksByCategory(userId, category.name, null);
  return { deleted: category, cleared };
}

/**
 * Resolve a batch of wanted category names in ONE pass, creating whatever is
 * missing. Plural on purpose: this is called by the integration sync, where
 * every name in a syllabus arrives at once. One-at-a-time would mean a settings
 * read and write per imported session, and two new subjects in the same sync
 * would each draw a colour without being able to see the other's.
 *
 * Returns a Map keyed by lowercased name, so callers match the way the rest of
 * this file does.
 */
async function ensureCategories(userId, wanted) {
  const categories = await loadOrMigrate(userId);
  const byKey = new Map(categories.map((c) => [c.name.toLowerCase(), c]));

  const draw = colourDrawer(categories.map((c) => c.color));
  const added = [];
  for (const { name, fallbackIcon } of wanted) {
    const clean = cleanName(name);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (byKey.has(key)) continue;

    // A subject klndr has not seen before: a colour nothing else has taken, and
    // whatever icon the source already uses for it.
    const category = {
      id: newCategoryId(),
      name: clean,
      color: draw(),
      icon: fallbackIcon || KlndrPalette.DEFAULT_ICON,
    };
    byKey.set(key, category);
    added.push(category);
  }

  if (added.length) await saveCategories(userId, [...categories, ...added]);
  return byKey;
}

module.exports = {
  listCategories,
  loadOrMigrate,
  createCategory,
  updateCategory,
  deleteCategory,
  ensureCategories,
};
