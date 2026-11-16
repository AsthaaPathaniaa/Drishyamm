/**
 * A camera's own live picture, with nothing drawn on it.
 *
 * Zone Setup used to show the head-count detector's `/video` stream. That
 * stream only exists for cameras already counting, and arrives with the
 * detector's boxes and totals burned in -- so the page could not show a camera
 * before counting was on, and drawing a zone meant drawing over someone
 * else's annotations. The platform's HLS feed has neither problem.
 *
 * Every player control is off: this sits under a drawing surface, and a
 * zoom, a menu or an overlay of its own would fight the pointer. When live
 * does not play, the camera's dated still stands in (see FallbackFeed), so an
 * offline camera can still have its zones drawn.
 */
import FallbackFeed from '@/core/players/FallbackFeed';
import HLSPlayer from '@/core/players/HLSPlayer';

export default function CleanFeed({ monitorId, online }) {
  return (
    <FallbackFeed
      monitorId={monitorId}
      online={online}
      renderLive={(onState) => (
        <HLSPlayer
          aiOverlay={false}
          className="h-full w-full"
          controls={false}
          digitalZoom={false}
          monitorId={monitorId}
          onState={onState}
          protocolBadge={false}
          qualityControl={false}
        />
      )}
    />
  );
}
