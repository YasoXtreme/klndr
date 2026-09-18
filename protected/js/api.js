// Klndr Client API Service
const API = {
  async request(endpoint, options = {}) {
    const defaultHeaders = {
      'Content-Type': 'application/json'
    };

    const token = localStorage.getItem('klndr_token');
    if (token) {
      defaultHeaders['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(endpoint, {
      ...options,
      headers: {
        ...defaultHeaders,
        ...(options.headers || {})
      }
    });

    if (response.status === 401) {
      localStorage.removeItem('klndr_token');
      localStorage.removeItem('klndr_user');
      window.location.href = '/login';
      return null;
    }

    const data = await response.json();
    if (!response.ok) {
      const err = new Error(data.error || 'API Request Failed');
      // Carries the machine-readable reason alongside the message, so callers
      // can branch on the forced-password-change gate without matching on
      // display text.
      err.code = data.code;
      err.status = response.status;
      // The whole payload, for the few errors that carry more than a
      // sentence - a Studio save that lost a race gets the stored post back.
      err.data = data;
      throw err;
    }
    return data;
  },

  // Auth APIs
  async getMe() {
    return this.request('/api/auth/me');
  },

  async logout() {
    const res = await this.request('/api/auth/logout', { method: 'POST' });
    localStorage.removeItem('klndr_token');
    localStorage.removeItem('klndr_user');
    window.location.href = '/login';
    return res;
  },

  // Like a reset, the response carries a server-generated temporary password,
  // once.
  async createBetaUser(username, role = 'user') {
    return this.request('/api/admin/create-user', {
      method: 'POST',
      body: JSON.stringify({ username, role })
    });
  },

  // Takes their tasks, settings, activity and reactions with it.
  async deleteUser(username) {
    return this.request(`/api/admin/users/${encodeURIComponent(username)}`, {
      method: 'DELETE'
    });
  },

  // Returns a server-generated temporary password, once. Nothing stores it in
  // readable form, so a lost response means resetting again.
  async resetUserPassword(username) {
    return this.request(
      `/api/admin/users/${encodeURIComponent(username)}/reset-password`,
      { method: 'POST' }
    );
  },

  // Task APIs
  async getTasks(startDate, endDate) {
    let url = '/api/tasks';
    if (startDate && endDate) {
      url += `?startDate=${startDate}&endDate=${endDate}`;
    }
    const data = await this.request(url);
    // Null when the session has expired: request() has already sent the
    // browser to /login, and this page is on its way out.
    return data ? data.tasks || [] : [];
  },

  async createTask(taskData) {
    const data = await this.request('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(taskData)
    });
    return data.task;
  },

  async updateTask(id, updates) {
    const data = await this.request(`/api/tasks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    });
    return data.task;
  },

  async batchUpdateTasks(updatesList) {
    const data = await this.request('/api/tasks/batch-update', {
      method: 'POST',
      body: JSON.stringify({ updates: updatesList })
    });
    return data.updated || [];
  },

  async deleteTask(id) {
    return this.request(`/api/tasks/${id}`, {
      method: 'DELETE'
    });
  },

  // Settings APIs
  async getSettings() {
    const data = await this.request('/api/settings');
    return data ? data.settings : null;
  },

  async updateSettings(settings) {
    const data = await this.request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(settings)
    });
    return data.settings;
  },

  // Categories APIs
  //
  // Tasks store a category by name, so these only ever move the category
  // records themselves; the server cascades a rename or a delete onto tasks.
  async getCategories() {
    const data = await this.request('/api/categories');
    return data ? data.categories : null;
  },

  async createCategory(category) {
    const data = await this.request('/api/categories', {
      method: 'POST',
      body: JSON.stringify(category)
    });
    return data.category;
  },

  // Returns { category, renamedFrom, retagged, recoloured } - the counts say
  // what the cascade actually touched, including tasks this client never held.
  async updateCategory(id, patch) {
    return this.request(`/api/categories/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch)
    });
  },

  async deleteCategory(id) {
    return this.request(`/api/categories/${id}`, {
      method: 'DELETE'
    });
  },

  // Announcements APIs
  //
  // The feed carries everything the app needs up front - read state, reactions
  // and whether a post still has to arrive - so opening the inbox never waits on
  // the network. The pulse is the cheap poll that decides whether the feed is
  // worth fetching again.
  async getAnnouncementFeed() {
    return this.request('/api/announcements/feed');
  },

  async getAnnouncementPulse() {
    return this.request('/api/announcements/pulse');
  },

  async getAnnouncement(id) {
    const data = await this.request(`/api/announcements/${encodeURIComponent(id)}`);
    return data ? data.announcement : null;
  },

  // Fire-and-forget, like pushIntegrationCompletion: a lost receipt costs one
  // post popping up a second time, which is not worth an error on screen.
  recordAnnouncementEvent(id, event) {
    return this.request(`/api/announcements/${encodeURIComponent(id)}/receipts`, {
      method: 'POST',
      body: JSON.stringify({ event })
    }).catch(() => null);
  },

  async reactToAnnouncement(id, reaction) {
    return this.request(`/api/announcements/${encodeURIComponent(id)}/reaction`, {
      method: 'PUT',
      body: JSON.stringify({ reaction })
    });
  },

  async markAllAnnouncementsRead() {
    return this.request('/api/announcements/read-all', { method: 'POST' });
  },

  // Announcement Studio (admin)
  async listStudioAnnouncements() {
    return this.request('/api/admin/announcements');
  },

  async getStudioAnnouncement(id) {
    return this.request(`/api/admin/announcements/${encodeURIComponent(id)}`);
  },

  async createStudioAnnouncement(fields) {
    const data = await this.request('/api/admin/announcements', {
      method: 'POST',
      body: JSON.stringify(fields)
    });
    return data ? data.announcement : null;
  },

  // `fields.revision` is the revision being edited. A 409 carries the stored
  // post on err.data.announcement, so the Studio can offer to load it.
  async saveStudioAnnouncement(id, fields) {
    const data = await this.request(`/api/admin/announcements/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(fields)
    });
    return data ? data.announcement : null;
  },

  // action: publish | unpublish | archive | redeliver | duplicate
  async transitionStudioAnnouncement(id, action, body = {}) {
    const data = await this.request(
      `/api/admin/announcements/${encodeURIComponent(id)}/${action}`,
      { method: 'POST', body: JSON.stringify(body) }
    );
    return data ? data.announcement : null;
  },

  async deleteStudioAnnouncement(id) {
    return this.request(`/api/admin/announcements/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
  },

  async previewAnnouncement(id) {
    const data = await this.request(`/api/admin/announcements/${encodeURIComponent(id)}/preview`);
    return data ? data.announcement : null;
  },

  // Media library (admin). Only the signing and the confirmation travel through
  // here; the file itself goes from the browser straight to storage.
  async getMediaStatus() {
    return this.request('/api/admin/media/status');
  },

  async listMedia() {
    const data = await this.request('/api/admin/media');
    return data ? data.media || [] : [];
  },

  async createMediaUpload(details) {
    return this.request('/api/admin/media/uploads', {
      method: 'POST',
      body: JSON.stringify(details)
    });
  },

  async completeMediaUpload(id) {
    const data = await this.request(`/api/admin/media/${encodeURIComponent(id)}/complete`, {
      method: 'POST'
    });
    return data ? data.media : null;
  },

  async deleteMedia(id) {
    return this.request(`/api/admin/media/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  // Integrations APIs
  //
  // The provider is always a parameter, never baked into a URL, so these work
  // unchanged for anything added to the server-side connector registry.
  // Connecting is deliberately absent: it is a full-page navigation to
  // /api/integrations/<provider>/connect, because it redirects off-site and a
  // fetch cannot follow that.
  async getIntegrations() {
    const data = await this.request('/api/integrations');
    return data ? data.providers || [] : [];
  },

  async syncIntegration(provider, force = false) {
    const data = await this.request(`/api/integrations/${provider}/sync`, {
      method: 'POST',
      body: JSON.stringify({ force })
    });
    return data ? data.result : null;
  },

  async disconnectIntegration(provider) {
    return this.request(`/api/integrations/${provider}`, { method: 'DELETE' });
  },

  async undismissIntegration(provider) {
    const data = await this.request(`/api/integrations/${provider}/undismiss`, {
      method: 'POST'
    });
    return data ? data.result : null;
  },

  // Fire-and-forget: the next sync reconciles anything that fails, so a
  // background push must never surface an error or block the UI.
  pushIntegrationCompletion(provider, taskId) {
    return this.request(`/api/integrations/${provider}/push`, {
      method: 'POST',
      body: JSON.stringify({ taskId })
    }).catch(() => null);
  },

  // Admin analytics. One section per tab, fetched on first entry rather than on
  // page load - five reports up front would be five sets of aggregations for
  // four tabs nobody has looked at yet.
  //
  // Goes through request() like everything else so the 401 -> /login redirect
  // is shared; a non-admin gets a 403 instead, which the page reports rather
  // than redirecting, because being signed in as the wrong person is a
  // different situation from not being signed in.
  async getAnalytics(section, days) {
    return this.request(
      `/api/admin/analytics/${section}?days=${encodeURIComponent(days)}`
    );
  }
};
