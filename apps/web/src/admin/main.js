// The admin page's entry: everything index.html used to load as <script> and
// <link> tags, in the same order.
//
// The stylesheets cascade in the order they are imported, and later wins at
// equal specificity. The app's announcements.css is here so the Studio's
// preview is the real thing rather than a lookalike.
import '../shared/theme.css';
import '../shared/common.css';
import './analytics.css';
import '../shared/announcements/announcements.css';
import './announcements.css';
import './admin.css';

// The shell first. Each section registers itself when it is imported, and the
// order of these imports is the order of the sidebar; the shell routes to the
// first page only once they all have.
import '../shared/theme.js';
import './shell.js';
import './analytics.js';
import './studio/core.js';
import './studio/uploads.js';
import './studio/list.js';
import './studio/editor.js';
import './studio/editor-sections.js';
import './studio/editor-media.js';
import './studio/preview.js';
import './studio/stats.js';
import './announcements.js';
import './accounts.js';
