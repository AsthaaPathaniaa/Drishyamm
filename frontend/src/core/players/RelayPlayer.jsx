import { useEffect, useRef, useState } from 'react';
import { subscribe } from '@/core/services/liveRelay';
import { listen as listenAudio } from '@/core/services/liveAudio';
import { createMseSink } from './relay/mseSink';
import PlayerFrame from './PlayerFrame';

// A stream whose picture hasn't moved for this long counts as stalled.
const MAIN_STALL_MS = 3000;

/**
 * RelayPlayer — the camera's own stream (H.265 or H.264, no server transcode
 * where this device can decode it) over the backend live relay, decoded by the
 * browser's MediaSource. See services/liveRelay.js and
 * backend/src/services/liveRelay.service.js.
 *
 * Starts instantly on a warm camera: the server sends the last keyframe and
 * every frame since, and the sink jumps to the newest frame.
 *
 * Fullscreen (quality 'high'): the sub-stream plays at once in the visible
 * <video>; main loads in a second, hidden <video> and takes over as soon as
 * its picture moves. If main stalls (an NVR or network that can't carry it),
 * the sub — still running underneath — is shown again until main recovers, so
 * the picture never freezes on a dead main.
 *
 * Calls `onFallback()` once if the relay can't play at all (no MSE, repeated
 * errors); the parent then mounts the WebRTC player.
 */
export default function RelayPlayer({
  monitorId,
  quality = 'auto',
  muted = true,
  controls = true,
  className = '',
  aiOverlay = true,
  digitalZoom = true,
  fit = 'contain',
  protocolBadge = true,
  onFallback,
  onState,               // (state, error, frame) — see PlayerFrame
}) {
  const subRef = useRef(null);
  const mainRef = useRef(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState(null);
  const [showing, setShowing] = useState('sub');
  const wantMain = quality === 'high';

  useEffect(() => {
    const subEl = subRef.current;
    const mainEl = mainRef.current; // only rendered in fullscreen (wantMain)
    if (!monitorId || !subEl || (wantMain && !mainEl)) return undefined;
    let alive = true;
    let fellBack = false;
    let errors = 0;
    setState('loading');
    setError(null);
    subEl.hidden = false;
    if (mainEl) mainEl.hidden = true;
    setShowing('sub');

    const fail = (msg) => {
      if (!alive || fellBack) return;
      errors++;
      // Playable range stuck while frames arrive (a track stopped): the
      // WebRTC player copes with that, hand over at once.
      if (msg === 'stalled') errors = 3;
      if (errors >= 3) {
        fellBack = true;
        setError(msg);
        onFallback?.();
      }
    };

    const subSink = createMseSink(subEl, {
      onFirstFrame: () => { if (alive) setState('playing'); },
      onError: fail,
    });
    const unsubSub = subscribe(monitorId, 'sub', subSink);

    let mainSink = null;
    let unsubMain = null;
    let watch = null;
    if (wantMain) {
      mainSink = createMseSink(mainEl, {
        onFirstFrame: () => { if (alive) setState('playing'); },
        onError: () => { /* main is optional: the sub keeps playing */ },
      });
      unsubMain = subscribe(monitorId, 'main', mainSink);

      // Show main while its picture moves, else the sub.
      let lastT = -1;
      let movedAt = 0;
      watch = setInterval(() => {
        if (!alive) return;
        const t = mainEl.currentTime;
        if (t !== lastT && mainEl.readyState >= 2) { lastT = t; movedAt = performance.now(); }
        const mainLive = movedAt && performance.now() - movedAt < MAIN_STALL_MS;
        if (mainLive && mainEl.hidden) {
          mainEl.hidden = false; subEl.hidden = true; setShowing('main');
        } else if (!mainLive && subEl.hidden) {
          subEl.hidden = false; mainEl.hidden = true; setShowing('sub');
        }
      }, 250);
    }

    return () => {
      alive = false;
      if (watch) clearInterval(watch);
      subSink.destroy();
      unsubSub();
      mainSink?.destroy();
      unsubMain?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitorId, wantMain]);

  // Sound comes on its own socket and <audio> element (services/liveAudio),
  // only while this player is unmuted — never inside the video stream, where
  // late camera audio held the picture back. The <video>s stay muted. Set on
  // the elements directly: React doesn't reliably update `muted`.
  useEffect(() => {
    for (const el of [subRef.current, mainRef.current]) {
      if (el && !el.muted) el.muted = true;
    }
  }, [showing, wantMain]);
  useEffect(() => {
    if (muted || !monitorId) return undefined;
    // The sub carries the same microphone as main and is always running.
    return listenAudio(monitorId, { variant: 'sub' });
  }, [muted, monitorId]);

  return (
    <PlayerFrame
      videoRef={subRef}
      secondVideoRef={wantMain ? mainRef : null}
      monitorId={monitorId}
      state={state}
      error={error}
      onRetry={null}
      onState={onState}
      muted
      controls={controls}
      aiOverlay={aiOverlay}
      digitalZoom={digitalZoom}
      fit={fit}
      className={className}
    >
      {protocolBadge && state === 'playing' && (
        <div className="absolute top-2 right-2 flex items-center gap-1 bg-black/60 px-2 py-0.5 rounded-full pointer-events-none">
          <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
          <span className="text-micro font-semibold text-success tracking-wider">
            LIVE{wantMain ? (showing === 'main' ? ' · HD' : ' · SD') : ''}
          </span>
        </div>
      )}
    </PlayerFrame>
  );
}
