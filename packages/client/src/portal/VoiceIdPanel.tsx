/**
 * VoiceIdPanel — what the door can honestly say about WHO is talking.
 *
 * The panel the owner asked for had a claim pinned above every turn while the
 * turns themselves carried `speaker: null`, an empty "confidence" bar and no
 * per-turn identity. This component renders the facts that exist and names the
 * ones that do not:
 *
 *   speaker     the community NAME claim for this voiceKey (or "no name claim")
 *   voiceKey    the key the door is pinned to, and where it came from
 *   claim       none / unverified / verified, with the quorum counts
 *   voiceprint  the matched enrolled print, or no match — a name is shown
 *               only for a matched voice (speak-to-enroll binds the two)
 *   confidence  unknown until a voice match clears the 0.82 bar
 *   acoustic    measured F0 / centroid / level of the last clip, labelled as a
 *               snapshot (the closest thing to a fingerprint the stack has)
 *   per turn    the identity snapshot stored ON that turn row
 *
 * It also FILES a claim: "name this voice" + a typed name posts to the same
 * `voice_name_claims` endpoint the meeting tiles use, so the panel is not only a
 * readout of the quorum — it is one of the two claimants the quorum counts.
 * Nothing here invents a name, a score or a match. A pending read says
 * "resolving", an error says why, and an absent claim is distinguishable from an
 * unread cache.
 */
import React, { useState } from 'react';
import type { AcousticSnapshot, VoiceClaim, VoiceIdentity, VoiceTurnRow } from './portalApi';
import type { TriggerRecord } from '../live2d/stageTriggers';

export interface VoiceIdPanelProps {
  /** Live identity for the pinned voiceKey (from /voice/identity). */
  identity: VoiceIdentity | null;
  /** The claim rows the panel already polled (fallback when identity is cold). */
  claims: VoiceClaim[];
  /** The newest turn row in this session, with its own identity snapshot. */
  lastTurn: VoiceTurnRow | null;
  /** The last clip's measured acoustics, when one was transcribed. */
  acoustic: AcousticSnapshot | null;
  /** Why the identity read failed, if it did. */
  error?: string;
  /** Language for the two prose hints (the rows themselves are facts). */
  language: 'pt' | 'en';
  /**
   * File a name claim for this voice. Absent = the panel only reads (e.g. a
   * surface with no claim permission). The page owns the call so the three render
   * sites (rail, debug card, drawer) cannot drift from each other.
   */
  onClaim?: (claimedName: string) => Promise<{ status: 'verified' | 'unverified'; name: string }>;
  /** `compact` prints the four decisive rows (portrait card). */
  compact?: boolean;
  testId?: string;
}

const STATE_CLASS: Record<string, string> = {
  verified: 'is-ok',
  unverified: 'is-warn',
  none: 'is-dim',
};

function speakerText(identity: VoiceIdentity | null): { text: string; className: string } {
  if (!identity) return { text: 'unknown — identity not read yet', className: 'is-dim' };
  if (identity.state === 'error') {
    return { text: `unknown — claims store error (${identity.error ?? 'no detail'})`, className: 'is-warn' };
  }
  if (identity.state === 'pending') {
    return { text: 'resolving… (first read, not a "no" yet)', className: 'is-warn' };
  }
  if (identity.name) {
    return {
      text: `${identity.name} · ${identity.claim} claim`,
      className: identity.claim === 'verified' ? 'is-ok' : 'is-warn',
    };
  }
  return { text: 'unknown — no name claim for this voice', className: 'is-dim' };
}

function claimText(identity: VoiceIdentity | null): string {
  if (!identity) return '—';
  if (identity.state !== 'resolved') return identity.state === 'pending' ? 'resolving…' : 'unavailable';
  if (identity.claims === 0) return 'none · 0 rows · quorum 0/2';
  return `${identity.claim} · ${identity.claims} row${identity.claims === 1 ? '' : 's'} · quorum ${Math.min(identity.verified, 2)}/2`;
}

export const VoiceIdPanel: React.FC<VoiceIdPanelProps> = ({
  identity,
  claims,
  lastTurn,
  acoustic,
  error,
  language,
  onClaim,
  compact = false,
  testId = 'portal-voiceid',
}) => {
  const speaker = speakerText(identity);
  const turnIdentity = lastTurn?.identity ?? null;
  const turnSpeaker = turnIdentity
    ? speakerText(turnIdentity).text
    : lastTurn
      ? lastTurn.speaker ?? 'null on this row (recorded before identity)'
      : '— no turn yet';
  const [name, setName] = useState('');
  const [claiming, setClaiming] = useState(false);
  const [result, setResult] = useState<{
    status: 'verified' | 'unverified';
    name: string;
  } | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const inputId = `${testId}-claimname`;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = name.trim();
    if (!value || !onClaim || claiming) return;
    setClaiming(true);
    setClaimError(null);
    try {
      setResult(await onClaim(value));
    } catch (err) {
      setResult(null);
      setClaimError(err instanceof Error ? err.message : String(err));
    } finally {
      setClaiming(false);
    }
  };

  return (
    <section
      className={`portal__voiceid${compact ? ' is-compact' : ''}`}
      data-testid={testId}
      aria-label="Voice identity, live"
    >
      <div className="portal__row">
        <span className="portal__key">speaker</span>
        <span className={`portal__val ${speaker.className}`} data-testid={`${testId}-speaker`}>
          {speaker.text}
        </span>
      </div>
      <div className="portal__row">
        <span className="portal__key">voiceKey</span>
        <span
          className="portal__val is-dim"
          data-testid={`${testId}-voicekey`}
          title={identity?.voiceKey ?? 'pinned kiosk key'}
        >
          {identity?.voiceKey ?? '—'}
          <span className="portal__tag">kiosk pin</span>
        </span>
      </div>
      <div className="portal__row">
        <span className="portal__key">claim</span>
        <span
          className={`portal__val ${STATE_CLASS[identity?.claim ?? 'none'] ?? 'is-dim'}`}
          data-testid={`${testId}-claim`}
        >
          {claimText(identity)}
        </span>
      </div>
      {onClaim && !compact ? (
        <form className="portal__claimform" onSubmit={submit} data-testid={`${testId}-claimform`}>
          <label className="portal__key" htmlFor={inputId}>
            {language === 'pt' ? 'nome desta voz' : 'name this voice'}
          </label>
          <div className="portal__claimrow">
            <input
              id={inputId}
              className="portal__claiminput"
              data-testid={`${testId}-claimname`}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              autoComplete="off"
              spellCheck={false}
              placeholder={language === 'pt' ? 'ex.: Mara' : 'e.g. Mara'}
              aria-label={language === 'pt' ? 'Nome para esta voz' : 'Name for this voice'}
            />
            <button
              className="portal__claimbtn"
              data-testid={`${testId}-claimsubmit`}
              type="submit"
              disabled={claiming || name.trim().length === 0}
            >
              {claiming
                ? language === 'pt'
                  ? 'enviando…'
                  : 'sending…'
                : language === 'pt'
                  ? 'Reivindicar'
                  : 'Claim'}
            </button>
          </div>
          {result ? (
            <p
              className={`portal__claimresult ${result.status === 'verified' ? 'is-ok' : 'is-warn'}`}
              data-testid={`${testId}-claimresult`}
              data-status={result.status}
            >
              {result.status === 'verified'
                ? language === 'pt'
                  ? `verificado · “${result.name}” · quórum completo`
                  : `verified · “${result.name}” · quorum reached`
                : language === 'pt'
                  ? `registrado · “${result.name}” · falta um segundo nome (1/2)`
                  : `filed · “${result.name}” · one more distinct name confirms it (1/2)`}
            </p>
          ) : null}
          {claimError ? (
            <p className="portal__claimresult is-warn" data-testid={`${testId}-claimerror`}>
              {language === 'pt' ? 'não foi possível registrar' : 'could not file the claim'} —{' '}
              {claimError}
            </p>
          ) : null}
        </form>
      ) : null}
      {error ? (
        <div className="portal__row">
          <span className="portal__key">identity</span>
          <span className="portal__val is-warn">unavailable — {error}</span>
        </div>
      ) : null}
      {/* Rail variant: the two long "we do not know" rows collapse into one line
          so the rail keeps room for TRANSCRIPT + EVENTOS without a scroll cliff. */}
      {!compact && (
        <div className="portal__row" data-rail-gaps="true">
          <span className="portal__key">voice id</span>
          <span className="portal__val is-dim">
            voice match only — an unenrolled voice stays unknown
          </span>
        </div>
      )}
      <div className="portal__row" data-gap="true">
        <span className="portal__key">voiceprint</span>
        <span className="portal__val is-dim" data-testid={`${testId}-voiceprint`}>
          matched enrolled print, or no match (speak-to-enroll binds a voice)
        </span>
      </div>
      <div className="portal__row">
        <span className="portal__key">confidence</span>
        <span className="portal__val is-dim" data-testid={`${testId}-confidence`}>
          unknown until a voice match clears 0.82
        </span>
      </div>
      <div className="portal__row">
        <span className="portal__key">clip</span>
        <span className="portal__val" data-testid={`${testId}-acoustic`}>
          {acoustic
            ? `${acoustic.durationSec}s · F0 ${acoustic.f0Hz ?? '—'} Hz · centroid ${acoustic.centroidHz} Hz · ${acoustic.rmsDb} dBFS`
            : '— no clip measured yet'}
          {acoustic ? <span className="portal__tag is-warn">{acoustic.note}</span> : null}
        </span>
      </div>
      {!compact && (
        <div className="portal__row">
          <span className="portal__key">this turn</span>
          <span className="portal__val" data-testid={`${testId}-turn`}>
            {lastTurn
              ? `${lastTurn.turnId} · ${(lastTurn.language || '—').toUpperCase()} · ${turnSpeaker}`
              : '— no turn yet'}
          </span>
        </div>
      )}
      {!compact && claims.length > 0 && (
        <div className="portal__row" data-optional="true">
          <span className="portal__key">claim rows</span>
          <span className="portal__val is-dim" data-testid={`${testId}-claims`}>
            {claims
              .slice(-2)
              .map((c) => `${c.claimedName} (${c.status})`)
              .join(' · ')}
          </span>
        </div>
      )}
      <p className="portal__voicehint">
        {language === 'pt'
          ? 'A identidade é o voiceKey deste quiosque + um nome reivindicado pela comunidade. Um nome só aparece para uma voz cadastrada que combinar — cadastre na aba VOZ.'
          : 'Identity is this kiosk’s voiceKey plus a community name claim. A name shows only for a matched enrolled voice — enroll on the VOZ tab.'}
      </p>
    </section>
  );
};

export interface StageTriggerPanelProps {
  triggers: TriggerRecord[];
  language: 'pt' | 'en';
  limit?: number;
  testId?: string;
}

/**
 * The motion log: one line per state change, the same lines the console carries
 * with `[live2d:trigger]`. `applied=false` is shown in warning colour, because a
 * refused motion is a bug and the panel must not hide it.
 */
export const StageTriggerPanel: React.FC<StageTriggerPanelProps> = ({
  triggers,
  language,
  limit = 10,
  testId = 'portal-triggers',
}) => {
  const rows = triggers.slice(-limit).reverse();
  const fired = Array.from(new Set(triggers.map((t) => t.state)));
  return (
    <section className="portal__triggers" data-testid={testId} aria-label="Live2D motion triggers">
      <header className="portal__triggers-head">
        <span>LIVE2D · {language === 'pt' ? 'GATILHOS' : 'TRIGGERS'}</span>
        <span className={triggers.length > 0 ? 'is-ok' : 'is-dim'}>
          {fired.length} {language === 'pt' ? 'estados' : 'states'} · {triggers.length}{' '}
          {language === 'pt' ? 'linhas' : 'lines'}
        </span>
      </header>
      {rows.length === 0 ? (
        <p className="portal__drawer-empty">
          {language === 'pt' ? 'Nenhum gatilho ainda.' : 'No triggers yet.'}
        </p>
      ) : (
        <ol className="portal__triggerlist">
          {rows.map((row) => (
            <li key={row.seq} className={row.applied ? 'is-applied' : 'is-refused'} data-state={row.state}>
              <span className="portal__triggertime">{clockOf(row.ts)}</span>
              <span className="portal__triggerstate">{row.state}</span>
              <span className="portal__triggermotion">
                {row.motionGroup}[{row.motionIndex}] {row.motionFile.split('/').pop()}
              </span>
              <span className="portal__triggerexpr">{row.expression}</span>
              <span className="portal__triggerwhy">
                {row.why}
                {row.applied ? '' : ' · REFUSED'}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
};

/** Local copy of the clock format (keeps this component dependency-free). */
function clockOf(ts: string): string {
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) return '--:--:--';
  return at.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
