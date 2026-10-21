// The app page's entry: everything index.html used to load as <script> and
// <link> tags, in the same order.
//
// The stylesheets cascade in the order they are imported, and later wins at
// equal specificity. responsive.css restates for phones what app.css says for
// everyone, and announcements.css comes after it on purpose: its phone rules
// restate what the bottom-sheet rules there would otherwise override.
import '../shared/theme.css';
import '../shared/common.css';
import './app.css';
import './responsive.css';
import '../shared/announcements/announcements.css';

// The theme controller first, then the app, which starts itself once the page
// is parsed.
import '../shared/theme.js';
import './app.js';
