// File import (investigation toolkit I-7) via /api/investigate/imports.
import api from './api';
import { API_BASE } from '@/core/config/endpoints';

export function importVideoUrl(id) {
  const token = localStorage.getItem('auth_token') || '';
  return `${API_BASE}/api/investigate/imports/${encodeURIComponent(id)}/video?token=${encodeURIComponent(token)}`;
}

export const importsService = {
  async upload(file, { title, place, source, recordedAt } = {}, onUploadProgress) {
    const fd = new FormData();
    if (title) fd.append('title', title);
    if (place) fd.append('place', place);
    if (source) fd.append('source', source);
    if (recordedAt) fd.append('recordedAt', recordedAt);
    if (file.lastModified) fd.append('fileModifiedAt', new Date(file.lastModified).toISOString());
    fd.append('video', file, file.name);           // last: fields must arrive before the file
    const { data } = await api.post('/investigate/imports', fd, {
      headers: { 'Content-Type': 'multipart/form-data' }, timeout: 0, onUploadProgress,
    });
    return data.import;
  },
  list: () => api.get('/investigate/imports').then((r) => r.data.imports),
  get: (id) => api.get(`/investigate/imports/${encodeURIComponent(id)}`).then((r) => r.data.import),
  reindex: (id) => api.post(`/investigate/imports/${encodeURIComponent(id)}/index`).then((r) => r.data.import),
  remove: (id) => api.delete(`/investigate/imports/${encodeURIComponent(id)}`).then((r) => r.data),
};

export default importsService;
