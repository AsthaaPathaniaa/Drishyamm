// "Update saved picture" — re-take a camera's saved reference picture. Lives in
// the editors' ⋯ menus (Zone Setup's camera bar, the AI Feed area editor),
// never on the picture itself, so the still and live look alike.
//
// Offered to users who may save zones (ZONE_EDIT_KEYS, the backend's gate)
// and only for a camera that is online: an offline one keeps its picture.

import { useState } from 'react';
import { useCameras } from '@/core/hooks/useQueries';
import { updateSavedPicture } from '@/core/hooks/useSnapshot';
import { makeEntitlement, ZONE_EDIT_KEYS } from '@/core/nav/entitlements';
import { useAuthStore } from '@/core/store/authStore';
import { toast } from '@/core/store/toastStore';

/** "14:05" today, "9 Nov, 14:05" this year, "9 Nov 2025, 14:05" before. */
export function fmtPictureTime(value) {
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return '';
  const now = new Date();
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (at.toDateString() === now.toDateString()) return time;
  const date = at.toLocaleDateString([], {
    day: 'numeric', month: 'short', ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${date}, ${time}`;
}

/** @returns {{ allowed: boolean, busy: boolean, run: () => Promise<void> }} */
export function useUpdateSavedPicture(monitorId) {
  const { data: cameras } = useCameras();
  const online = Array.isArray(cameras) && cameras.find((c) => c.mid === monitorId)?.status === 'online';
  const user = useAuthStore((s) => s.user);
  const allowed = Boolean(monitorId) && online && makeEntitlement(user).hasAny(ZONE_EDIT_KEYS);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!allowed || busy) return;
    setBusy(true);
    try {
      const result = await updateSavedPicture(monitorId);
      if (result.status === 'updated') {
        toast.success('Saved picture updated', result.capturedAt ? `Taken at ${fmtPictureTime(result.capturedAt)}` : undefined);
      } else if (result.status === 'queued') {
        toast.info('Queued: the NVR is busy, it will update shortly');
      } else if (result.status === 'too_soon') {
        toast.info('Updated less than 5 minutes ago',
          result.retryAfter ? `Try again in ${Math.ceil(result.retryAfter / 60)} min.` : undefined);
      } else if (result.status === 'offline') {
        toast.error('Camera is offline', 'The saved picture was kept.');
      } else {
        toast.error('Could not update the picture', 'Try again shortly.');
      }
    } finally {
      setBusy(false);
    }
  };

  return { allowed, busy, run };
}
