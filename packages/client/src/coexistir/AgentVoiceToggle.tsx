/**
 * AgentVoiceToggle — audible agent replies in the Coexistir meeting room.
 *
 * A small, self-contained control (no chat UI): it flips the reply playback
 * preference (persisted, default ON), shows which voice/language will speak,
 * and plays one real agent reply through the same server path the conversation
 * uses so the room can be checked by ear at any time.
 *
 * Inspectable state for tests/e2e: `data-voice-enabled`, `data-voice-phase`,
 * `data-voice-language`, `data-voice-model` on the root element.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  agentVoice,
  installAgentReplyBridge,
  COEXISTIR_AGENT_ID,
  type AgentVoiceState,
} from './agentVoice';
import { installBargeIn } from './bargeIn';

/** A real reply the front-door manager gives on a morning check-in. */
export const SAMPLE_REPLY_PT =
  'Bom dia! Sou a Mariana, sua assistente de casa. Hoje você tem três tarefas e uma reflexão para o jantar: o que te trouxe até aqui hoje?';

export const SAMPLE_REPLY_EN =
  'Good morning! This is your front-door assistant. You have three tasks today, and one question for dinner: what brought you here today?';

const LANGUAGE_LABEL: Record<string, string> = {
  'pt-BR': 'Portuguese (BR)',
  'pt': 'Portuguese',
  'en': 'English',
  'en-US': 'English (US)',
};

function languageLabel(tag: string | null | undefined): string {
  if (!tag) return 'unknown language';
  return LANGUAGE_LABEL[tag] || tag;
}

function phaseLabel(state: AgentVoiceState): string {
  switch (state.phase) {
    case 'loading':
      return 'Preparing…';
    case 'speaking':
      return 'Speaking…';
    case 'blocked':
      return 'Tap to allow audio';
    case 'unsupported':
      return 'No voice for this language';
    case 'error':
      return state.lastError ? `Voice error: ${state.lastError}` : 'Voice error';
    case 'disabled':
      return 'Muted';
    default:
      return 'Ready';
  }
}

export const AgentVoiceToggle: React.FC<{ agentId?: string }> = ({ agentId = COEXISTIR_AGENT_ID }) => {
  const [state, setState] = useState<AgentVoiceState>(agentVoice.snapshot);
  const [bargeListening, setBargeListening] = useState(false);

  useEffect(() => agentVoice.subscribe(setState), []);

  // Announce-a-reply seam: any surface can dispatch the event instead of
  // importing the controller.
  useEffect(() => installAgentReplyBridge(agentVoice), []);

  // The room speaks progressively (first chunk audible, barge-in possible) and
  // listens for the member talking over the agent.
  useEffect(() => {
    agentVoice.setTransport?.('stream');
    const handle = installBargeIn({
      isSpeaking: () => (agentVoice.isSpeaking ? agentVoice.isSpeaking() : false),
      onBargeIn: (reason) => {
        (globalThis as unknown as { __CASTALIA_BARGE__?: unknown[] }).__CASTALIA_BARGE__ =
          ((globalThis as unknown as { __CASTALIA_BARGE__?: unknown[] }).__CASTALIA_BARGE__ || []).concat({
            reason,
            at: typeof performance !== 'undefined' ? performance.now() : Date.now(),
          });
        agentVoice.stop?.(reason === 'vad' ? 'vad' : 'simulated-barge');
      },
    });
    // Verification hook: the rig drives the exact VAD path headlessly via
    // `__CASTALIA_BARGE_HANDLE__.simulateSpeech()` (labelled 'simulated').
    (globalThis as unknown as { __CASTALIA_BARGE_HANDLE__?: unknown }).__CASTALIA_BARGE_HANDLE__ = handle;
    void handle.start().then((listening) => setBargeListening(listening));
    return () => {
      (globalThis as unknown as { __CASTALIA_BARGE_HANDLE__?: unknown }).__CASTALIA_BARGE_HANDLE__ = undefined;
      handle.stop();
    };
  }, []);

  useEffect(() => {
    void agentVoice.loadProfile(agentId);
  }, [agentId]);

  const toggle = useCallback(() => {
    agentVoice.setEnabled(!agentVoice.isEnabled());
  }, []);

  const speakSample = useCallback((language: string) => {
    const text = language === 'en' ? SAMPLE_REPLY_EN : SAMPLE_REPLY_PT;
    void agentVoice.speak(text, { agentId, language });
  }, [agentId]);

  const voiceLine = useMemo(() => {
    const profile = state.profile;
    if (!profile) return 'Voice…';
    const variant = profile.languageVoices?.find((v) => v.language === profile.language);
    const name = profile.voiceName || profile.voiceId || 'voice';
    const model = variant?.modelId || profile.modelId;
    return `${name} · ${languageLabel(profile.language)}${model ? ` · ${model}` : ''}`;
  }, [state.profile]);

  const isOn = state.enabled;

  return (
    <div
      data-testid="agent-voice-toggle"
      data-voice-enabled={isOn ? 'true' : 'false'}
      data-voice-phase={state.phase}
      data-voice-language={state.lastLanguage || state.profile?.language || ''}
      data-voice-model={state.profile?.modelId || ''}
      data-voice-transport={agentVoice.getTransport ? agentVoice.getTransport() : 'stream'}
      data-voice-barge={bargeListening ? 'listening' : 'off'}
      style={{
        position: 'fixed',
        right: 16,
        bottom: 96,
        zIndex: 9000,
        minWidth: 236,
        padding: '10px 12px',
        borderRadius: 12,
        background: 'color-mix(in srgb, var(--theme-bg-dark, #1a1a2e) 92%, transparent)',
        border: `1px solid ${isOn ? 'color-mix(in srgb, var(--theme-primary, #c9a227) 45%, transparent)' : 'rgba(255,255,255,0.16)'}`,
        boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
        color: 'var(--theme-text-primary, #e8e2d6)',
        fontFamily: 'inherit',
        fontSize: '0.78rem',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span aria-hidden="true">{isOn ? '🔊' : '🔇'}</span>
        <span style={{ flex: 1, letterSpacing: '0.01em' }}>Agent voice</span>
        <button
          type="button"
          role="switch"
          aria-checked={isOn}
          aria-label={isOn ? 'Turn agent voice off' : 'Turn agent voice on'}
          onClick={toggle}
          data-testid="agent-voice-switch"
          style={{
            cursor: 'pointer',
            border: 'none',
            borderRadius: 999,
            padding: '3px 10px',
            fontSize: '0.72rem',
            fontWeight: 600,
            letterSpacing: '0.04em',
            color: isOn ? '#101014' : 'var(--theme-text-primary, #e8e2d6)',
            background: isOn ? 'var(--theme-primary, #c9a227)' : 'rgba(255,255,255,0.12)',
          }}
        >
          {isOn ? 'ON' : 'OFF'}
        </button>
      </div>

      <div style={{ opacity: 0.75, fontSize: '0.7rem' }}>{voiceLine}</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button
          type="button"
          onClick={() => speakSample('pt-BR')}
          disabled={!isOn}
          data-testid="agent-voice-sample-pt"
          style={{
            cursor: isOn ? 'pointer' : 'not-allowed',
            opacity: isOn ? 1 : 0.45,
            border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a227) 40%, transparent)',
            borderRadius: 8,
            background: 'transparent',
            color: 'inherit',
            padding: '3px 8px',
            fontSize: '0.7rem',
          }}
        >
          ▶ Hear reply
        </button>
        <button
          type="button"
          onClick={() => speakSample('en')}
          disabled={!isOn}
          data-testid="agent-voice-sample-en"
          style={{
            cursor: isOn ? 'pointer' : 'not-allowed',
            opacity: isOn ? 1 : 0.45,
            border: '1px solid rgba(255,255,255,0.18)',
            borderRadius: 8,
            background: 'transparent',
            color: 'inherit',
            padding: '3px 8px',
            fontSize: '0.7rem',
          }}
        >
          EN
        </button>
        <button
          type="button"
          onClick={() => agentVoice.stop?.('stop-control')}
          disabled={state.phase !== 'speaking'}
          data-testid="agent-voice-stop"
          title="Stop the agent mid-sentence (barge-in)"
          style={{
            cursor: state.phase === 'speaking' ? 'pointer' : 'not-allowed',
            opacity: state.phase === 'speaking' ? 1 : 0.4,
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: 8,
            background: 'transparent',
            color: 'inherit',
            padding: '3px 8px',
            fontSize: '0.7rem',
          }}
        >
          ■ Stop
        </button>
        <span
          data-testid="agent-voice-status"
          style={{ marginLeft: 'auto', fontSize: '0.68rem', opacity: 0.8 }}
        >
          {phaseLabel(state)}
        </span>
      </div>
    </div>
  );
};

export default AgentVoiceToggle;
