import api from '@/core/services/api';

/**
 * Camera / NVR status alerts for the signed-in account (every plan, no AI).
 * Backend: GET /api/alerts/system — rows of platform_events of types
 * camera.offline | camera.recovered | nvr.down | nvr.recovered.
 * Live: socket event 'system.alert' with the same shape.
 */
export const systemAlertsService = {
  list({ since, limit = 100 } = {}) {
    return api.get('/alerts/system', { params: { since, limit } }).then((r) => r.data?.items || []);
  },
};

const META = {
  'camera.offline':   { nounWhen: 'Camera offline', tone: 'warn',     iconName: 'WifiOff', problem: true },
  'nvr.down':         { nounWhen: 'NVR down',       tone: 'critical', iconName: 'WifiOff', problem: true },
  'camera.recovered': { nounWhen: 'Back online',    tone: 'good',     iconName: 'Wifi',    problem: false },
  'nvr.recovered':    { nounWhen: 'NVR back',       tone: 'good',     iconName: 'Wifi',    problem: false },
};

const THEME_HEX = { good: '#10b981', warn: '#f59e0b', critical: '#ef4444', neutral: '#64748b' };

/** View-model in the same shape describe() returns for AI events, plus `system: true`. */
export function describeSystem(evt) {
  const m = META[evt.type] || { nounWhen: 'System', tone: 'neutral', iconName: 'Activity', problem: false };
  const d = evt.data || {};
  const where = d.groupName || (Array.isArray(d.groups) && d.groups.length === 1 ? d.groups[0].name : null);
  const cameraLabel = d.count > 1 ? `${d.count} cameras${where ? ` · ${where}` : ''}`
                    : (d.cameras?.[0] || where || 'Camera');
  return {
    system: true,
    problem: m.problem,
    title: evt.summary || m.nounWhen,
    subject: cameraLabel,
    nounWhen: m.nounWhen,
    tone: m.tone,
    theme: { hex: THEME_HEX[m.tone] },
    iconName: m.iconName,
    cameraLabel,
    confidencePct: null,
    isUnknown: false,
    when: new Date(evt.createdAt),
  };
}
