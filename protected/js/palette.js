// Klndr Shared Palette
//
// The twenty colours and twenty icons a task or a category can wear. This lives
// in its own file, loaded by the browser AND required by the server, because
// "give a new category a random colour that no other category has taken" is only
// meaningful if both sides are drawing from the same twenty. Two copies would
// drift, and the drift would show up as a category the picker cannot render.

const KlndrPalette = {
  // 20 Curated Google Icons
  icons: [
    'square_foot', 'balance', 'science', 'bolt', 'menu_book',
    'code', 'psychology', 'fitness_center', 'calculate', 'draw',
    'palette', 'music_note', 'laptop_mac', 'history_edu', 'biotech',
    'functions', 'auto_stories', 'school', 'edit_note', 'task_alt'
  ],

  // 20 Curated Palette Colors
  colors: [
    '#3ba4f6', '#9ae659', '#d985f5', '#d1d5db', '#fb923c',
    '#fde047', '#38bdf8', '#4ade80', '#e879f9', '#f472b6',
    '#a78bfa', '#fb7185', '#facc15', '#67e8f9', '#86efac',
    '#fbcfe8', '#fed7aa', '#e2e8f0', '#a5f3fc', '#c7d2fe'
  ],

  // What a task falls back to when nothing else has an opinion. Repeated in
  // db-mongodb.createTask, which cannot import this file's browser half.
  DEFAULT_COLOR: '#3ba4f6',
  DEFAULT_ICON: 'task_alt'
};

// The browser gets it as a global, the way api.js and task-model.js do; node
// gets it through require. Neither half knows about the other.
if (typeof module !== 'undefined' && module.exports) module.exports = KlndrPalette;
