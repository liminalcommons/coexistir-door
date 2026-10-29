/**
 * NameThisVoiceDialog — file a NAME CLAIM for a stranger tile.
 *
 * Copy is deliberate: this files a *claim* attached to a voice, it is NOT
 * a rename. Unverified claims render with an 'unverified' marker everywhere
 * until the Bridge-lite rule verifies them (repeat match or villager/steward
 * confirm).
 */
import React, { useState } from 'react';
import { fileVoiceNameClaim } from './voiceNameClaimsApi';
import { useVoiceNameClaims, invalidateVoiceClaims } from './useVoiceNameClaims';
import type { VoiceNameClaimView } from './voiceIdentityUtils';
import './NameThisVoiceDialog.css';

interface NameThisVoiceDialogProps {
  voiceKey: string;
  livekitIdentity: string;
  claimByDefault?: string;
  onClose: () => void;
  onFiled?: (claim: VoiceNameClaimView) => void;
}

export const NameThisVoiceDialog: React.FC<NameThisVoiceDialogProps> = ({
  voiceKey,
  livekitIdentity,
  claimByDefault,
  onClose,
  onFiled,
}) => {
  const { claims, loading, error, refresh } = useVoiceNameClaims(voiceKey);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [justFiled, setJustFiled] = useState<VoiceNameClaimView | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const claim = await fileVoiceNameClaim({
        voiceKey,
        claimedName: trimmed,
        claimBy: claimByDefault || undefined,
        livekitIdentity,
      });
      setJustFiled(claim);
      setName('');
      await refresh();
      // Tile chips use their own hook instance for this voiceKey; wake them so
      // the unverified chip appears without a remount.
      invalidateVoiceClaims(voiceKey);
      onFiled?.(claim);
    } catch (err) {
      setSubmitError((err as Error)?.message || 'Could not file the claim');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="name-voice__backdrop" data-testid="name-voice-dialog" onClick={onClose}>
      <div
        className="name-voice__panel"
        role="dialog"
        aria-modal="true"
        aria-label="Suggest a name for this voice"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="name-voice__head">
          <span className="name-voice__title">🏷️ Name this voice</span>
          <button className="name-voice__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <p className="name-voice__note">
          This files a <strong>name claim</strong> attached to this voice — not a rename.
          It shows as <em>unverified</em> until a second person claims the same name
          or a villager/steward confirms it.
        </p>

        <form className="name-voice__form" onSubmit={handleSubmit}>
          <input
            className="name-voice__input"
            data-testid="name-voice-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Zoe"
            maxLength={40}
            aria-label="Claimed name"
            autoFocus
          />
          <button
            className="name-voice__submit"
            data-testid="name-voice-submit"
            type="submit"
            disabled={!name.trim() || submitting}
          >
            {submitting ? 'Filing…' : 'File claim'}
          </button>
        </form>
        {submitError && (
          <div className="name-voice__error" data-testid="name-voice-error">
            {submitError}
          </div>
        )}
        {justFiled && (
          <div className="name-voice__filed" data-testid="name-voice-filed">
            Claim filed for “{justFiled.claimedName}”
            {justFiled.status === 'verified' ? ' — verified ✓' : ' (unverified)'}
          </div>
        )}

        <div className="name-voice__claims">
          <span className="name-voice__claims-title">
            {loading ? 'Loading claims…' : `Claims for this voice (${claims.length})`}
          </span>
          {error && <span className="name-voice__error">{error}</span>}
          {claims.map((c, i) => (
            <div
              key={String(c._id ?? i)}
              className="name-voice__claim"
              data-testid="name-voice-claim-row"
            >
              <span className="name-voice__claim-name">“{c.claimedName}”</span>
              <span className="name-voice__claim-by">by {c.claimBy}</span>
              <span
                className={`name-voice__claim-status ${
                  c.status === 'verified'
                    ? 'name-voice__claim-status--verified'
                    : 'name-voice__claim-status--unverified'
                }`}
              >
                {c.status === 'verified' ? 'verified ✓' : 'unverified'}
              </span>
            </div>
          ))}
          {!loading && claims.length === 0 && (
            <span className="name-voice__empty">No claims yet — yours could be the first.</span>
          )}
        </div>
      </div>
    </div>
  );
};

export default NameThisVoiceDialog;
