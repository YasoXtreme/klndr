# klndr plugin system: spec sheet

Version 1 of the plugin API (`apiVersion: 1`). It describes what the system is and what it offers, not how to build it.

---

## 1. Principles

- **Full control through an API, never the DOM.** A plugin can read and change people's work, react to everything that happens, talk to other apps, add UI and shape the calendar. It does all of it by asking the `klndr` object.
- **klndr draws its own screens.** Plugins provide content (a label, a badge, a set of ranges) and klndr draws it in its own design, in both themes, on every screen size. Only inside its own frames does a plugin draw whatever it likes.
- **Sealed rooms.** Plugin code runs in sandboxed frames. It can't read cookies, call klndr's API directly, reach the page around it, or talk to websites it didn't declare.
- **Undoable and quiet.** Every change a plugin makes can be undone with Ctrl+Z. A broken plugin is stopped quietly and never breaks the board.
- **Curated.** The admin decides which plugins exist on the instance. Each person decides which of those they install, and approves the permissions.

---

## 2. A plugin package

```
plugins/<id>/
  plugin.json      the manifest (required)
  main.js          the plugin's code (required)
  *.html           pages for frames (optional)
  *.js / *.css     files those pages use (optional, inlined when served)
  icon / images    small images (optional, inlined)
```

### Manifest (`plugin.json`)

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Lowercase slug, unique. Used in URLs, storage and `source_app` on imported tasks |
| `name` | yes | Shown everywhere the plugin is named |
| `version` | yes | Semver |
| `apiVersion` | yes | `1` |
| `description` | yes | One sentence, shown on the install screen |
| `icon` | yes | A Material Symbols name |
| `main` | yes | The script that runs in the brain frame |
| `permissions` | no | See §4 |
| `connects` | no | Account providers the plugin uses, e.g. `["sylla"]` |
| `network` | no | HTTPS origins the plugin may `fetch` directly, e.g. `["https://api.github.com"]` |

Everything else (actions, badges, panels, layers, settings) is registered from code at runtime.

---

## 3. Lifecycle

1. **Available.** The admin sets each plugin to *off*, *admins only* or *everyone* (Admin → Plugins).
2. **Installed.** The person opens Settings → Plugins, picks the plugin, and sees the install screen:
   > **Sylla** wants to:
   > · Use your Sylla account
   > · Add and update your Sylla sessions as tasks
   >
   > [Install] [Cancel]
3. **Running.** After the board has rendered, klndr starts one hidden "brain" frame per installed plugin, which runs `main.js`. Plugins never delay loading.
4. **Stopped.** If a plugin crashes while starting, keeps failing calls, or blows its limits (§11), klndr stops it. Settings → Plugins shows *Stopped* with a Restart button. There are no pop-ups.
5. **Disabled / uninstalled.** Disabling pauses the plugin and keeps its data. Uninstalling removes its settings and storage, disconnects its accounts, and **detaches** its imported tasks: they stay as ordinary tasks and stop syncing.
6. **Updated.** A new version that asks for **new permissions** waits until the person approves them. Until then, the old grant stands and the plugin runs with what it already had.

---

## 4. Permissions

| Permission | What it lets the plugin do |
|---|---|
| `tasks.read` | Read tasks, query by date range, receive events about any task |
| `tasks.write` | Create, edit, move, complete and delete any task |
| `imports` | Keep a set of imported tasks in sync with a source (§8). Receive events about its own imported tasks |
| `connects: [...]` | Use those connected accounts through klndr's proxy (§9) |
| `network: [...]` | `fetch` those origins directly from its frames (they must allow CORS) |

**Always allowed, no permission needed:** its own storage and settings, toasts and dialogs, block actions, badges, details, commands, panels, views and calendar layers. **Badges, details and layers only see tasks the plugin can read:** its own imported tasks, or all tasks with `tasks.read`.

---

## 5. API reference (`klndr.*`)

All methods are async unless they register something.

### `klndr.tasks` (needs `tasks.read` / `tasks.write`)
| Method | Does |
|---|---|
| `list({ from, to })` | Tasks with blocks in the range, plus unscheduled tasks |
| `get(id)` | One task |
| `create({ title, category?, minutes?, start? })` | New task, scheduled if `start` is given |
| `update(id, patch)` | Title, category, colour, icon, lock |
| `complete(id, done = true)` | Tick or untick the whole task |
| `remove(id)` | Delete |
| `setData(id, object)` | Attach the plugin's own data to any task (visible only to that plugin) |

### `klndr.calendar`
| Method | Does |
|---|---|
| `range()` | The days on screen: `{ from, to, days }` |
| `currentBlock()` | The block happening now, or null |
| `push({ from, minutes })` | Push everything after `from` later through klndr's physics (`tasks.write`) |
| `addLayer(layer)` | Draw ranges on the calendar (§7.3) |

### `klndr.imports` (needs `imports`)
| Method | Does |
|---|---|
| `sync(items, { force })` | The complete set of work the source owes now. klndr reconciles it and returns `{ created, updated, removed }`. At most once per 5 minutes unless `force` |
| `restoreRemoved()` | Bring back imported tasks the person deleted locally |

### `klndr.accounts` (needs `connects`)
| Method | Does |
|---|---|
| `get(provider)` | The connected account, or `null` |
| `account.label` | e.g. "@yassen" |
| `account.get/post/put/patch/delete(path, body?)` | Call the provider's API. klndr adds the sign-in server-side |
| `connect(provider)` | Start the provider's sign-in, from a click |

### `klndr.blocks`
| Method | Does |
|---|---|
| `addAction({ id, label, icon, when?, run })` | An item in a block's menu. `when(task)` hides it for some tasks |
| `addBadge(fn)` | `fn(task)` returns short text (≤ 12 characters) or null |
| `addDetails(fn)` | `fn(task)` returns rows `{ label, value }` or `{ label, link }` for the block editor |

### `klndr.commands`
| Method | Does |
|---|---|
| `add({ id, label, icon?, run })` | An entry in the Ctrl+K command palette |

### `klndr.ui`
| Method | Does |
|---|---|
| `toast(text)` | A quiet message |
| `confirm({ title, text, ok, danger? })` | Yes/no dialog, returns a boolean |
| `form({ title, fields, submit })` | A dialog built from fields (§7.1), returns the values or null |
| `addSettings(fields)` | The plugin's settings page, built from fields |
| `addPanel({ id, title, icon, page })` | A sidebar panel drawn by the plugin (§7.2) |
| `addView({ id, title, icon, page })` | A full view drawn by the plugin |
| `addEditorSection({ id, title, page, when? })` | A section in the block editor drawn by the plugin |
| `openModal({ page, size, data })` | A modal drawn by the plugin. `size` is small, medium or large |
| `openLink(url)` | Open a link in a new tab, after a confirm |

### `klndr.storage` / `klndr.settings`
| Method | Does |
|---|---|
| `storage.get(key)` / `set(key, value)` / `remove(key)` | Private JSON storage per plugin, per person |
| `settings.get(key)` | A value from the settings page |

### Other
| Method | Does |
|---|---|
| `klndr.on(event, fn)` | Listen to an event (§6) |
| `klndr.schedule.every(interval, fn)` | Run `fn` repeatedly while klndr is open (`'1m'` minimum) |
| `klndr.me()` | `{ username, timezone, theme }`. Nothing else about the person |
| `klndr.channel.send(data)` / `on('message')` | Talk between the plugin's own frames |

---

## 6. Events

| Event | Payload | Who receives it |
|---|---|---|
| `app.ready` | `{}` | Every plugin |
| `range.changed` | `{ from, to, days }` | Every plugin |
| `theme.changed` | `{ theme }` | Every plugin |
| `settings.changed` | `{ key, value }` | That plugin |
| `task.created` / `task.updated` / `task.deleted` | `{ task }` | `tasks.read`, or the owner of an imported task |
| `task.completed` / `task.reopened` | `{ task, block? }` | Same as above |

---

## 7. UI surfaces

### 7.1 Ready-made pieces (klndr draws them)
- **Block action:** listed in a plugin group under a divider, in the right-click menu and the phone's block sheet.
- **Badge:** a small text chip beside the block's icon, on the calendar and in the tasks list.
- **Details:** label/value/link rows in a "From <plugin>" section of the block editor.
- **Command:** an entry in Ctrl+K. On a phone, the palette opens from the account menu.
- **Settings and form fields:** `toggle`, `select`, `text`, `number`, `time`, `timeRange`, `button` (runs a function), `note` (read-only text). Each field has `key`, `label`, `default`, and an optional `help`.

### 7.2 Frames (the plugin draws them)
**Where:** a sidebar panel, a full view, a modal, a block-editor section, or a custom settings page.

Inside a frame, the plugin has a whole HTML page:
- **It looks like klndr for free.** `ui.css` is included automatically: klndr's colours as CSS variables, plus styled buttons, inputs, selects and headings in both themes.
- **The theme follows klndr.** The frame's `data-theme` changes when klndr's does.
- **Same API everywhere.** Every frame gets the same `klndr` object as `main.js`, limited to the plugin's permissions.
- **It sits in klndr's chrome.** klndr draws the panel's title bar, the modal's frame and the view's header around it.

### 7.3 Calendar layers
```js
klndr.calendar.addLayer({
  id: 'busy',
  name: 'Google Calendar',
  style: 'ghost',            // 'band' | 'hatched' | 'ghost'
  tone: 'blue',              // a named tone, drawn in theme colours
  solid: false,              // true: blocks can't be dropped or pushed onto these ranges
  ranges: async ({ from, to }) => [{ start, end, label }]
});
```
- **Styles:** `band` tints the day's lane for a stretch of time (focus hours, energy), `hatched` draws diagonal lines (blocked time), and `ghost` draws an outlined block with a label (someone else's event).
- **Tones:** `gray`, `blue`, `green`, `yellow`, `orange`, `pink`, `violet`. A layer can't choose arbitrary colours.
- **`solid: true` turns ranges into walls:** dragging pushes blocks past them, and nothing can be dropped inside.
- **When ranges are fetched:** klndr asks for them when the visible range changes and caches the answer. Calendar drawing never waits on a plugin.

---

## 8. Data

**A task, as a plugin sees it**
```js
{ id, title, category, color, icon, locked, completed,
  blocks: [{ id, start, minutes, completed }],
  key, source_app, source_url,   // set on imported tasks (key = the item's key)
  data }                    // this plugin's own data, if any
```

**An imported item, for `imports.sync`**
```js
{ key, title, category, icon, minutes, completed, url, revision, data }
```

**Who owns what** (the rule klndr uses for imports):
- **The source owns** what the work is: title, category and completion.
- **The person owns** when it happens and how it looks: blocks, times, lengths, colour.
- **Items that vanish from the source** are removed if the person never touched them. If they did, the items are detached and stay as ordinary tasks.
- **A task the person deleted** isn't recreated until they choose "Restore removed items".
- **Unchanged items cost nothing:** `revision` changes only when the source's item changed.
- **A category the person doesn't have yet** is created with a free colour and the item's icon.

**Storage limits:** 100 keys, 64 KB per value, 1 MB per plugin per person. Task `data`: 4 KB per task.

---

## 9. Accounts and the proxy

- **Providers are defined by klndr, not by plugins** (v1 has one: `sylla`). A provider holds the OAuth app, the base URL, and the paths a plugin may call.
- **The settings page draws the account for you.** For every provider in `connects`, klndr shows the connected account (Connect, the account's label, Disconnect) on the plugin's settings page.
- **Tokens never reach the plugin.** `account.get('/api/v1/sessions')` goes to klndr's server, which adds the access token, refreshes it when needed, and calls the provider. Refresh tokens are encrypted at rest and never leave the server.
- **What the proxy allows:**
  - **Paths:** only under the provider's allowed paths. No other hosts, no `..`, `//` or schemes.
  - **Requests:** GET, POST, PUT, PATCH and DELETE, with JSON in and out.
  - **Limits:** 10-second timeout, 1 MB responses.

---

## 10. Security model

- **Sandboxed frames.** Every plugin frame is sandboxed with scripts only, so it has an opaque origin. That means:
  - no cookies or localStorage of klndr's;
  - no access to the page around it;
  - no navigating klndr or opening pop-ups.
- **Frames are served behind login,** only to people who installed the plugin, with a strict Content-Security-Policy. Network access is limited to the manifest's `network` origins, plus Google Fonts.
- **Two layers of permission checks.** klndr's host code checks every call from a plugin against its permissions. The server checks again on every plugin endpoint: is the plugin available, installed, and granted that permission?
- **Content is treated as text.** Labels, badges, details and layer labels are always drawn as text, never as HTML.
- **Plugin writes go through klndr's normal save path.** They get the same validation, revision guard and undo as the person's own edits.

---

## 11. Limits and failure

| Limit | Value |
|---|---|
| API calls | 50 per second burst, 600 per minute |
| A single call | 10 s, then it fails with a timeout |
| A badge, details or layer callback | 200 ms, then that answer is skipped (shown on the next try) |
| `schedule.every` | Once per minute at most |
| `imports.sync` | Once per 5 minutes unless `force` |

**When a plugin gets stopped:** after three failed starts, or after repeated limit breaches. Its last error shows on its settings page. The board, the person's tasks and other plugins are never affected.

**Undo:** each plugin change records one undo step labelled "<Plugin>: <what>", e.g. "Sylla: Sync". Imports from a sync are not undoable; restoring removed items is how you bring one back.

---

## 12. Admin

Admin → Plugins lists every bundled plugin with:
- **Audience:** off / admins only / everyone.
- **Usage:** installs, how many are stopped, and the last errors.

The admin never sees plugin storage or task data.

---

## 13. Versioning

- **`apiVersion: 1` is a promise.** Methods and events only gain options; nothing is removed or renamed within a version.
- **Breaking changes mean `apiVersion: 2`.** Version 1 plugins keep running for at least one release after that.

---

## 14. Not in v1

Installing plugins from a link (third-party), a public REST API with tokens and webhooks, plugins that run on the server or while klndr is closed, a general network proxy (needed for ICS feeds), a marketplace, and themes as plugins.

Running late, the focus timer, sleep hours and a calendar overlay are planned as **core features**, not plugins.

---

## 15. Example: the Sylla plugin

`plugins/sylla/plugin.json`
```json
{
  "id": "sylla",
  "name": "Sylla",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "Bring the sessions you owe in Sylla onto your calendar.",
  "icon": "menu_book",
  "main": "main.js",
  "permissions": ["imports"],
  "connects": ["sylla"]
}
```

`plugins/sylla/main.js`
```js
klndr.commands.add({ id: 'sync', label: 'Sync Sylla now', icon: 'sync', run: () => sync(true) });
klndr.on('app.ready', () => sync(false));
klndr.schedule.every('15m', () => sync(false));

async function sync(force) {
  const sylla = await klndr.accounts.get('sylla');
  if (!sylla) return;
  const sessions = await sylla.get('/api/v1/sessions');
  const result = await klndr.imports.sync(sessions.map(toItem), { force });
  if (force) klndr.ui.toast(`Sylla: ${result.created} new, ${result.updated} updated`);
}

function toItem(s) {
  return {
    key: s.id,
    title: s.topic,
    category: s.subject,
    icon: 'menu_book',
    minutes: s.duration,
    completed: s.done,
    url: s.url,
    revision: s.updatedAt,
    data: { session: s.number, topic: s.topic }
  };
}

klndr.blocks.addBadge((task) => task.data.session ? `#${task.data.session}` : null);

klndr.blocks.addDetails((task) => [
  { label: 'Topic', value: task.data.topic },
  { label: 'Open in Sylla', link: task.source_url }
]);

klndr.on('task.completed', ({ task }) => setDone(task, true));
klndr.on('task.reopened', ({ task }) => setDone(task, false));

async function setDone(task, done) {
  const sylla = await klndr.accounts.get('sylla');
  if (sylla) await sylla.post(`/api/v1/sessions/${task.key}/progress`, { done });
}
```

(Sylla's paths and field names here are illustrative.)
