/**
 * Controls that belong to a picture but must sit ABOVE whatever is drawn on it.
 *
 * A drawing canvas puts its media (a player, a still) in an inert layer -- the
 * pointer belongs to the drawing -- and draws its shapes over it. So a button
 * inside the media is unreachable: the player's own Retry could not be clicked.
 * The canvas opens a slot above its drawing layer, and the media renders its
 * badges and buttons through `<MediaChrome>` into it:
 *
 *   const [chromeEl, setChromeEl] = useMediaChromeSlot();
 *   <MediaChromeScope value={chromeEl}>{media}</MediaChromeScope>
 *   ...the drawing...
 *   <MediaChromeSlot slotRef={setChromeEl} />   // last child: above the drawing
 *
 * Outside a canvas there is no slot and the chrome renders in place.
 *
 * The slot is inert too; only controls marked `pointer-events-auto` and
 * spread with `chromeHit` take the pointer, and they keep it from reaching
 * the canvas (React events bubble through a portal to the canvas's handlers).
 */
import { createContext, useState } from 'react';

export const SlotContext = createContext(null);

export const MediaChromeScope = SlotContext.Provider;

/** For a canvas: `[slotEl, setSlotEl]` — see the file comment. */
export const useMediaChromeSlot = () => useState(null);

const stop = (e) => e.stopPropagation();

/**
 * Spread on a control inside MediaChrome so the canvas never sees its pointer.
 * The control's own onClick must call e.stopPropagation() too (ZoneCanvas adds
 * a corner on click).
 */
export const chromeHit = {
  onPointerDown: stop,
  onPointerUp: stop,
  onMouseDown: stop,
  onMouseUp: stop,
  onDoubleClick: stop,
  onKeyDown: stop,
};
