/**
 * portalKiosk — the front door is not the game.
 *
 * `/portal` is an always-on door screen: HTTP-only, unattended, and pointed at
 * whatever voice rig happens to be behind the tunnel. Anything that boots the
 * game there (Colyseus lobby join, Phaser's WebAudio graph, asset fan-out) is a
 * console error the door cannot explain and does not need.
 */
export function isPortalKioskPath(pathname?: string): boolean {
  const path = pathname ?? (typeof window !== 'undefined' ? window.location.pathname : '');
  return path === '/portal' || path.startsWith('/portal/');
}
