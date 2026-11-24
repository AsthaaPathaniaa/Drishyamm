// Smart Search (investigation toolkit, I-2). Every call goes through the
// backend's /api/investigate proxy, which adds the tenant (JWT) and limits
// results to this user's cameras. Never call the AI service from the browser.
import api from './api';
import { API_BASE } from '@/core/config/endpoints';

/** A URL an <img> can load (no Authorization header): the JWT rides as ?token=. */
export function cropUrl(trackId) {
  const token = localStorage.getItem('auth_token') || '';
  return `${API_BASE}/api/investigate/tracks/${encodeURIComponent(trackId)}/crop?token=${encodeURIComponent(token)}`;
}

export const investigateService = {
  async status() {
    const { data } = await api.get('/investigate/status');
    return data;
  },

  /** { q, overrides, tz } → { parsed, filters, results, summary, model } */
  async search({ q, overrides = {}, topK = 60 }) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
    const { data } = await api.post('/investigate/search', { q, tz, overrides, top_k: topK }, { timeout: 30_000 });
    return data;
  },

  async searchPhoto(file, { overrides = {}, topK = 60 } = {}) {
    const fd = new FormData();
    fd.append('photo', file, file.name || 'photo.jpg');
    fd.append('filters', JSON.stringify(overrides));
    fd.append('top_k', String(topK));
    const { data } = await api.post('/investigate/search/photo', fd, {
      headers: { 'Content-Type': 'multipart/form-data' }, timeout: 60_000,
    });
    return data;
  },

  async track(trackId) {
    const { data } = await api.get(`/investigate/tracks/${encodeURIComponent(trackId)}`);
    return data;
  },
};

export default investigateService;

// ── Click to track (I-3) ─────────────────────────────────────────────
export const journeyService = {
  /** Who is at (x, y) — 0-1000 across the picture — on this camera at `ts`? → { track_id } */
  async trackAt({ cameraCode, ts, x, y }) {
    const { data } = await api.post('/investigate/track-at', { camera_code: cameraCode, ts, x, y });
    return data;
  },
  /** → { seed, stops, candidates, route, sightings, thresholds } */
  async journey(trackId, { windowS } = {}) {
    const { data } = await api.post('/investigate/journey', { track_id: trackId, ...(windowS ? { window_s: windowS } : {}) },
      { timeout: 30_000 });
    return data;
  },
  async review(seedTrackId, trackId, verdict, score) {
    const { data } = await api.post('/investigate/journey/review', { seed_track_id: seedTrackId, track_id: trackId, verdict, score });
    return data;
  },
  async stitch(sightings) {
    const { data } = await api.post('/investigate/journey/stitch', { sightings });
    return data;
  },
  async stitchStatus(jobId) {
    const { data } = await api.get(`/investigate/journey/stitch/${encodeURIComponent(jobId)}`);
    return data;
  },
  /** Who was with this person (phase 4 Associations): { companions, stops } */
  async companions(trackId) {
    const { data } = await api.get(`/investigate/tracks/${encodeURIComponent(trackId)}/companions`);
    return data;
  },
  stitchVideoUrl(jobId) {
    const token = localStorage.getItem('auth_token') || '';
    return `${API_BASE}/api/investigate/journey/stitch/${encodeURIComponent(jobId)}/video?token=${encodeURIComponent(token)}`;
  },
};

// ── Video synopsis (phase 4) ─────────────────────────────────────────
export const synopsisService = {
  async start({ monitorId, from, to, speed }) {
    const tzOffsetMin = -new Date(from).getTimezoneOffset();
    const { data } = await api.post('/investigate/synopsis', { monitorId, from, to, tzOffsetMin, speed });
    return data;
  },
  async status(jobId) {
    const { data } = await api.get(`/investigate/synopsis/${encodeURIComponent(jobId)}`);
    return data;
  },
  videoUrl(jobId) {
    const token = localStorage.getItem('auth_token') || '';
    return `${API_BASE}/api/investigate/synopsis/${encodeURIComponent(jobId)}/video?token=${encodeURIComponent(token)}`;
  },
};

// ── Ask Drishyam (I-8) and Summaries (I-9) ───────────────────────────
export const askService = {
  async ask(question) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
    const { data } = await api.post('/investigate/ask', { question, tz }, { timeout: 90_000 });
    return data;
  },
  async summary(period = 'last_night', cameras = []) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
    const { data } = await api.get('/investigate/summary', { params: { period, tz, camera: cameras }, timeout: 60_000 });
    return data;
  },
};

// ── Audio Search (phase 4) ───────────────────────────────────────────
export const speechService = {
  async transcribe({ monitorId, from, to }) {
    const { data } = await api.post('/investigate/speech/transcribe', { monitorId, from, to });
    return data;
  },
  async status(jobId) {
    const { data } = await api.get(`/investigate/speech/jobs/${encodeURIComponent(jobId)}`);
    return data;
  },
  async search(q) {
    const { data } = await api.get('/investigate/speech', { params: { q } });
    return data;
  },
};
