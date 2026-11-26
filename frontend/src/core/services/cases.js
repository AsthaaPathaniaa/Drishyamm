// Cases (investigation toolkit I-4) via the backend's /api/cases.
import api from './api';
import { API_BASE } from '@/core/config/endpoints';

export function keptFootageUrl(caseId, itemId) {
  const token = localStorage.getItem('auth_token') || '';
  return `${API_BASE}/api/cases/${encodeURIComponent(caseId)}/items/${encodeURIComponent(itemId)}/footage?token=${encodeURIComponent(token)}`;
}

const unwrap = (p, key) => p.then(({ data }) => data[key]);

export const casesService = {
  list: (status) => unwrap(api.get('/cases', { params: status ? { status } : {} }), 'cases'),
  create: (body) => unwrap(api.post('/cases', body), 'case'),
  get: (id) => unwrap(api.get(`/cases/${encodeURIComponent(id)}`), 'case'),
  update: (id, patch) => unwrap(api.patch(`/cases/${encodeURIComponent(id)}`, patch), 'case'),
  addItem: (id, item) => unwrap(api.post(`/cases/${encodeURIComponent(id)}/items`, item), 'item'),
  removeItem: (id, itemId) => api.delete(`/cases/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`).then((r) => r.data),
  keep: (id, itemId) => unwrap(api.post(`/cases/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/keep`), 'item'),
  people: () => unwrap(api.get('/cases/people'), 'people'),
  setMember: (id, userId, role) => unwrap(api.put(`/cases/${encodeURIComponent(id)}/members`, { userId, role }), 'member'),
  removeMember: (id, userId) => api.delete(`/cases/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`).then((r) => r.data),
};

export default casesService;
