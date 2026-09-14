// Announcement Studio - boot.
//
// Finds out who is here, loads the posts, the people and whether media storage
// is set up, then hands over to the router in admin/studio/core.js. Each view
// lives in its own file under admin/studio/.

(() => {
  const S = KlndrStudio;

  async function boot() {
    S.measureChrome();
    window.addEventListener('resize', S.measureChrome);
    document.getElementById('stNewButton').addEventListener('click', () => S.go('/new'));

    try {
      const me = await API.getMe();
      if (!me || !me.user) return;
      S.state.me = me.user;
      if (me.user.role !== 'admin') {
        S.main().replaceChildren(S.errorBox({ status: 403 }));
        return;
      }

      const [list, users, storage] = await Promise.all([
        API.listStudioAnnouncements(),
        API.request('/api/admin/users'),
        API.getMediaStatus()
      ]);
      S.state.list = (list && list.announcements) || [];
      S.state.users = (users && users.users) || [];
      S.state.storage = storage;
    } catch (err) {
      S.main().replaceChildren(S.errorBox(err));
      return;
    }

    window.addEventListener('hashchange', S.route);
    S.route();
  }

  boot();
})();
