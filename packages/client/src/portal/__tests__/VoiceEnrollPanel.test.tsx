/**
 * VoiceEnrollPanel.test.tsx — the supervised binding, without a microphone.
 *
 * fetch is stubbed per step; the synthetic WAV math is real (same synthesis
 * the server's fixtures use), so the posted bodies are genuine audio Blobs.
 * What must hold:
 * - the form cannot start without a name AND a supervisor;
 * - three synthetic takes + finish bind `person:<name>` (verified/enrollment);
 * - the owner's re-speak matches; a stranger's clip does not — no voice,
 *   no name.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VoiceEnrollPanel } from '../VoiceEnrollPanel';

function mockFetchOnce(body: unknown, status = 200): void {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 || status === 201 ? 'OK' : 'Error',
    json: async () => body,
  });
}

const SESSION = (takes: number) => ({
  ok: true,
  enrollmentId: 'enr_test_1',
  voiceKey: 'person:test owner',
  name: 'Test Owner',
  supervisedBy: 'supervisor',
  prompt: { text: 'A casa está em ordem', lang: 'pt' },
  needClips: 3,
  clips: Array.from({ length: takes }, (_, i) => ({
    take: i + 1,
    dims: 52,
    durationSec: 2.4,
    voicedSec: 1.8,
    f0Hz: 112,
    at: new Date().toISOString(),
  })),
  consistency: takes >= 2 ? 0.96 : null,
});

const BINDING = {
  ok: true,
  printId: 'vp_test123',
  voiceKey: 'person:test owner',
  name: 'Test Owner',
  status: 'verified',
  verifyReason: 'enrollment',
  verifiedBy: 'supervisor',
  clips: 3,
  consistency: 0.96,
  threshold: 0.82,
  enrolledAt: new Date().toISOString(),
};

beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('VoiceEnrollPanel', () => {
  it('needs a name and a supervisor before it starts', () => {
    render(<VoiceEnrollPanel language="pt" debug testId="enroll" />);
    expect(screen.getByTestId('enroll-start')).toBeDisabled();
    fireEvent.change(screen.getByTestId('enroll-name'), { target: { value: 'Test Owner' } });
    expect(screen.getByTestId('enroll-start')).toBeDisabled();
    fireEvent.change(screen.getByTestId('enroll-supervisor'), { target: { value: 'supervisor' } });
    expect(screen.getByTestId('enroll-start')).not.toBeDisabled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('binds by voice and proves owner-match vs stranger-no-match', async () => {
    render(<VoiceEnrollPanel language="pt" debug testId="enroll" />);
    fireEvent.change(screen.getByTestId('enroll-name'), { target: { value: 'Test Owner' } });
    fireEvent.change(screen.getByTestId('enroll-supervisor'), { target: { value: 'supervisor' } });

    mockFetchOnce(SESSION(0), 201);
    fireEvent.click(screen.getByTestId('enroll-start'));
    await waitFor(() => expect(screen.getByTestId('enroll-session')).toBeInTheDocument());
    expect(screen.getByTestId('enroll-prompt')).toHaveTextContent('person:test owner');

    for (let take = 1; take <= 3; take += 1) {
      mockFetchOnce({ ...SESSION(take), take, voicedSec: 1.8, durationSec: 2.4, f0Hz: 112 }, 201);
      fireEvent.click(screen.getByTestId('enroll-synth'));
      await waitFor(() =>
        expect(screen.getByTestId('enroll-takes')).toHaveTextContent(`${take}/3`),
      );
    }

    mockFetchOnce(BINDING, 201);
    fireEvent.click(screen.getByTestId('enroll-finish'));
    await waitFor(() => expect(screen.getByTestId('enroll-binding')).toBeInTheDocument());
    expect(screen.getByTestId('enroll-bound')).toHaveTextContent('Test Owner');
    expect(screen.getByTestId('enroll-bound')).toHaveTextContent('vp_test123');

    mockFetchOnce(
      { ok: true, match: true, similarity: 0.96, threshold: 0.82, voiceKey: 'person:test owner', printId: 'vp_test123', voicedSec: 1.8 },
      200,
    );
    fireEvent.click(screen.getByTestId('enroll-verify-synth'));
    await waitFor(() => expect(screen.getByTestId('enroll-verify-result')).toBeInTheDocument());
    expect(screen.getByTestId('enroll-verify-result')).toHaveAttribute('data-match', '1');

    mockFetchOnce(
      { ok: true, match: false, similarity: 0.12, threshold: 0.82, voiceKey: 'person:test owner', printId: 'vp_test123', voicedSec: 1.8 },
      200,
    );
    fireEvent.click(screen.getByTestId('enroll-verify-stranger'));
    await waitFor(() => expect(screen.getByTestId('enroll-stranger-result')).toBeInTheDocument());
    expect(screen.getByTestId('enroll-stranger-result')).toHaveAttribute('data-match', '0');

    // Every clip post carried a real WAV body.
    const clipCalls = (global.fetch as jest.Mock).mock.calls.filter(([url]) =>
      String(url).includes('/id/enroll/clip'),
    );
    expect(clipCalls).toHaveLength(3);
    for (const [, options] of clipCalls) {
      const body = (options as { body: Blob }).body;
      expect(body).toBeInstanceOf(Blob);
      expect(body.type).toBe('audio/wav');
      expect(body.size).toBeGreaterThan(44);
    }
  });

  it('shows the server refusal instead of binding', async () => {
    render(<VoiceEnrollPanel language="pt" debug testId="enroll" />);
    fireEvent.change(screen.getByTestId('enroll-name'), { target: { value: 'Mixed' } });
    fireEvent.change(screen.getByTestId('enroll-supervisor'), { target: { value: 'supervisor' } });
    mockFetchOnce(SESSION(0), 201);
    fireEvent.click(screen.getByTestId('enroll-start'));
    await waitFor(() => expect(screen.getByTestId('enroll-session')).toBeInTheDocument());

    mockFetchOnce({ error: 'inconsistent_voice', detail: 'clips disagree' }, 422);
    fireEvent.click(screen.getByTestId('enroll-synth'));
    await waitFor(() => expect(screen.getByTestId('enroll-error')).toBeInTheDocument());
    expect(screen.getByTestId('enroll-error')).toHaveTextContent('inconsistent_voice');
    expect(screen.queryByTestId('enroll-binding')).not.toBeInTheDocument();
  });
});
