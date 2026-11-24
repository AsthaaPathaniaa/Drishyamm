// Evidence packs (investigation toolkit I-5) via the backend's /api/evidence.
import api from './api';
import { API_BASE } from '@/core/config/endpoints';

export function evidenceDownloadUrl(id) {
  const token = localStorage.getItem('auth_token') || '';
  return `${API_BASE}/api/evidence/${encodeURIComponent(id)}/download?token=${encodeURIComponent(token)}`;
}

export const evidenceService = {
  /** { monitorId, start, end, reason, trackIds?, scores? } → export row (status 'building') */
  async create(body) {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { data } = await api.post('/evidence', { ...body, timeZone });
    return data.export;
  },
  async list() {
    const { data } = await api.get('/evidence');
    return data.exports || [];
  },
  async get(id) {
    const { data } = await api.get(`/evidence/${encodeURIComponent(id)}`);
    return data.export;
  },
  async verify(file, onUploadProgress) {
    const fd = new FormData();
    fd.append('pack', file, file.name || 'evidence.zip');
    const { data } = await api.post('/evidence/verify', fd, {
      headers: { 'Content-Type': 'multipart/form-data' }, timeout: 15 * 60_000, onUploadProgress,
    });
    return data;
  },
};

export default evidenceService;
