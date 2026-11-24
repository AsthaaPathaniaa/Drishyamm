/**
 * playback.js — REST client for NVR playback: replaying the NVR's own
 * recordings. Backend: smart-cam-backend/src/controllers/playback.controller.js.
 */
import api from '@/core/services/api';
import { API_URL } from '@/core/config/endpoints';

const token = () => {
  try { return localStorage.getItem('auth_token') || ''; } catch { return ''; }
};

export const playbackService = {
  /**
   * Start an on-demand replay. Resolves { pathName, hlsUrl, webrtcUrl, range },
   * or with `relay` (browsers that decode H.265) possibly { mode: 'relay',
   * pathName, ticket }: the NVR's own stream over the live relay WebSocket.
   */
  start({ monitorId, start, end, relay = false, hevc = false }) {
    return api.post('/playback/nvr/start', { monitorId, start, end, relay, hevc }).then((r) => r.data);
  },

  stop(pathName) {
    return api.post('/playback/nvr/stop', { pathName }).then((r) => r.data);
  },

  /**
   * Stop from `pagehide`, where an axios call dies with the page. A beacon
   * can't carry the Authorization header, so the JWT and the path ride in the
   * query string (no body, so no CORS preflight). Best effort: the backend's
   * 30-minute session cap is the backstop.
   */
  stopBeacon(pathName) {
    try {
      const qs = new URLSearchParams({ pathName, token: token() });
      navigator.sendBeacon?.(`${API_URL}/playback/nvr/stop?${qs}`);
    } catch { /* page is going away regardless */ }
  },

  /** Where the NVR has footage: { supported, reason, segments: [{ start, end, kind }] }. */
  recordings({ monitorId, start, end }) {
    return api.get('/playback/nvr/recordings', { params: { monitorId, start, end } }).then((r) => r.data);
  },

  /**
   * URL the browser loads directly to download a range as MP4.
   * `kind: 'breach'` marks a no-entry breach's evidence clip, which the backend
   * caps at the 60 s window clipWindow() pads (15 s before, 45 s after).
   */
  exportUrl({ monitorId, start, end, format = 'mp4', name, kind }) {
    const qs = new URLSearchParams({ monitorId, start, end, format, token: token() });
    if (name) qs.set('name', name);
    if (kind) qs.set('kind', kind);
    return `${API_URL}/playback/nvr/export?${qs}`;
  },

  /**
   * Download an export URL through a hidden iframe rather than a link, so an
   * error answer (another export running, no footage) can't navigate the app
   * away. A download never fires `load` on the frame; a load means the server
   * answered with an error document instead, whose message is passed to
   * `onError` when it's readable. The backend records the whole clip before it
   * answers (that is what gives the file a duration and a seek index) and the
   * NVR replays in real time, so nothing reaches the browser for about the
   * clip's length: the frame lives for that plus a margin.
   */
  download(url, durationMs, onError) {
    const frame = document.createElement('iframe');
    frame.style.display = 'none';
    frame.addEventListener('load', () => {
      let text = '';
      try {
        if (frame.contentWindow.location.href === 'about:blank') return;
        text = frame.contentDocument?.body?.innerText || '';
      } catch { /* cross-origin error page: no detail to read */ }
      let message = 'The export could not start.';
      try { message = JSON.parse(text).message || message; } catch { /* not JSON */ }
      onError?.(message);
      frame.remove();
    });
    frame.src = url;
    document.body.appendChild(frame);
    setTimeout(() => frame.remove(), durationMs + 5 * 60_000);
  },
};
