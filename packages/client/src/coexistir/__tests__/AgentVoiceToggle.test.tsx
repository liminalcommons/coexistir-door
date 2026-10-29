/**
 * AgentVoiceToggle.test.tsx — the playback toggle the room actually sees.
 *
 * Pins the UX contract: ON by default, the switch flips the persisted
 * preference, the control shows which voice/language speaks, and the "Hear
 * reply" affordance goes through the same speak() path a conversation uses.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const speak = jest.fn(async () => ({ spoken: true, phase: 'speaking' as const }));
const setEnabled = jest.fn();
const setTransport = jest.fn();
const stop = jest.fn();
const isSpeaking = jest.fn(() => false);
const loadProfile = jest.fn(async () => null);
const subscribe = jest.fn(() => () => undefined);
const installBridge = jest.fn(() => () => undefined);
let snapshot: any;

jest.mock('../agentVoice', () => ({
  COEXISTIR_AGENT_ID: 'coexistir-manager',
  AGENT_REPLY_EVENT: 'castalia:agent-reply',
  agentVoice: {
    get snapshot() {
      return snapshot;
    },
    subscribe: (...args: any[]) => (subscribe as any)(...args),
    setEnabled: (...args: any[]) => (setEnabled as any)(...args),
    isEnabled: () => snapshot.enabled,
    speak: (...args: any[]) => (speak as any)(...args),
    loadProfile: (...args: any[]) => (loadProfile as any)(...args),
    setTransport: (...args: any[]) => (setTransport as any)(...args),
    getTransport: () => 'stream',
    isSpeaking: () => isSpeaking(),
    stop: (...args: any[]) => (stop as any)(...args),
  },
  installAgentReplyBridge: (...args: any[]) => (installBridge as any)(...args),
}));

import { AgentVoiceToggle, SAMPLE_REPLY_PT } from '../AgentVoiceToggle';

const profile = {
  enabled: true,
  provider: 'deepgram',
  voiceId: 'mariana',
  modelId: 'flux-mariana-pt',
  language: 'pt-BR',
  languages: ['pt-BR', 'en'],
  voiceName: 'Mariana',
  languageVoices: [
    { language: 'pt-BR', provider: 'deepgram', voiceId: 'mariana', modelId: 'flux-mariana-pt' },
  ],
};

function baseState(overrides: Record<string, unknown> = {}) {
  snapshot = {
    enabled: true,
    phase: 'idle',
    profile,
    lastLanguage: null,
    lastModelId: null,
    lastError: null,
    spokenCount: 0,
    ...overrides,
  };
}

describe('AgentVoiceToggle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    baseState();
  });

  it('renders ON with the Mariana voice and model', () => {
    render(<AgentVoiceToggle />);
    const root = screen.getByTestId('agent-voice-toggle');
    expect(root).toHaveAttribute('data-voice-enabled', 'true');
    expect(root).toHaveAttribute('data-voice-phase', 'idle');
    expect(root.getAttribute('data-voice-model')).toBe('flux-mariana-pt');

    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveTextContent('ON');
    expect(screen.getByText(/Mariana · Portuguese \(BR\) · flux-mariana-pt/)).toBeInTheDocument();
  });

  it('flips the preference when switched off', () => {
    render(<AgentVoiceToggle />);
    fireEvent.click(screen.getByRole('switch'));
    expect(setEnabled).toHaveBeenCalledWith(false);
  });

  it('moves the room to progressive playback on mount', () => {
    render(<AgentVoiceToggle />);
    expect(setTransport).toHaveBeenCalledWith('stream');
    expect(screen.getByTestId('agent-voice-toggle')).toHaveAttribute('data-voice-transport', 'stream');
  });

  it('offers a stop control that cuts the agent off', () => {
    baseState({ phase: 'speaking' });
    render(<AgentVoiceToggle />);
    const stopButton = screen.getByTestId('agent-voice-stop');
    expect(stopButton).not.toBeDisabled();
    fireEvent.click(stopButton);
    expect(stop).toHaveBeenCalled();
  });

  it('asks for the coexistir voice profile on mount', () => {
    render(<AgentVoiceToggle />);
    expect(loadProfile).toHaveBeenCalledWith('coexistir-manager');
  });

  it('installs the reply-announcement bridge', () => {
    render(<AgentVoiceToggle />);
    expect(installBridge).toHaveBeenCalled();
  });

  it('plays a sample reply in pt-BR through the conversation speak path', async () => {
    render(<AgentVoiceToggle />);
    fireEvent.click(screen.getByTestId('agent-voice-sample-pt'));
    await waitFor(() => expect(speak).toHaveBeenCalledTimes(1));
    expect(speak).toHaveBeenCalledWith(SAMPLE_REPLY_PT, {
      agentId: 'coexistir-manager',
      language: 'pt-BR',
    });
  });

  it('plays the English sample with language en', async () => {
    render(<AgentVoiceToggle />);
    fireEvent.click(screen.getByTestId('agent-voice-sample-en'));
    await waitFor(() => expect(speak).toHaveBeenCalledWith(expect.any(String), {
      agentId: 'coexistir-manager',
      language: 'en',
    }));
  });

  it('shows the muted state and disables the sample buttons when off', () => {
    baseState({ enabled: false, phase: 'disabled' });
    render(<AgentVoiceToggle />);
    expect(screen.getByTestId('agent-voice-toggle')).toHaveAttribute('data-voice-enabled', 'false');
    expect(screen.getByRole('switch')).toHaveTextContent('OFF');
    expect(screen.getByTestId('agent-voice-sample-pt')).toBeDisabled();
    expect(screen.getByTestId('agent-voice-status')).toHaveTextContent('Muted');
  });

  it('surfaces the speaking state', () => {
    baseState({ phase: 'speaking', lastLanguage: 'pt-BR' });
    render(<AgentVoiceToggle />);
    expect(screen.getByTestId('agent-voice-status')).toHaveTextContent('Speaking…');
    expect(screen.getByTestId('agent-voice-toggle')).toHaveAttribute('data-voice-language', 'pt-BR');
  });

  it('explains when a language has no voice instead of failing silently', () => {
    baseState({ phase: 'unsupported', lastError: 'no voice for fr' });
    render(<AgentVoiceToggle />);
    expect(screen.getByTestId('agent-voice-status')).toHaveTextContent('No voice for this language');
  });

  it('tells the user to tap when autoplay was blocked', () => {
    baseState({ phase: 'blocked' });
    render(<AgentVoiceToggle />);
    expect(screen.getByTestId('agent-voice-status')).toHaveTextContent('Tap to allow audio');
  });
});
