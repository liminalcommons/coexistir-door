/**
 * Tests for PIN/FOCUS: pinUtils (pure identity logic) + PinnedTileOverlay
 * (render, click-tile/X/Esc unpin paths, claim chip).
 *
 * Strategy mirrors ParticipantActionSheet.test.tsx: virtual-mock the
 * meeting-views lib + stub livekit-client so no real LiveKit is needed.
 */

jest.mock('@liminal/meeting-views', () => ({
  ParticipantTile: ({ participant }: any) => (
    <div data-testid="stub-participant-tile">{participant?.identity}</div>
  ),
}), { virtual: true });

jest.mock('livekit-client', () => ({
  LocalParticipant: class {},
  RemoteParticipant: class {},
  Participant: class {},
  Track: { Source: { Microphone: 'mic', Camera: 'cam' } },
}));

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { togglePinnedIdentity, resolvePinnedIdentity, isPinnedParticipantGone } from '../pinUtils';
import { PinnedTileOverlay } from '../PinnedTileOverlay';

// ── pinUtils ────────────────────────────────────────────────────────────────

describe('pinUtils', () => {
  const roster = [{ identity: 'zoe' }, { identity: 'owl' }, { identity: 'guest-1' }];

  it('togglePinnedIdentity pins when nothing is pinned', () => {
    expect(togglePinnedIdentity(null, 'zoe')).toBe('zoe');
  });

  it('togglePinnedIdentity unpins when clicking the pinned tile again', () => {
    expect(togglePinnedIdentity('zoe', 'zoe')).toBeNull();
  });

  it('togglePinnedIdentity switches to a different participant', () => {
    expect(togglePinnedIdentity('zoe', 'owl')).toBe('owl');
  });

  it('resolvePinnedIdentity follows the participant across a reordered list', () => {
    const reordered = [roster[2], roster[0], roster[1]];
    expect(resolvePinnedIdentity(reordered, 'zoe')).toBe(roster[0]);
  });

  it('resolvePinnedIdentity returns null when the participant left', () => {
    expect(resolvePinnedIdentity([{ identity: 'owl' }], 'zoe')).toBeNull();
    expect(resolvePinnedIdentity(roster, null)).toBeNull();
  });

  it('isPinnedParticipantGone detects departure only when something is pinned', () => {
    expect(isPinnedParticipantGone(roster, 'zoe')).toBe(false);
    expect(isPinnedParticipantGone([{ identity: 'owl' }], 'zoe')).toBe(true);
    expect(isPinnedParticipantGone([], null)).toBe(false);
  });
});

// ── PinnedTileOverlay ───────────────────────────────────────────────────────

function stubParticipant(identity = 'zoe', name = 'Zoe') {
  return { identity, name, sid: `lk-${identity}`, isSpeaking: false } as any;
}

describe('PinnedTileOverlay', () => {
  it('renders the participant name and video', () => {
    render(<PinnedTileOverlay participant={stubParticipant()} displayName="Zoe" onUnpin={() => {}} />);
    expect(screen.getByTestId('pinned-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('pinned-name')).toHaveTextContent('Zoe');
    expect(screen.getByTestId('stub-participant-tile')).toHaveTextContent('zoe');
    // Dialog semantics cooperate with the Esc-to-map guard in the parent.
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });

  it('clicking the enlarged tile unpins', () => {
    const onUnpin = jest.fn();
    render(<PinnedTileOverlay participant={stubParticipant()} displayName="Zoe" onUnpin={onUnpin} />);
    fireEvent.click(screen.getByTestId('pinned-video'));
    expect(onUnpin).toHaveBeenCalledTimes(1);
  });

  it('✕ button unpins', () => {
    const onUnpin = jest.fn();
    render(<PinnedTileOverlay participant={stubParticipant()} displayName="Zoe" onUnpin={onUnpin} />);
    fireEvent.click(screen.getByTestId('pinned-unpin-btn'));
    expect(onUnpin).toHaveBeenCalledTimes(1);
  });

  it('Esc unpins and prevents default (so the parent Esc-to-map guard skips)', () => {
    const onUnpin = jest.fn();
    render(<PinnedTileOverlay participant={stubParticipant()} displayName="Zoe" onUnpin={onUnpin} />);
    const prevented: boolean[] = [];
    const evt = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    const origPrevent = evt.preventDefault.bind(evt);
    (evt as any).preventDefault = () => { prevented.push(true); return origPrevent(); };
    window.dispatchEvent(evt);
    expect(onUnpin).toHaveBeenCalledTimes(1);
    expect(prevented).toEqual([true]);
  });

  it('non-Escape keys do not unpin', () => {
    const onUnpin = jest.fn();
    render(<PinnedTileOverlay participant={stubParticipant()} displayName="Zoe" onUnpin={onUnpin} />);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onUnpin).not.toHaveBeenCalled();
  });

  it('shows the claimed name with an unverified marker until verified', () => {
    render(
      <PinnedTileOverlay
        participant={stubParticipant('guest-1', '')}
        displayName="guest-1"
        claimChip={{ name: 'Zoe', verified: false }}
        onUnpin={() => {}}
      />,
    );
    expect(screen.getByTestId('pinned-claim-chip')).toHaveTextContent('Zoe (unverified)');
  });

  it('verified claims lose the unverified marker', () => {
    render(
      <PinnedTileOverlay
        participant={stubParticipant('guest-1', '')}
        displayName="guest-1"
        claimChip={{ name: 'Zoe', verified: true }}
        onUnpin={() => {}}
      />,
    );
    const chip = screen.getByTestId('pinned-claim-chip');
    expect(chip).toHaveTextContent('Zoe');
    expect(chip.textContent).not.toMatch(/unverified/);
  });

  it('claim chip shows the voice fingerprint before the claimed name', () => {
    render(
      <PinnedTileOverlay
        participant={stubParticipant('guest-1', '')}
        displayName="guest-1"
        claimChip={{ name: 'Zoe', verified: false, fingerprint: '7e12e3' }}
        onUnpin={jest.fn()}
      />,
    );
    const chip = screen.getByTestId('pinned-claim-chip');
    expect(chip).toHaveTextContent('◍ #7e12e3');
    expect(chip).toHaveTextContent('Zoe (unverified)');
  });

  it('unclaimed stranger fingerprint renders its own unverified chip', () => {
    render(
      <PinnedTileOverlay
        participant={stubParticipant('guest-1', '')}
        displayName="guest-1"
        unclaimedFingerprint="7e12e3"
        onUnpin={jest.fn()}
      />,
    );
    const chip = screen.getByTestId('pinned-fingerprint-chip');
    expect(chip).toHaveTextContent('◍ #7e12e3');
    expect(chip).toHaveTextContent('unverified');
    expect(screen.queryByTestId('pinned-claim-chip')).toBeNull();
  });

  it('hides the unclaimed fingerprint once a claim exists', () => {
    render(
      <PinnedTileOverlay
        participant={stubParticipant('guest-1', '')}
        displayName="guest-1"
        claimChip={{ name: 'Zoe', verified: true }}
        unclaimedFingerprint="7e12e3"
        onUnpin={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('pinned-fingerprint-chip')).toBeNull();
    expect(screen.getByTestId('pinned-claim-chip')).toHaveTextContent('Zoe');
  });
});
