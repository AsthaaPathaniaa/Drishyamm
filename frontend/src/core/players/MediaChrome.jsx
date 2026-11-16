// The two components of the media-chrome slot; see ./media-chrome.js.
import { useContext } from 'react';
import { createPortal } from 'react-dom';
import { SlotContext } from './media-chrome';

/** Where a canvas's media puts its controls: the canvas's last child. */
export function MediaChromeSlot({ slotRef }) {
  return <div className="pointer-events-none absolute inset-0 z-20" ref={slotRef} />;
}

/** The media's badges and buttons, in the canvas's slot when there is one. */
export function MediaChrome({ children }) {
  const el = useContext(SlotContext);
  if (el) return createPortal(children, el);
  return <div className="pointer-events-none absolute inset-0 z-40">{children}</div>;
}
