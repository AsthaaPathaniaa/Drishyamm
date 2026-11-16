/**
 * The drawing box takes the shape of the camera's picture.
 *
 * Zones are stored as 0..1 fractions of the box they were drawn in, and the AI
 * services multiply them by their own frame's width and height. That is only
 * right when the box IS the picture. The box used to be fixed at 16:9 with the
 * picture contained inside it, so on a 4:3 camera the picture was pillarboxed
 * and every stored point was measured against the black bars as well: a zone
 * drawn over a doorway landed beside it in the head-count frame.
 *
 * The media inside a canvas reports its natural shape here (the still's
 * naturalWidth/Height, the video's videoWidth/Height, else the camera's
 * stored width/height), and the canvas sizes its box from it. How zones are
 * stored does not change.
 */
import { createContext, useCallback, useState } from 'react';

/** A canvas's setter for its media's width / height. */
export const MediaAspectContext = createContext(null);

/** Every editor's box before 2026-11-11. */
export const LEGACY_ASPECT = 16 / 9;

export function ratioOf(width, height) {
  const w = Number(width);
  const h = Number(height);
  return w > 0 && h > 0 ? w / h : null;
}

/** `[aspect, setAspect]` that ignores sub-pixel jitter; `setAspect(null)` resets. */
export function useMediaAspect() {
  const [aspect, setAspectRaw] = useState(null);
  const setAspect = useCallback((next) => {
    setAspectRaw((prev) => (next && prev && Math.abs(next - prev) < 0.005 ? prev : next || null));
  }, []);
  return [aspect, setAspect];
}

const COMMON = [[16, 9], [4, 3], [3, 2], [5, 4], [1, 1], [9, 16], [3, 4]];
function label(aspect) {
  const hit = COMMON.find(([w, h]) => Math.abs(aspect - w / h) < 0.02);
  return hit ? `${hit[0]}:${hit[1]}` : `${aspect.toFixed(2)}:1`;
}

const noted = new Set();

/**
 * Zones already saved on a camera whose picture is not 16:9 were drawn on the
 * old letterboxed box and sit off target in the AI's frame. They are not
 * rewritten behind anyone's back; this lists them once per session so they can
 * be opened and re-saved.
 * @param {number|null} aspect  the picture's width / height
 * @param {{ camera: string, zones: string[] }} what  names of the saved shapes
 */
export function noteLegacyZones(aspect, { camera, zones }) {
  if (!aspect || !zones?.length || Math.abs(aspect - LEGACY_ASPECT) < 0.02) return;
  const key = `${camera}|${zones.join('|')}`;
  if (noted.has(key)) return;
  noted.add(key);
  console.warn(
    `[zones] ${camera} has a ${label(aspect)} picture. Shapes saved on it before 2026-11-11 were drawn on a `
    + `16:9 box and are offset in the AI's frame. Open and re-save: ${zones.join(', ')}.`,
  );
}

/** Box sizing: the picture's shape, never taller than `maxVh` of the screen. */
export function boxStyle(aspect, fallback, maxVh = 70) {
  const ratio = aspect || fallback;
  return {
    aspectRatio: String(ratio),
    maxWidth: typeof ratio === 'number' ? `min(100%, calc(${maxVh}vh * ${ratio.toFixed(4)}))` : undefined,
  };
}
