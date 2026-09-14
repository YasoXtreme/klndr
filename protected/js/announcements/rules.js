// Klndr Announcement Rules
//
// The vocabulary of an announcement - its kinds, delivery styles, reactions and
// in-app actions - and the questions every surface asks of one: is it live, is
// it for this person, has it reached them, have they read it.
//
// Loaded by the browser AND required by the server, the way palette.js is. The
// Studio's "reaches N people" and the server's decision about who actually gets
// a post have to be the same sum, and two copies of these rules would drift into
// two different answers.

const KlndrAnnouncementRules = (() => {
  const KINDS = [
    { id: 'feature', label: 'New feature', icon: 'auto_awesome' },
    { id: 'improvement', label: 'Improvement', icon: 'trending_up' },
    { id: 'fix', label: 'Fix', icon: 'build' },
    { id: 'tip', label: 'Tip', icon: 'lightbulb' },
    { id: 'heads_up', label: 'Heads-up', icon: 'warning' },
    { id: 'news', label: 'News', icon: 'newspaper' }
  ];

  const DELIVERIES = [
    { id: 'story', label: 'Story', icon: 'auto_stories', hint: 'Opens as a pop-up the next time they load klndr.' },
    { id: 'banner', label: 'Banner', icon: 'view_day', hint: 'A notice under the top bar until it is dismissed.' },
    { id: 'card', label: 'Corner card', icon: 'picture_in_picture_alt', hint: 'A small card in the corner that tucks itself away.' },
    { id: 'inbox', label: 'Inbox only', icon: 'inbox', hint: 'No interruption - just the unread badge.' }
  ];

  // Stored by id, drawn as emoji. The id is what survives a change of heart
  // about which glyph should mean "love it".
  const REACTIONS = [
    { id: 'tada', emoji: '🎉', label: 'Celebrate' },
    { id: 'heart', emoji: '❤️', label: 'Love it' },
    { id: 'fire', emoji: '🔥', label: 'Fire' },
    { id: 'clap', emoji: '👏', label: 'Applause' },
    { id: 'eyes', emoji: '👀', label: 'Curious' }
  ];

  // A button can open a screen inside klndr instead of a link. Named actions
  // rather than selectors or URLs, so a post written today still works after
  // the markup it points at has moved.
  const APP_ACTIONS = [
    { id: 'open_categories', label: 'Categories' },
    { id: 'open_integrations', label: 'Integrations' },
    { id: 'open_settings', label: 'Calendar options' },
    { id: 'open_account', label: 'Account & settings' },
    { id: 'open_analytics', label: 'Analytics (admins only)', adminOnly: true }
  ];

  const AUDIENCES = [
    { id: 'everyone', label: 'Everyone' },
    { id: 'admins', label: 'Admins only' },
    { id: 'users', label: 'Specific people' }
  ];

  // Width over height. 2:1 is the default because it is what a header wants on
  // a phone: tall enough to show something, short enough to leave the words on
  // screen underneath it.
  const ASPECTS = { '2:1': 2, '16:9': 16 / 9, '3:1': 3, '1:1': 1 };

  function kind(id) {
    return KINDS.find((k) => k.id === id) || KINDS[0];
  }

  function isLive(a, now) {
    if (!a || a.status !== 'published') return false;
    if (a.publish_at == null || a.publish_at > now) return false;
    return a.expires_at == null || a.expires_at > now;
  }

  function inAudience(a, user) {
    const audience = (a && a.audience) || { type: 'everyone' };
    if (audience.type === 'admins') return Boolean(user && user.role === 'admin');
    if (audience.type === 'users') {
      return Boolean(user && (audience.user_ids || []).includes(user.id));
    }
    return true;
  }

  // The moment a post was last sent out: when it was published, or its most
  // recent "notify again".
  function deliveryAnchor(a) {
    return (a && (a.redelivered_at || a.publish_at)) || 0;
  }

  function joinedInTime(a, user) {
    return Boolean(a.evergreen) || (Number(user && user.created_at) || 0) <= deliveryAnchor(a);
  }

  /**
   * Whether this post is news TO THIS PERSON.
   *
   * The join rule is the point. The old watermark started every new account at
   * zero, so someone signing up on day forty was walked through forty days of
   * changelog before they had seen the product. A post now only reaches the
   * people who were already here when it went out - or everyone, ever, when it
   * is marked evergreen, which is what a welcome post wants. Older posts still
   * sit in a newcomer's inbox, just never as unread.
   */
  function isDeliverable(a, user, now) {
    return isLive(a, now) && inAudience(a, user) && joinedInTime(a, user);
  }

  function currentVersion(a) {
    return (a && a.delivery_version) || 1;
  }

  // A receipt only speaks for the delivery it was written against: "notify
  // again" bumps the version, and everything stamped before that is history.
  function stamped(a, receipt, field) {
    return Boolean(receipt && receipt[field] && (receipt.version || 0) >= currentVersion(a));
  }

  /**
   * Opened, at the current delivery.
   *
   * The legacy watermark still counts, read here rather than backfilled into
   * receipts: last_seen_announcement_id marked everything up to and including
   * that id as seen. It only ever speaks for a post's first delivery - a
   * "notify again" is news the watermark never saw.
   */
  function isRead(a, user, receipt) {
    if (stamped(a, receipt, 'opened_at')) return true;
    return currentVersion(a) === 1 && typeof a.id === 'number' &&
      (Number(user && user.last_seen_announcement_id) || 0) >= a.id;
  }

  // Already put in front of them through its delivery style, so it must not
  // pop up again. Not the same as read: a skipped story stays unread in the
  // inbox, it just stops interrupting.
  function wasDelivered(a, user, receipt) {
    return stamped(a, receipt, 'delivered_at') || isRead(a, user, receipt);
  }

  function clickedThrough(a, receipt) {
    return stamped(a, receipt, 'cta_at');
  }

  function studioStatus(a, now) {
    if (a.status === 'archived') return 'archived';
    if (a.status !== 'published') return 'draft';
    if (a.publish_at != null && a.publish_at > now) return 'scheduled';
    if (a.expires_at != null && a.expires_at <= now) return 'expired';
    return 'live';
  }

  /**
   * The people out of `users` that a post reaches, whether or not it is live.
   *
   * A draft or a scheduled post has not gone out yet, so everyone who exists
   * right now will have been here by the time it does.
   */
  function audienceOf(a, users) {
    const sent = a.status === 'published';
    return users.filter((u) => inAudience(a, u) && (!sent || joinedInTime(a, u)));
  }

  return {
    KINDS,
    DELIVERIES,
    REACTIONS,
    APP_ACTIONS,
    AUDIENCES,
    ASPECTS,
    kind,
    isLive,
    inAudience,
    deliveryAnchor,
    isDeliverable,
    isRead,
    wasDelivered,
    clickedThrough,
    studioStatus,
    audienceOf
  };
})();

// The browser gets it as a global, the way palette.js does; node gets it
// through require.
if (typeof module !== 'undefined' && module.exports) module.exports = KlndrAnnouncementRules;
