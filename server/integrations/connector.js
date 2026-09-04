// The contract every integration implements.
//
// This file is documentation with a module wrapper: there is nothing to run,
// only the shape that sync.js and the routes rely on. It exists so that adding
// a second provider is writing one file against a known interface rather than
// discovering the interface by reading the sylla connector.
//
// The important rule is that NOTHING outside a connector knows anything about
// the app it talks to. sync.js sees NormalizedItem and nothing else, the routes
// see a provider id, and the database columns are named source_* rather than
// after any particular service.

/**
 * @typedef {Object} NormalizedItem
 * One unit of work from a source app, in the only shape klndr cares about.
 * @property {string}      external_id       stable id in the source app
 * @property {string}      title
 * @property {string}      category          a category NAME. Matched against
 *                                           the person's own categories; a name
 *                                           they do not have yet becomes a new
 *                                           category, which then supplies the
 *                                           task's colour and icon. Blank
 *                                           leaves the task uncategorised.
 * @property {string}      icon              Material Symbols name. Used as the
 *                                           icon of a category invented for
 *                                           this item, and as the task's own
 *                                           icon when there is no category.
 * @property {number}      duration_minutes  how long the work takes
 * @property {boolean}     completed         done, according to the source
 * @property {string|null} url               deep link back into the source app
 * @property {string}      revision          changes when the item changes, so
 *                                           an unchanged item costs no writes
 * @property {Object}      [metadata]        optional. Anything the source
 *                                           knows that klndr has no column
 *                                           for, stored verbatim under the
 *                                           task's `metadata.source`. Not
 *                                           rendered anywhere today; it exists
 *                                           so a detail worth keeping does not
 *                                           have to be thrown away and
 *                                           re-synced later to get it back.
 */

/**
 * @typedef {Object} TokenSet
 * @property {string}  access_token
 * @property {string}  refresh_token
 * @property {number}  expires_in   seconds from now
 * @property {string}  scope        space-delimited
 */

/**
 * @typedef {Object} Connector
 * @property {string}   id      provider id, used in URLs and in source_app
 * @property {string}   label   shown in the integrations UI
 * @property {string}   icon    Material Symbols name for the UI
 * @property {string[]} scopes  what this integration asks for
 *
 * @property {() => boolean} isConfigured
 *   Whether the environment has what this connector needs. A connector that
 *   is not configured is listed as unavailable rather than failing at connect
 *   time with something unreadable.
 *
 * @property {(redirectUri: string) => {url: string, verifier: string, state: string}} beginAuth
 *   Builds the authorize URL and the one-time secrets that go with it. The
 *   verifier and state are stored by the caller, never sent to the browser in
 *   a readable form.
 *
 * @property {(code: string, verifier: string, redirectUri: string) => Promise<TokenSet>} completeAuth
 *
 * @property {(refreshToken: string) => Promise<TokenSet>} refresh
 *
 * @property {(accessToken: string) => Promise<{label: string}>} identify
 *   A human label for the connected account, e.g. "@yassen".
 *
 * @property {(accessToken: string) => Promise<NormalizedItem[]>} fetchItems
 *
 * @property {(accessToken: string, externalId: string, completed: boolean) => Promise<void>} pushCompletion
 *
 * @property {(accessToken: string, refreshToken: string) => Promise<void>} revoke
 *   Best effort. Disconnecting should tell the source app, so its own
 *   "connected apps" list does not keep showing a connection that is gone.
 */

module.exports = {};
