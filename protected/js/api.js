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

  async createBetaUser(username, password, role = 'user') {
    return this.request('/api/admin/create-user', {
      method: 'POST',
      body: JSON.stringify({ username, password, role })
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
  async getAnnouncements() {
    return this.request('/api/announcements');
  },

  async getMissedAnnouncements() {
    const data = await this.request('/api/announcements/missed');
    return data ? data.announcements || [] : [];
  },

  async createAnnouncement(title, content, headerImageUrl) {
    const data = await this.request('/api/announcements', {
      method: 'POST',
      body: JSON.stringify({ title, content, header_image_url: headerImageUrl || null })
    });
    return data ? data.announcement : null;
  },

  async markAnnouncementsSeen(lastSeenId) {
    return this.request('/api/announcements/seen', {
      method: 'PUT',
      body: JSON.stringify({ last_seen_id: lastSeenId })
    });
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
