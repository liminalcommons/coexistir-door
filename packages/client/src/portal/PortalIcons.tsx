/**
 * PortalIcons — the dock's glyphs, and nothing else.
 *
 * Owner's lock: STANDARD phone-style mic and camera icons. Universally
 * recognizable, no text on the button, no custom abstract marks. These are the
 * shapes iOS/Android put on a call screen, drawn as inline SVG on
 * `currentColor` so the button's state paints the icon too: no sprite, no icon
 * font, no emoji that an Android build would render as a different shape.
 *
 * There is no `stop`, `hand` or `wait` glyph any more, because there is no
 * tap-to-stop and no tap-to-interrupt button: the mic is a TOGGLE (open ear /
 * deaf ear) and the camera is a TOGGLE. `mic-off` and `camera-off` are the same
 * standard silhouettes with the universal slash, which is how every phone says
 * "muted" without a word.
 */
import React from 'react';

export type DockIconName = 'mic' | 'mic-off' | 'camera' | 'camera-off' | 'list' | 'close';

const GLYPHS: Record<DockIconName, React.ReactNode> = {
  mic: (
    <>
      <rect x="9" y="2.75" width="6" height="10.5" rx="3" />
      <path d="M5.6 11.2a6.4 6.4 0 0 0 12.8 0" />
      <path d="M12 17.6V21" />
      <path d="M8.9 21h6.2" />
    </>
  ),
  'mic-off': (
    <>
      <path d="M9 9.2V5.75a3 3 0 0 1 5.85-1" />
      <path d="M15 10.5v.7a3 3 0 0 1-4.4 2.66" />
      <path d="M5.6 11.2a6.4 6.4 0 0 0 8.3 6.05" />
      <path d="M12 17.6V21" />
      <path d="M8.9 21h6.2" />
      <path d="M3.4 3.4 20.6 20.6" />
    </>
  ),
  camera: (
    <>
      <rect x="2.7" y="6.4" width="12.6" height="11.2" rx="2.6" />
      <path d="M15.3 11.4 21 8.5v7l-5.7-2.9z" />
      <circle cx="7.4" cy="10.2" r="1.15" />
    </>
  ),
  'camera-off': (
    <>
      <path d="M5.3 6.4h7.3A2.6 2.6 0 0 1 15.3 9v1.6l5.7-2.9v7l-3.4-1.7" />
      <path d="M15.3 15v.1a2.6 2.6 0 0 1-2.6 2.5H5.3a2.6 2.6 0 0 1-2.6-2.6V9a2.6 2.6 0 0 1 2.6-2.6" />
      <path d="M3.4 3.4 20.6 20.6" />
    </>
  ),
  list: (
    <>
      <path d="M4 6.2h16" />
      <path d="M4 12h16" />
      <path d="M4 17.8h10" />
    </>
  ),
  close: (
    <>
      <path d="M5.2 5.2 18.8 18.8" />
      <path d="M18.8 5.2 5.2 18.8" />
    </>
  ),
};

export const DockIcon: React.FC<{ name: DockIconName }> = ({ name }) => (
  <svg
    className="portal__icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    data-icon={name}
  >
    {GLYPHS[name]}
  </svg>
);

export default DockIcon;
