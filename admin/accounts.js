// klndr admin - Accounts.
//
// Everyone who can sign in. klndr has no sign-up page, so this is where an
// account is made, where a forgotten password is reset, and where someone is
// removed. It replaces the Beta Users tab the Account & Settings modal carried.
//
// Every username on this page is set with textContent. Usernames are whatever
// an admin typed, and nothing upstream escapes them.

(() => {
  const A = KlndrAdmin;
  const { h, button, iconButton, errorBox, toast, dialog, confirmDialog } = A.ui;

  const ROLES = { admin: 'Admin', user: 'Beta tester' };
  const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  let users = null;
  let error = null;

  async function refresh() {
    try {
      const data = await API.request('/api/admin/users');
      if (!data) return; // request() has already gone to /login
      users = data.users || [];
      error = null;
    } catch (err) {
      error = err;
    }
    if (A.isAt('accounts')) render();
  }

  // ==========================================
  // THE LIST
  // ==========================================

  function roleCell(user) {
    const cell = h('td');
    const tags = h('div', 'adm-cell-tags');
    const role = h('span', `role-badge is-${user.role === 'admin' ? 'admin' : 'user'}`, ROLES[user.role] || user.role);
    tags.appendChild(role);
    if (user.must_change_password) {
      const pending = h('span', 'an-badge is-warn', 'Reset pending');
      pending.title = 'They have to choose a new password the next time they sign in.';
      tags.appendChild(pending);
    }
    cell.appendChild(tags);
    return cell;
  }

  function row(user, me) {
    const tr = h('tr');
    const isMe = me && user.id === me.id;

    const name = h('td');
    const tags = h('div', 'adm-cell-tags');
    tags.appendChild(h('span', 'an-cell-name', user.username));
    if (isMe) tags.appendChild(h('span', 'an-badge is-muted', 'You'));
    name.appendChild(tags);

    const created = h('td', 'is-muted', user.created_at ? dateFormat.format(new Date(user.created_at * 1000)) : '-');

    const actions = h('td', 'adm-actions-cell');
    if (!isMe) {
      const tools = h('div', 'adm-cell-actions');
      const remove = iconButton('delete', `Delete ${user.username}`, () => removeAccount(user));
      remove.classList.add('adm-icon-danger');
      tools.append(iconButton('lock_reset', `Reset password for ${user.username}`, () => resetPassword(user)), remove);
      actions.appendChild(tools);
    }

    tr.append(name, roleCell(user), created, actions);
    return tr;
  }

  function render() {
    const root = A.content();
    if (error) {
      root.replaceChildren(errorBox(error));
      return;
    }
    if (!users) {
      root.replaceChildren(h('p', 'an-loading', 'Loading accounts…'));
      return;
    }

    const box = h('section', 'an-card');
    const head = h('header', 'an-card-head');
    const admins = users.filter((u) => u.role === 'admin').length;
    head.append(
      h('h2', 'an-card-title', `${users.length} ${users.length === 1 ? 'account' : 'accounts'}`),
      h('p', 'an-card-sub', `${admins} ${admins === 1 ? 'admin' : 'admins'}. Resetting a password signs that person out everywhere.`)
    );

    const table = h('table', 'an-table is-static');
    const thead = h('thead');
    const headRow = h('tr');
    for (const label of ['Username', 'Role', 'Created']) headRow.appendChild(h('th', null, label));
    const actionsHead = h('th');
    actionsHead.appendChild(h('span', 'an-sr-only', 'Actions'));
    headRow.appendChild(actionsHead);
    thead.appendChild(headRow);

    const tbody = h('tbody');
    const me = A.me;
    tbody.append(...users.map((user) => row(user, me)));
    table.append(thead, tbody);

    const scroll = h('div', 'an-table-scroll');
    scroll.appendChild(table);
    const body = h('div', 'an-card-body');
    body.appendChild(scroll);
    box.append(head, body);
    root.replaceChildren(box);
  }

  // ==========================================
  // ACTIONS
  // ==========================================

  // The Studio's field styles, so a form in admin looks the same wherever it is.
  function field(label, control, id, hint) {
    const wrap = h('div', 'st-field');
    const text = h('label', 'st-label', label);
    control.id = id;
    text.htmlFor = id;
    wrap.append(text, control);
    if (hint) wrap.appendChild(h('p', 'st-hint', hint));
    return wrap;
  }

  function addAccount() {
    const problem = h('p', 'adm-form-error');
    problem.hidden = true;
    problem.setAttribute('role', 'alert');

    const username = h('input', 'st-input');
    username.type = 'text';
    username.required = true;
    username.autocomplete = 'off';
    username.spellcheck = false;
    username.placeholder = 'e.g. jane';

    const password = h('input', 'st-input');
    password.type = 'password';
    password.required = true;
    password.autocomplete = 'new-password';

    const role = h('select', 'st-select');
    for (const [value, label] of Object.entries({ user: ROLES.user, admin: ROLES.admin })) {
      const option = h('option', null, label);
      option.value = value;
      role.appendChild(option);
    }

    const fields = h('div', 'st-fields');
    fields.append(
      problem,
      field('Username', username, 'admNewUsername', 'Saved in lowercase.'),
      field('Password', password, 'admNewPassword', 'Hand it over yourself. They can change it under Account & settings.'),
      field('Role', role, 'admNewRole')
    );

    let modal = null;
    const submit = button('Add account', { icon: 'person_add', variant: 'primary' });
    submit.type = 'submit';
    modal = dialog({
      title: 'Add an account',
      content: fields,
      actions: [button('Cancel', { onClick: () => modal.close() }), submit],
      onSubmit: async () => {
        submit.disabled = true;
        problem.hidden = true;
        try {
          const res = await API.createBetaUser(username.value.trim(), password.value, role.value);
          if (!res) return;
          modal.close('ok');
          toast(`Added ${res.user.username}.`, 'success');
          refresh();
        } catch (err) {
          problem.textContent = err.message;
          problem.hidden = false;
          submit.disabled = false;
        }
      }
    });
    username.focus();
  }

  async function resetPassword(user) {
    const ok = await confirmDialog({
      title: `Reset ${user.username}'s password?`,
      body: 'This signs them out of every device straight away, and they have to choose a new password the next time they sign in.',
      confirm: 'Reset password'
    });
    if (!ok) return;
    try {
      const res = await API.resetUserPassword(user.username);
      if (!res) return;
      showTemporaryPassword(res.username, res.tempPassword);
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // Nothing stores this in a readable form, so it stays up until it is
  // dismissed rather than timing out like a toast.
  function showTemporaryPassword(username, secret) {
    const code = h('code', 'adm-secret', secret);
    const copy = button('Copy', {
      icon: 'content_copy',
      small: true,
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(secret);
          copy.querySelector('.ann-btn-label').textContent = 'Copied';
        } catch (err) {
          window.getSelection().selectAllChildren(code);
        }
      }
    });
    const secretRow = h('div', 'adm-secret-row');
    secretRow.append(code, copy);

    let modal = null;
    const done = button('Done', { variant: 'primary', onClick: () => modal.close() });
    modal = dialog({
      title: `Temporary password for ${username}`,
      text: 'Hand it over directly - it will not be shown again. They are signed out everywhere as of now, and must set their own password at their next sign-in.',
      content: secretRow,
      actions: [done]
    });
    done.focus();
  }

  async function removeAccount(user) {
    const ok = await confirmDialog({
      title: `Delete ${user.username}?`,
      body: "Their tasks, settings, activity and reactions are deleted with the account. This can't be undone.",
      confirm: 'Delete account',
      danger: true
    });
    if (!ok) return;
    try {
      await API.deleteUser(user.username);
      toast(`Deleted ${user.username}.`, 'success');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ==========================================
  // SECTION
  // ==========================================

  A.section({
    id: 'accounts',
    label: 'Accounts',
    icon: 'group',
    show() {
      A.header({
        title: 'Accounts',
        subtitle: 'Everyone who can sign in. klndr has no sign-up page, so every account starts here.',
        actions: [button('Add account', { icon: 'person_add', variant: 'primary', small: true, labelNarrow: false, onClick: addAccount })]
      });
      render();
      refresh();
    }
  });
})();
