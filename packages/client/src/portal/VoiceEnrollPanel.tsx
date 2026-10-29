/**
 * VoiceEnrollPanel — speak-to-enroll: bind a name to a VOICE, by voice.
 *
 * A typed name on the kiosk key is a rumour (`VoiceIdPanel` shows it as an
 * unverified claim, never an identity). This panel is the voice half that
 * turns the rumour into a recognition:
 *
 *   1. the supervisor types WHO (`name`) and who watched (`supervisedBy`),
 *   2. the owner speaks the prompted phrase 2–3 times (mic, or the synthetic
 *      check behind `?debug=1` — same WAV math as the server's fixtures),
 *   3. finish averages the prints and binds them under `person:<name>`,
 *   4. re-speak verifies: a fresh clip must clear the 0.82 identity bar, and
 *      a stranger's clip must NOT — no voice match, no name.
 *
 * Enrollment clips never enter the ear/turn path: they cannot lend a voice
 * to anyone's question. Sessions are server-side, TTL'd, single-voice.
 */
import React, { useCallback, useRef, useState } from 'react';
import { encodeWav } from './portalVad';
import {
  finishEnrollment,
  postEnrollClip,
  startEnrollment,
  verifyEnrollment,
  type EnrollBinding,
  type EnrollSession,
  type EnrollVerification,
} from './portalApi';

export interface VoiceEnrollPanelProps {
  language: 'pt' | 'en';
  /** `?debug=1`: show the synthetic-voice check (no mic needed). */
  debug?: boolean;
  /** The door refreshes its identity read after a binding lands. */
  onBound?: () => void;
  testId?: string;
}

/** Fixed capture window: long enough to clear the 0.28 s voiced gate. */
const CAPTURE_MS = 2800;

// --- synthetic voices (debug check only) ------------------------------------
// Same math as the server's `wavFixture`: voice A (low pitch, long tract —
// the "owner") vs voice B (higher pitch, shorter tract — the "stranger").
// Two clips of A must match ~0.96; A vs B must sit ~0.12, far from 0.82.

interface SynthSpec {
  f0: number;
  formants: [number, number, number];
  durationSec: number;
  sampleRate: number;
  seed: number;
}

const SYNTH_OWNER_A: SynthSpec = { f0: 112, formants: [720, 1240, 2560], durationSec: 2.4, sampleRate: 16000, seed: 11 };
const SYNTH_OWNER_B: SynthSpec = { f0: 116, formants: [700, 1260, 2520], durationSec: 3.1, sampleRate: 16000, seed: 97 };
const SYNTH_STRANGER: SynthSpec = { f0: 214, formants: [430, 1980, 3050], durationSec: 2.6, sampleRate: 16000, seed: 23 };

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function synthSamples(spec: SynthSpec): Float32Array {
  const total = Math.round(spec.sampleRate * spec.durationSec);
  const random = mulberry32(spec.seed);
  const samples = new Float32Array(total);
  for (let i = 0; i < total; i += 1) {
    const t = i / spec.sampleRate;
    let sample = 0;
    for (let h = 1; h <= 18; h += 1) {
      const freq = spec.f0 * h;
      if (freq > spec.sampleRate / 2 - 200) break;
      let gain = 0.02;
      for (const formant of spec.formants) {
        const distance = (freq - formant) / 180;
        gain += Math.exp(-distance * distance) / h;
      }
      sample += gain * Math.sin(2 * Math.PI * freq * t + h * 0.3);
    }
    const envelope = 0.55 + 0.45 * Math.sin(2 * Math.PI * 3.4 * t);
    sample = sample * envelope + (random() * 2 - 1) * 0.004;
    samples[i] = Math.max(-0.98, Math.min(0.98, sample * 0.35));
  }
  return samples;
}

function synthWavBlob(spec: SynthSpec): Blob {
  const samples = synthSamples(spec);
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, spec.sampleRate, true);
  view.setUint32(28, spec.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// --- fixed-window mic capture ------------------------------------------------

async function recordWindow(ms: number = CAPTURE_MS): Promise<Blob> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  try {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error('no AudioContext in this browser');
    const ctx = new Ctor();
    try {
      const src = ctx.createMediaStreamSource(stream);
      // ScriptProcessor is legacy but dependency-free and fine for a 3 s
      // supervised capture (no worklet asset to cache-bust on the kiosk).
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const parts: Float32Array[] = [];
      proc.onaudioprocess = (event) => {
        parts.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      src.connect(proc);
      proc.connect(ctx.destination);
      await new Promise((resolve) => setTimeout(resolve, ms));
      src.disconnect();
      proc.disconnect();
      proc.onaudioprocess = null;
      const rate = ctx.sampleRate;
      return encodeWav(parts, rate, 16000);
    } finally {
      await ctx.close().catch(() => undefined);
    }
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

// --- the panel ---------------------------------------------------------------

export const VoiceEnrollPanel: React.FC<VoiceEnrollPanelProps> = ({
  language,
  debug = false,
  onBound,
  testId = 'portal-enroll',
}) => {
  const [name, setName] = useState('');
  const [supervisedBy, setSupervisedBy] = useState('');
  const [session, setSession] = useState<EnrollSession | null>(null);
  const [binding, setBinding] = useState<EnrollBinding | null>(null);
  const [verification, setVerification] = useState<EnrollVerification | null>(null);
  const [stranger, setStranger] = useState<EnrollVerification | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const fail = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
    setBusy(null);
    setCountdown(null);
  }, []);

  const begin = useCallback(async () => {
    if (busy) return;
    setBusy('start');
    setError(null);
    setBinding(null);
    setVerification(null);
    setStranger(null);
    try {
      setSession(await startEnrollment({ name: name.trim(), supervisedBy: supervisedBy.trim() }));
    } catch (err) {
      fail(err);
      return;
    }
    setBusy(null);
  }, [busy, name, supervisedBy, fail]);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    setSession(null);
    setBusy(null);
    setCountdown(null);
    setError(null);
  }, []);

  const capture = useCallback(
    async (blob: Blob) => {
      if (!session || busy) return;
      setBusy('clip');
      setError(null);
      try {
        setSession(await postEnrollClip(session.enrollmentId, blob));
      } catch (err) {
        fail(err);
        return;
      }
      setBusy(null);
    },
    [session, busy, fail],
  );

  const recordTake = useCallback(async () => {
    if (!session || busy) return;
    setBusy('recording');
    setError(null);
    const started = Date.now();
    timerRef.current = window.setInterval(() => {
      const left = Math.max(0, CAPTURE_MS - (Date.now() - started));
      setCountdown(Math.ceil(left / 1000));
      if (left <= 0 && timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }, 200);
    try {
      const blob = await recordWindow(CAPTURE_MS);
      setCountdown(null);
      await capture(blob);
    } catch (err) {
      fail(err);
    }
  }, [session, busy, capture, fail]);

  const synthTake = useCallback(
    async (which: 'a' | 'b') => {
      if (!session || busy) return;
      setBusy('clip');
      setError(null);
      try {
        const taken = session.clips.length;
        const spec = which === 'a' ? (taken === 1 ? SYNTH_OWNER_B : SYNTH_OWNER_A) : SYNTH_OWNER_A;
        setSession(await postEnrollClip(session.enrollmentId, synthWavBlob(spec)));
      } catch (err) {
        fail(err);
        return;
      }
      setBusy(null);
    },
    [session, busy, fail],
  );

  const finish = useCallback(async () => {
    if (!session || busy) return;
    setBusy('finish');
    setError(null);
    try {
      const bound = await finishEnrollment(session.enrollmentId);
      setBinding(bound);
      setSession(null);
      onBound?.();
    } catch (err) {
      fail(err);
      return;
    }
    setBusy(null);
  }, [session, busy, fail, onBound]);

  const verify = useCallback(
    async (blob: Blob, asStranger: boolean) => {
      if (!binding || busy) return;
      setBusy(asStranger ? 'stranger' : 'verify');
      setError(null);
      try {
        const result = await verifyEnrollment(binding.voiceKey, blob);
        if (asStranger) setStranger(result);
        else setVerification(result);
      } catch (err) {
        fail(err);
        return;
      }
      setBusy(null);
    },
    [binding, busy, fail],
  );

  const pt = language === 'pt';
  const takes = session?.clips.length ?? 0;

  return (
    <section className="portal__enroll" data-testid={testId} aria-label={pt ? 'Cadastro de voz' : 'Voice enrollment'}>
      <div className="portal__row">
        <span className="portal__key">enroll</span>
        <span className="portal__val is-dim" data-testid={`${testId}-hint`}>
          {pt
            ? 'fale a frase 2–3x — o nome vira etiqueta de uma voz'
            : 'speak the phrase 2–3x — the name becomes a voice label'}
        </span>
      </div>

      {error ? (
        <p className="portal__claimresult is-warn" data-testid={`${testId}-error`}>
          {error}
        </p>
      ) : null}

      {!session && !binding ? (
        <form
          className="portal__claimform"
          data-testid={`${testId}-form`}
          onSubmit={(event) => {
            event.preventDefault();
            void begin();
          }}
        >
          <div className="portal__claimrow">
            <input
              className="portal__claiminput"
              data-testid={`${testId}-name`}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              autoComplete="off"
              spellCheck={false}
              placeholder={pt ? 'nome: ex. Fluran' : 'name: e.g. Fluran'}
              aria-label={pt ? 'Nome para cadastrar' : 'Name to enroll'}
            />
          </div>
          <div className="portal__claimrow">
            <input
              className="portal__claiminput"
              data-testid={`${testId}-supervisor`}
              type="text"
              value={supervisedBy}
              onChange={(e) => setSupervisedBy(e.target.value)}
              maxLength={120}
              autoComplete="off"
              spellCheck={false}
              placeholder={pt ? 'supervisor: quem acompanhou' : 'supervisor: who watched'}
              aria-label={pt ? 'Supervisor da sessão' : 'Session supervisor'}
            />
          </div>
          <div className="portal__claimrow">
            <button
              className="portal__claimbtn"
              data-testid={`${testId}-start`}
              type="submit"
              disabled={busy !== null || !name.trim() || !supervisedBy.trim()}
            >
              {busy === 'start' ? (pt ? 'abrindo…' : 'starting…') : pt ? 'Iniciar cadastro' : 'Start enrollment'}
            </button>
          </div>
        </form>
      ) : null}

      {session ? (
        <div data-testid={`${testId}-session`}>
          <div className="portal__row">
            <span className="portal__key">prompt</span>
            <span className="portal__val" data-testid={`${testId}-prompt`}>
              “{session.prompt.text}” · {session.voiceKey}
            </span>
          </div>
          <div className="portal__row">
            <span className="portal__key">takes</span>
            <span className="portal__val" data-testid={`${testId}-takes`}>
              {takes}/{session.needClips}
              {session.consistency !== null ? ` · consistência ${session.consistency}` : ''}
            </span>
          </div>
          <div className="portal__claimrow">
            <button
              className="portal__claimbtn"
              data-testid={`${testId}-record`}
              type="button"
              disabled={busy !== null || takes >= session.needClips}
              onClick={() => void recordTake()}
            >
              {busy === 'recording'
                ? `${pt ? 'falando…' : 'speaking…'} ${countdown ?? ''}`
                : busy === 'clip'
                  ? pt ? 'enviando…' : 'sending…'
                  : pt ? `Gravar amostra ${takes + 1}` : `Record sample ${takes + 1}`}
            </button>
            {debug ? (
              <button
                className="portal__claimbtn"
                data-testid={`${testId}-synth`}
                type="button"
                disabled={busy !== null || takes >= session.needClips}
                onClick={() => void synthTake('a')}
                title="Synthetic check: deterministic voice, no mic"
              >
                {pt ? 'Amostra sintética' : 'Synthetic sample'}
              </button>
            ) : null}
          </div>
          <div className="portal__claimrow">
            <button
              className="portal__claimbtn"
              data-testid={`${testId}-finish`}
              type="button"
              disabled={busy !== null || takes < 2}
              onClick={() => void finish()}
            >
              {busy === 'finish' ? (pt ? 'vinculando…' : 'binding…') : pt ? 'Vincular voz ao nome' : 'Bind voice to name'}
            </button>
            <button
              className="portal__claimbtn"
              data-testid={`${testId}-cancel`}
              type="button"
              disabled={busy !== null}
              onClick={cancel}
            >
              {pt ? 'Cancelar' : 'Cancel'}
            </button>
          </div>
          <p className="portal__voicehint" data-testid={`${testId}-supervised`}>
            {pt
              ? `supervisionado por ${session.supervisedBy} · as amostras nunca entram no turno`
              : `supervised by ${session.supervisedBy} · samples never enter the turn`}
          </p>
        </div>
      ) : null}

      {binding ? (
        <div data-testid={`${testId}-binding`}>
          <div className="portal__row">
            <span className="portal__key">bound</span>
            <span className="portal__val is-ok" data-testid={`${testId}-bound`}>
              {binding.name} · {binding.voiceKey} · {binding.printId}
            </span>
          </div>
          <div className="portal__row">
            <span className="portal__key">proof</span>
            <span className="portal__val" data-testid={`${testId}-proof`}>
              {binding.clips} takes · consistência {binding.consistency} · barra {binding.threshold}
            </span>
          </div>
          <div className="portal__claimrow">
            <button
              className="portal__claimbtn"
              data-testid={`${testId}-verify`}
              type="button"
              disabled={busy !== null}
              onClick={() => void recordWindow(CAPTURE_MS).then((blob) => verify(blob, false)).catch(fail)}
            >
              {busy === 'verify' ? (pt ? 'conferindo…' : 'checking…') : pt ? 'Re-falar para conferir' : 'Re-speak to verify'}
            </button>
            {debug ? (
              <>
                <button
                  className="portal__claimbtn"
                  data-testid={`${testId}-verify-synth`}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void verify(synthWavBlob(SYNTH_OWNER_A), false)}
                >
                  {pt ? 'Conferir (sintética)' : 'Verify (synthetic)'}
                </button>
                <button
                  className="portal__claimbtn"
                  data-testid={`${testId}-verify-stranger`}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void verify(synthWavBlob(SYNTH_STRANGER), true)}
                >
                  {pt ? 'Voz estranha' : 'Stranger voice'}
                </button>
              </>
            ) : null}
          </div>
          {verification ? (
            <p
              className={`portal__claimresult ${verification.match ? 'is-ok' : 'is-warn'}`}
              data-testid={`${testId}-verify-result`}
              data-match={verification.match ? '1' : '0'}
            >
              {verification.match
                ? pt
                  ? `reconhecida · similaridade ${verification.similarity} ≥ ${verification.threshold}`
                  : `recognized · similarity ${verification.similarity} ≥ ${verification.threshold}`
                : pt
                  ? `NÃO reconhecida · ${verification.similarity} < ${verification.threshold} — sem voz, sem nome`
                  : `NOT recognized · ${verification.similarity} < ${verification.threshold} — no voice, no name`}
            </p>
          ) : null}
          {stranger ? (
            <p
              className={`portal__claimresult ${!stranger.match ? 'is-ok' : 'is-warn'}`}
              data-testid={`${testId}-stranger-result`}
              data-match={stranger.match ? '1' : '0'}
            >
              {!stranger.match
                ? pt
                  ? `estranha segue anônima · ${stranger.similarity} < ${stranger.threshold} — sem nome sem voz`
                  : `stranger stays nameless · ${stranger.similarity} < ${stranger.threshold} — no match, no name`
                : pt
                  ? `ALERTA: estranha reconhecida · ${stranger.similarity} — limiar em revisão`
                  : `WARNING: stranger matched · ${stranger.similarity} — threshold under review`}
            </p>
          ) : null}
          <div className="portal__claimrow">
            <button
              className="portal__claimbtn"
              data-testid={`${testId}-again`}
              type="button"
              onClick={() => {
                setBinding(null);
                setVerification(null);
                setStranger(null);
                setName('');
              }}
            >
              {pt ? 'Cadastrar outra voz' : 'Enroll another voice'}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
};
