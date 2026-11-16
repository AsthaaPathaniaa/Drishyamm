import { useEffect, useState } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import AIOverlay from './AIOverlay';
import ZoomIndicator from './ZoomIndicator';
import { useDigitalZoom } from '@/core/hooks/useDigitalZoom';

/**
 * PlayerFrame — the shared visual shell for every stream player.
 *
 * Owns everything both the WebRTC and HLS players render identically:
 *   - the zoomable <video> stage (wheel/pinch zoom + drag-pan)
 *   - the AI bbox overlay (scales with the video)
 *   - the loading spinner and the error/retry panel
 *
 * The protocol-specific players (WebRTCPlayer, HLSPlayer) own their engine
 * lifecycle and attach media to `videoRef`; they pass their transient state
 * (loading/playing/error) down here and drop their own corner badges / gear /
 * volume controls in via `children`. Keeping this shell separate is what lets
 * the two players stay genuinely independent without duplicating chrome.
 */
export default function PlayerFrame({
  videoRef,
  // Optional second <video> stacked in the same stage (relay player: sub and
  // main side by side; the player toggles `hidden` to show whichever is live).
  secondVideoRef = null,
  monitorId,
  state,                 // 'loading' | 'playing' | 'error'
  error,
  onRetry,
  muted = true,
  controls = true,
  aiOverlay = true,
  digitalZoom = true,
  fit = 'contain',       // 'cover' fills the box and crops - for video walls
  className = '',
  children,              // protocol-specific overlays (badges, gear, volume)
  // (state, error, frame) on every change. 'playing' here means frames are on
  // screen (the <video> fired `playing`), not just that the player has a
  // manifest or a track — a picture drawn over a black video is the case
  // callers care about. `frame` is { width, height } of the video then.
  onState,
}) {
  const [frame, setFrame] = useState(null);
  useEffect(() => {
    // The relay player stacks two videos (sub, then main) and hides one with
    // `hidden`; report the one on screen that has started.
    const els = [videoRef?.current, secondVideoRef?.current].filter(Boolean);
    if (!els.length) return undefined;
    const started = new Set();
    const update = () => {
      const v = els.find((e) => started.has(e) && !e.hidden);
      setFrame(v ? { width: v.videoWidth || 0, height: v.videoHeight || 0 } : null);
    };
    // `playing` can fire a moment before the first frame is painted. Wait for
    // one to be presented, so whatever covers the video (a still) can step
    // aside without a black flash.
    const on = (e) => {
      const el = e.currentTarget;
      const mark = () => { started.add(el); update(); };
      if (el.requestVideoFrameCallback) el.requestVideoFrameCallback(mark); else mark();
    };
    const off = (e) => { started.delete(e.currentTarget); update(); };
    const watch = new MutationObserver(update);
    els.forEach((el) => {
      el.addEventListener('playing', on);
      el.addEventListener('resize', update);
      el.addEventListener('emptied', off);
      watch.observe(el, { attributes: true, attributeFilter: ['hidden'] });
    });
    return () => {
      watch.disconnect();
      els.forEach((el) => {
        el.removeEventListener('playing', on);
        el.removeEventListener('resize', update);
        el.removeEventListener('emptied', off);
      });
    };
  }, [videoRef, secondVideoRef]);

  const reported = state === 'playing' && !frame ? 'loading' : state;
  const frameW = frame?.width || 0;
  const frameH = frame?.height || 0;
  useEffect(() => {
    onState?.(reported, reported === 'error' ? error : null, frameW && frameH ? { width: frameW, height: frameH } : null);
  }, [reported, error, onState, frameW, frameH]);

  // A single camera is shown whole (contain): nothing of the frame is hidden.
  // A wall tile is a cell of a grid whose shape is the screen's, not the
  // camera's, so contain letterboxes every tile - 'cover' fills it instead.
  // AIOverlay maps its boxes onto a contained video, so cover is only honoured
  // where the overlay is off.
  const objectFit = fit === 'cover' && !aiOverlay ? 'object-cover' : 'object-contain';
  const zoom = useDigitalZoom({ minZoom: 1, maxZoom: 8 });

  const stageCursor = digitalZoom
    ? (zoom.dragging ? 'grabbing' : (zoom.isZoomed ? 'grab' : 'auto'))
    : 'auto';

  const videoEl = (
    <>
      <video
        ref={videoRef}
        muted={muted}
        playsInline
        autoPlay
        controls={controls && !(digitalZoom && zoom.isZoomed)}
        className={`w-full h-full ${objectFit}`}
      />
      {secondVideoRef && (
        <video
          ref={secondVideoRef}
          hidden
          muted={muted}
          playsInline
          autoPlay
          controls={controls && !(digitalZoom && zoom.isZoomed)}
          className={`w-full h-full ${objectFit}`}
        />
      )}
    </>
  );

  return (
    <div className={`relative bg-neutral-950 flex items-center justify-center overflow-hidden ${className}`}>
      {digitalZoom ? (
        <div
          ref={zoom.bind.ref}
          {...zoom.bind.handlers}
          className="absolute inset-0 select-none"
          style={{ touchAction: 'none', cursor: stageCursor }}
        >
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{
              transform: zoom.transform,
              transformOrigin: 'center center',
              willChange: 'transform',
              transition: zoom.dragging ? 'none' : 'transform 100ms ease-out',
            }}
          >
            {videoEl}
            {aiOverlay && state === 'playing' && <AIOverlay monitorId={monitorId} />}
          </div>
        </div>
      ) : (
        <>
          {videoEl}
          {aiOverlay && state === 'playing' && <AIOverlay monitorId={monitorId} />}
        </>
      )}

      {digitalZoom && state === 'playing' && (
        <ZoomIndicator
          zoom={zoom.zoom}
          onZoomIn={()  => zoom.setZoom(zoom.zoom * 1.5)}
          onZoomOut={() => zoom.setZoom(zoom.zoom / 1.5)}
          onReset={zoom.reset}
        />
      )}

      {/* Protocol-specific corner overlays (LIVE badge, quality gear, volume). */}
      {children}

      {state === 'loading' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none">
          <Loader2 className="w-10 h-10 text-brand animate-spin" />
          <span className="text-small text-white/50 tracking-wide font-medium">Connecting to camera…</span>
          <span className="text-micro text-white/25">May take up to 15s on first connect</span>
        </div>
      )}

      {state === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-neutral-950/80 p-6">
          <AlertCircle className="w-10 h-10 text-danger" />
          <div className="text-center">
            <p className="text-body font-semibold text-white mb-1">Stream Unavailable</p>
            <p className="text-small text-white/60">{error || 'Could not connect to camera'}</p>
          </div>
          {onRetry && (
            <button
              onClick={onRetry}
              className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-small font-semibold text-white transition-colors"
            >
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}
