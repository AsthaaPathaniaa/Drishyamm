import { useAuthStore } from '@/core/store/authStore';
import { makeEntitlement } from '@/core/nav/entitlements';
import { REPORT_TYPES } from './report-vocabulary';

/**
 * Report types this account can make. A VMS-only account (aiEnabled false)
 * has no AI detections, so the AI-built types (`ai: true` in REPORT_TYPES)
 * would only ever be empty: it gets Camera Health and Recording.
 */
export function reportTypesFor(aiOn) {
  return aiOn ? REPORT_TYPES : REPORT_TYPES.filter((t) => !t.ai);
}

export const defaultReportType = (aiOn) => (aiOn ? 'ai_events' : 'camera_health');

export function useReportAccess() {
  const user = useAuthStore((s) => s.user);
  const { aiOn } = makeEntitlement(user);
  return { aiOn, types: reportTypesFor(aiOn), defaultType: defaultReportType(aiOn) };
}
