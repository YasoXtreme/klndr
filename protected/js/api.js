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
      throw new Error(data.error || 'API Request Failed');
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

  // Task APIs
  async getTasks(startDate, endDate) {
    let url = '/api/tasks';
    if (startDate && endDate) {
      url += `?startDate=${startDate}&endDate=${endDate}`;
    }
    const data = await this.request(url);
    return data.tasks || [];
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
    return data.settings;
  },

  async updateSettings(settings) {
    const data = await this.request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(settings)
    });
    return data.settings;
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
  }
};
