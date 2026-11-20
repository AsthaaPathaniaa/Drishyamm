/**
 * relayCodecMemo — when does a saved "this camera needs the H.264 sidecar"
 * note still hold?
 *
 * liveRelay remembers, per camera + variant, that this browser could not play
 * the camera's own stream, so the next load asks the server for the H.264
 * sidecar straight away. A note used to be a bare '1' kept forever: a browser
 * that learned H.265 later (driver installed, OS update, hardware decoding
 * switched on) stayed on the slower transcoded stream until someone cleared
 * localStorage by hand. Each note now says WHY it was written, and so when it
 * stops being true:
 *
 *   'device'          the browser reported no H.265 support at all. Holds while
 *                     that is still the case. A legacy '1' means the same.
 *   'mime:<type>'     MediaSource refused this exact stream type although the
 *                     browser supports H.265 in general (an unusual profile or
 *                     level). Holds while MediaSource still refuses that type.
 *   'failed:<ms>'     MediaSource accepted the type but the decoder failed when
 *                     the video started. The browser's own check can't see this
 *                     coming, so the note is time-boxed: after
 *                     DECODER_RETRY_MS the native stream is tried again.
 *
 * Pure (no browser globals) so it runs under `node --test`.
 */

export const DECODER_RETRY_MS = 24 * 60 * 60 * 1000;

export const memoForDevice = () => 'device';
export const memoForMime = (mime) => `mime:${mime}`;
export const memoForDecoderFailure = (now) => `failed:${now}`;

/**
 * @param {string|null} value  the saved note, or null when there is none
 * @param {{ deviceDecodesHevc: boolean, isTypeSupported: (mime: string) => boolean, now: number }} env
 * @returns {boolean} true when the camera should still get the H.264 sidecar
 */
export function memoStillApplies(value, { deviceDecodesHevc, isTypeSupported, now }) {
  if (!value) return false;
  if (value.startsWith('mime:')) return !isTypeSupported(value.slice('mime:'.length));
  if (value.startsWith('failed:')) {
    const at = Number(value.slice('failed:'.length));
    // A note from the future (clock changed) is not trusted.
    return Number.isFinite(at) && now >= at - 60_000 && now - at < DECODER_RETRY_MS;
  }
  return !deviceDecodesHevc; // 'device', or the legacy '1'
}
