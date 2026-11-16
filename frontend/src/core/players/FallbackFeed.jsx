/**
 * A camera's live picture for a zone editor, with the camera's still behind it.
 *
 * Every zone editor draws over a player, and a camera that is offline, slow or
 * failing used to leave a black box: nothing to draw on. Now the box opens on
 * the picture the server already holds for the camera (its memory copy or the
 * saved picture -- `cached` asks never trigger a grab, since live is starting
 * on the same NVR at that moment) and live starts at once underneath; once
 * live has a frame painted, the still fades out over it. For an online camera
 * nothing is drawn on the still, so the switch to live is not noticed. Only
 * when live has not played within LIVE_FALLBACK_MS, reports an error, or the
 * camera is known to be offline is a fresh still asked for (the server may
 * grab one).
 *
 * An offline camera never reaches live, so its picture carries a small
 * "Offline · <date>" chip and a way to Camera health for that camera. With no
 * picture at all the server says why (409 never_connected | expired). Pictures
 * only ever come from the camera or its recording: there is no upload. Updating
 * the saved picture by hand lives in the editors' ⋯ menus
 * (useUpdateSavedPicture), not on the picture.
 *
 * `renderLive(onState)` returns the player; it must pass `onState` through.
 * `online` is the camera's status when the caller has it; otherwise it is read
 * from the shared camera list. `chromeAt="bottom"` moves the chips and buttons
 * to the bottom edge, for editors that keep their own hints along the top.
 */
import { Fragment, useContext, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CameraOff, RefreshCw } from 'lucide-react';
import { useCameras } from '@/core/hooks/useQueries';
import { freshenSavedPicture, useSnapshot } from '@/core/hooks/useSnapshot';
import { fmtPictureTime } from '@/core/hooks/useUpdateSavedPicture';
import { makeEntitlement } from '@/core/nav/entitlements';
import { useAuthStore } from '@/core/store/authStore';
import { MediaChrome } from './MediaChrome';
import { MediaAspectContext, ratioOf } from './media-aspect';
import { chromeHit } from './media-chrome';

const LIVE_FALLBACK_MS = 4000;
// After the player gives up, how long before live is tried again. Each try is
// a /stream/start, so not faster than this.
const LIVE_RETRY_MS = 30_000;
// The still fades out over live this long, so the switch is not seen.
const FADE_MS = 500;

const chromeButton =
  'pointer-events-auto inline-flex items-center gap-1.5 rounded-md bg-black/70 px-2.5 py-1 text-small font-semibold text-white ring-1 ring-white/15 backdrop-blur-sm transition hover:bg-black/85';

function NoPicture({ snap }) {
  const never = snap.reason === 'never_connected';
  const expired = snap.reason === 'expired';
  const title = never
    ? 'Never connected'
    : expired
      ? (snap.lastSeenAt ? `Offline since ${fmtPictureTime(snap.lastSeenAt)}` : 'Offline')
      : 'No picture yet';
  const detail = never
    ? 'This camera has not sent a picture yet.'
    : expired
      ? 'No recent picture of this camera is saved.'
      : 'Still trying to reach the camera.';
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-neutral-950 p-6 text-center">
      <CameraOff className="h-8 w-8 text-white/40" />
      <p className="text-body font-semibold text-white">{title}</p>
      <p className="text-small text-white/60">{detail}</p>
    </div>
  );
}

// One mount per camera: switching camera starts from a clean slate (live
// state, timers, the still) without resetting each piece by hand.
export default function FallbackFeed(props) {
  return <CameraFeed key={props.monitorId} {...props} />;
}

function CameraFeed({ monitorId, online, renderLive, chromeAt = 'top' }) {
  // The shared camera list: status when the caller has none, and the stored
  // width/height that shape the drawing box before any picture arrives.
  const { data: cameras } = useCameras();
  const listed = Array.isArray(cameras) ? cameras.find((c) => c.mid === monitorId) : null;
  const isOnline = online ?? (listed ? listed.status === 'online' : undefined);
  const offline = isOnline === false;

  const user = useAuthStore((s) => s.user);
  const canSeeHealth = makeEntitlement(user).has('camera_health');

  const [live, setLive] = useState('loading');
  const [waited, setWaited] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const [videoAspect, setVideoAspect] = useState(null);
  const [stillAspect, setStillAspect] = useState(null);
  const onState = (state, _error, frame) => {
    setLive(state);
    if (frame) setVideoAspect(ratioOf(frame.width, frame.height));
  };
  const playing = live === 'playing';

  // Live is on screen: let the server re-save this camera's picture from the
  // live stream if the saved one is old, so the next opening matches live.
  useEffect(() => { if (playing) freshenSavedPicture(monitorId); }, [playing, monitorId]);

  // Live is late once it has not played within LIVE_FALLBACK_MS of opening.
  useEffect(() => {
    if (playing) return undefined;
    const timer = setTimeout(() => setWaited(true), LIVE_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [playing]);

  // Keep live trying underneath once the player has given up.
  useEffect(() => {
    if (live !== 'error') return undefined;
    const timer = setTimeout(() => setAttempt((n) => n + 1), LIVE_RETRY_MS);
    return () => clearTimeout(timer);
  }, [live, attempt]);

  // Until live plays, show whatever picture is held. Ask for a fresh one only
  // once live is late, failing, or the camera is known to be offline.
  const needFresh = !playing && (offline || waited || live === 'error');
  const snap = useSnapshot(playing ? null : monitorId, true, { cachedOnly: !needFresh });
  const picture = !playing && snap?.url ? snap : null;
  // The still on screen, kept through its fade once live has a frame painted
  // under it -- removing it outright showed a black frame between the two.
  const [held, setHeld] = useState(null);
  if (picture && picture !== held) setHeld(picture);
  useEffect(() => {
    if (!playing || !held) return undefined;
    const timer = setTimeout(() => setHeld(null), FADE_MS + 100);
    return () => clearTimeout(timer);
  }, [playing, held]);
  const still = picture || held;
  const fade = `transition-opacity duration-500 ease-out ${playing ? 'opacity-0' : 'opacity-100'}`;

  // The shape of what is on screen: the video while it plays, else the still,
  // else what the camera was registered with. The canvas sizes its box from it.
  const reportAspect = useContext(MediaAspectContext);
  const aspect = (playing && videoAspect) || (picture && stillAspect) || videoAspect || stillAspect
    || ratioOf(listed?.width, listed?.height);
  useEffect(() => { if (aspect) reportAspect?.(aspect); }, [aspect, reportAspect]);
  // "No picture" is only said once a fresh one has been asked for too.
  const noPicture = needFresh && snap && !snap.url && snap.error && !snap.fromCache ? snap : null;
  const edge = chromeAt === 'bottom' ? 'bottom-2' : 'top-2';
  // Camera health: for an offline camera's picture, and for "never connected"
  // or "expired" with no picture at all.
  const showHealth = (offline && still)
    || (noPicture && (noPicture.reason === 'never_connected' || noPicture.reason === 'expired'));

  const retryLive = (e) => {
    e.stopPropagation();
    setLive('loading');
    setAttempt((n) => n + 1);
  };

  return (
    <div className="relative h-full w-full">
      <Fragment key={`${monitorId}:${attempt}`}>{renderLive(onState)}</Fragment>

      {still ? (
        <img
          alt=""
          className={`pointer-events-none absolute inset-0 h-full w-full select-none bg-neutral-950 object-contain ${fade}`}
          draggable={false}
          onLoad={(e) => setStillAspect(ratioOf(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight))}
          src={still.url}
        />
      ) : null}
      {noPicture ? <NoPicture snap={noPicture} /> : null}

      <MediaChrome>
        {offline && still ? (
          <div className={`absolute left-2 ${edge}`}>
            <span
              className="inline-flex items-center gap-1.5 rounded-md bg-black/70 px-2 py-1 text-small font-semibold text-white ring-1 ring-white/15 backdrop-blur-sm"
              title="The camera is offline. This is its last saved picture."
            >
              <span className="h-1.5 w-1.5 rounded-full bg-white/50" />
              Offline · {fmtPictureTime(still.at)}
            </span>
          </div>
        ) : null}

        {live === 'error' && !offline ? (
          <div className={`absolute right-2 ${edge}`}>
            <button className={chromeButton} onClick={retryLive} type="button" {...chromeHit}>
              <RefreshCw className="h-3.5 w-3.5" /> Retry live
            </button>
          </div>
        ) : null}

        {showHealth ? (
          <div className={`absolute inset-x-0 ${chromeAt === 'bottom' ? 'bottom-14' : 'bottom-4'} flex justify-center`}>
            {canSeeHealth ? (
              <Link
                className={chromeButton}
                onClick={(e) => e.stopPropagation()}
                to={`/health?q=${encodeURIComponent(monitorId)}`}
                {...chromeHit}
              >
                Check in Camera health
              </Link>
            ) : (
              <span className="rounded-md bg-black/70 px-2.5 py-1 text-small text-white/70 ring-1 ring-white/15">
                Ask an admin to check this camera
              </span>
            )}
          </div>
        ) : null}
      </MediaChrome>
    </div>
  );
}
