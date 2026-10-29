/**
 * PinnedTileOverlay — near-fullscreen expanded view of one pinned participant.
 *
 * The overlay is layout-independent: the parent resolves the pinned
 * participant by LiveKit identity on every render, so the pinned tile
 * follows the participant across gallery/spotlight/sidebar changes.
 *
 * Unpin paths: click the enlarged tile again, the ✕ button, or Esc.
 * Esc cooperates with CastaliaMeetingView's Esc-to-map guard: this overlay
 * calls preventDefault() (observed by the guard's deferred read) and renders
 * role="dialog" (the guard's second layer), so Esc never exits to the map
 * while a tile is pinned.
 */
import React, { useEffect } from 'react';
import type { Participant } from 'livekit-client';
import { ParticipantTile } from '@liminal/meeting-views';
import type { ParticipantMetadata } from '@liminal/meeting-views';
import './PinnedTileOverlay.css';

export interface PinnedClaimChip {
  name: string;
  verified: boolean;
  /** Short voice-fingerprint hash (voiceFingerprintShortHash) — shown before the name. */
  fingerprint?: string | null;
}

interface PinnedTileOverlayProps {
  participant: Participant;
  displayName: string;
  isLocal?: boolean;
  getMetadata?: (p: Participant) => ParticipantMetadata | null;
  VideoTileTranscriptComponent?: React.ComponentType<{
    participantIdentity: string;
    participantName: string;
  }>;
  /** Unverified/verified claimed name for a stranger tile (name-that-voice). */
  claimChip?: PinnedClaimChip | null;
  /**
   * Voice fingerprint for a stranger tile with no claim yet — renders an
   * `◍ #hash · unverified` chip. Hidden once a claimChip is present.
   */
  unclaimedFingerprint?: string | null;
  /** Open the participant action sheet (⋯) for the pinned participant. */
  onOpenActions?: () => void;
  /** Open the name-this-voice dialog (shown only for stranger tiles). */
  onNameVoice?: () => void;
  onUnpin: () => void;
}

export const PinnedTileOverlay: React.FC<PinnedTileOverlayProps> = ({
  participant,
  displayName,
  isLocal,
  getMetadata,
  VideoTileTranscriptComponent,
  claimChip,
  unclaimedFingerprint,
  onOpenActions,
  onNameVoice,
  onUnpin,
}) => {
  // Esc unpins. preventDefault() is load-bearing: CastaliaMeetingView's
  // Esc-to-map guard defers its read to a microtask, so it observes the
  // default-prevented event and skips the map exit. role="dialog" below is
  // the guard's second layer.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onUnpin();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onUnpin]);

  return (
    <div className="pinned-overlay" data-testid="pinned-overlay">
      <div
        className="pinned-overlay__frame"
        role="dialog"
        aria-modal="true"
        aria-label={`Pinned video of ${displayName}`}
      >
        <div
          className="pinned-overlay__video"
          data-testid="pinned-video"
          onClick={onUnpin}
          title="Click to unpin"
        >
          <ParticipantTile participant={participant} getMetadata={getMetadata} />
          {VideoTileTranscriptComponent && (
            <VideoTileTranscriptComponent
              participantIdentity={participant.identity}
              participantName={displayName}
            />
          )}
        </div>
        <div className="pinned-overlay__bar">
          <span className="pinned-overlay__name" data-testid="pinned-name">
            {displayName}
            {isLocal ? ' (You)' : ''}
          </span>
          {claimChip && (
            <span
              className={`pinned-overlay__claim ${claimChip.verified ? 'pinned-overlay__claim--verified' : 'pinned-overlay__claim--unverified'}`}
              data-testid="pinned-claim-chip"
              title={claimChip.verified ? 'Community-verified name' : 'Claimed name — not yet verified'}
            >
              {claimChip.fingerprint && (
                <span className="pinned-overlay__fingerprint">◍ #{claimChip.fingerprint} </span>
              )}
              {claimChip.name}
              {claimChip.verified ? '' : ' (unverified)'}
            </span>
          )}
          {!claimChip && unclaimedFingerprint && (
            <span
              className="pinned-overlay__claim pinned-overlay__claim--unverified"
              data-testid="pinned-fingerprint-chip"
              title={`Voice fingerprint #${unclaimedFingerprint} — no name claimed yet`}
            >
              <span className="pinned-overlay__fingerprint">◍ #{unclaimedFingerprint}</span>
              {' · unverified'}
            </span>
          )}
          {onNameVoice && (
            <button
              className="pinned-overlay__btn"
              data-testid="pinned-name-voice-btn"
              onClick={onNameVoice}
              title="Suggest a name for this voice (filed as a claim, not a rename)"
            >
              🏷️ Name this voice
            </button>
          )}
          <span className="pinned-overlay__spacer" />
          {onOpenActions && (
            <button
              className="pinned-overlay__btn pinned-overlay__btn--icon"
              data-testid="pinned-actions-btn"
              onClick={onOpenActions}
              aria-label={`More actions for ${displayName}`}
              title="More actions"
            >
              ⋯
            </button>
          )}
          <button
            className="pinned-overlay__btn pinned-overlay__btn--icon"
            data-testid="pinned-unpin-btn"
            onClick={onUnpin}
            aria-label={`Unpin ${displayName}`}
            title="Unpin (Esc)"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
};

export default PinnedTileOverlay;
