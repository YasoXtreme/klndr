// Announcement Studio - its place in the admin page.
//
// Registers the Studio as the Announcements section. The first visit loads the
// posts, the people and whether media storage is set up, then hands over to
// the router in admin/studio/core.js. Each view lives in its own file under
// admin/studio/.

(() => {
  const S = KlndrStudio;
  let ready = null;

  async function load() {
    const [list, users, storage] = await Promise.all([
      API.listStudioAnnouncements(),
      API.request('/api/admin/users'),
      API.getMediaStatus()
    ]);
    S.state.list = (list && list.announcements) || [];
    S.state.users = (users && users.users) || [];
    S.state.storage = storage;
  }

  // The people an audience can be picked from. Accounts may have changed in
  // their own section since the first load, so this is asked again on the way
  // back in, without holding the page up for it.
  function refreshPeople() {
    API.request('/api/admin/users')
      .then((data) => {
        if (data) S.state.users = data.users || [];
      })
      .catch(() => null);
  }

  KlndrAdmin.section({
    id: 'announcements',
    label: 'Announcements',
    icon: 'campaign',
    enter() {
      S.state.me = KlndrAdmin.me;
      if (ready) refreshPeople();
    },
    // Settles once the view has been handed its data - what the boot overlay
    // waits on when the Studio is the first page opened.
    show(subpath) {
      if (!ready) {
        ready = load().catch((err) => {
          ready = null;
          throw err;
        });
        KlndrAdmin.header({ title: 'Announcements' });
        S.main().replaceChildren(S.h('p', 'an-loading', 'Opening announcements…'));
      }
      return ready.then(
        () => {
          if (KlndrAdmin.isAt('announcements', subpath)) S.route(subpath);
        },
        (err) => {
          if (KlndrAdmin.isAt('announcements', subpath)) S.main().replaceChildren(S.errorBox(err));
        }
      );
    },
    leave() {
      S.teardownView();
    }
  });
})();
