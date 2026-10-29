/**
 * CoexistirLive2DStage — the room's real Cubism rig.
 *
 * Owner decision: the manager is not an SVG mascot. This mounts the official
 * Cubism Web runtime on a WebGL canvas and drives it from the room:
 *
 *   idle        → Mao's own Idle motion group loops on its own
 *   manager turn→ keyword rules v1 (sentiment.ts) pick exp_0x + a TapBody motion
 *   speaking    → LipSync parameter (ParamA) follows the live TTS audio RMS
 *
 * The model is Mao, a Live2D Original Character under the Free Material
 * License. The required credit line lives in the footer and must not be
 * removed. The .moc3 payload is intentionally not committed (no raw-material
 * redistribution); see scripts/live2d/sync-live2d-assets.mjs.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CubismAvatar } from './CubismAvatar';
import { AudioMouthTap } from './audioMouth';
import { StageCue, classifyTurn } from './sentiment';
import { AGENT_AUDIO_EVENT, agentVoice } from '../coexistir/agentVoice';
import { MANAGER_TURN_EVENT, ManagerTurnEventDetail } from '../coexistir/managerApi';
import './CoexistirLive2DStage.css';

/** Vite `base` is '/', so the public/ payload is always rooted. */
const MODEL_URL = '/live2d/models/mao/Mao.model3.json';

const CREDIT = 'This content uses sample data owned and copyrighted by Live2D Inc.';

type StageStatus = 'loading' | 'ready' | 'error';

interface DebugHandle {
  ready: () => boolean;
  frames: () => number;
  cue: () => StageCue | null;
  mouth: () => number;
  expression: () => string | null;
  motion: () => { group: string; index: number } | null;
  play: (group: string, index?: number) => boolean;
  setExpression: (name: string) => boolean;
}

declare global {
  interface Window {
    __coexistirLive2d?: DebugHandle;
  }
}

export const CoexistirLive2DStage: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const avatarRef = useRef<CubismAvatar | null>(null);
  const cueRef = useRef<StageCue | null>(null);
  const tapRef = useRef<AudioMouthTap | null>(null);
  const frameRef = useRef<number | null>(null);
  const speakingRef = useRef(false);

  const [status, setStatus] = useState<StageStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [cue, setCue] = useState<StageCue | null>(null);
  const [activeExpression, setActiveExpression] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const expressionRef = useRef<string | null>(null);

  const applyCue = useCallback((next: StageCue) => {
    cueRef.current = next;
    setCue(next);
    const avatar = avatarRef.current;
    if (!avatar) return;
    avatar.setExpression(next.expression);
    if (next.motionIndex !== null) avatar.playMotion('TapBody', next.motionIndex);
  }, []);

  // --- mount: boot the rig, then run one RAF loop for update + draw ---------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let last = performance.now();

    const loop = (now: number) => {
      const dt = Math.max(0, (now - last) / 1000);
      last = now;
      const avatar = avatarRef.current;
      if (avatar) {
        try {
          avatar.setMouthOpen(speakingRef.current ? (tapRef.current?.level() ?? 0) : 0);
          avatar.update(dt);
          avatar.draw();
          // Keep the footer honest even when `setExpression` was driven by a
          // probe rather than a turn: show what the rig is actually wearing.
          const worn = avatar.currentExpression;
          if (worn && worn !== expressionRef.current) {
            expressionRef.current = worn;
            setActiveExpression(worn);
          }
        } catch (err) {
          // A broken frame must not spin silently: record it, stop the loop,
          // and let the panel report the rig as offline.
          const message = err instanceof Error ? err.message : String(err);
          window.__coexistirLive2dError = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : message;
          setError(message);
          setStatus('error');
          console.error('[live2d] frame failed:', err);
          frameRef.current = null;
          return;
        }
      }
      frameRef.current = requestAnimationFrame(loop);
    };
    frameRef.current = requestAnimationFrame(loop);

    CubismAvatar.load({ canvas, modelUrl: MODEL_URL, label: 'mao' })
      .then((avatar) => {
        if (cancelled) {
          avatar.dispose();
          return;
        }
        avatarRef.current = avatar;
        avatar.resize();
        avatar.setExpression('exp_03');
        setStatus('ready');
        if (cueRef.current) applyCue(cueRef.current);
        // Deterministic probe surface for rig verification (read-only in prod).
        window.__coexistirLive2d = {
          ready: () => Boolean(avatarRef.current),
          frames: () => avatarRef.current?.renderedFrames ?? 0,
          cue: () => cueRef.current,
          mouth: () => avatarRef.current?.mouthOpen ?? 0,
          expression: () => avatarRef.current?.currentExpression ?? null,
          motion: () => avatarRef.current?.currentMotion ?? null,
          play: (group: string, index = 0) => avatarRef.current?.playMotion(group, index) ?? false,
          setExpression: (name: string) => avatarRef.current?.setExpression(name) ?? false,
        };
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setStatus('error');
        // No SVG stand-in on purpose: the owner asked for the real rig or nothing.
        console.error('[live2d] stage failed:', message);
      });

    const onResize = () => avatarRef.current?.resize();
    window.addEventListener('resize', onResize);

    return () => {
      cancelled = true;
      window.removeEventListener('resize', onResize);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      delete window.__coexistirLive2d;
      tapRef.current?.detach();
      avatarRef.current?.dispose();
      avatarRef.current = null;
    };
  }, [applyCue]);

  // --- manager turns: text in, expression + motion out ---------------------
  useEffect(() => {
    const onTurn = (event: Event) => {
      const detail = (event as CustomEvent<ManagerTurnEventDetail>).detail;
      if (!detail || typeof detail.text !== 'string') return;
      const next = classifyTurn(detail.text, detail.intent);
      applyCue(next);
      console.info(`[live2d] turn cue ${next.emotion} → ${next.expression}` +
        (next.motionIndex === null ? '' : ` + TapBody ${next.motionIndex}`) +
        (next.matched.length ? ` (${next.matched.join(', ')})` : ''));
    };
    window.addEventListener(MANAGER_TURN_EVENT, onTurn as EventListener);
    return () => window.removeEventListener(MANAGER_TURN_EVENT, onTurn as EventListener);
  }, [applyCue]);

  // --- audio: tap the exact element the voice controller is playing --------
  useEffect(() => {
    if (!tapRef.current) tapRef.current = new AudioMouthTap();
    const tap = tapRef.current;

    const onAudio = (event: Event) => {
      const detail = (event as CustomEvent<{ audio?: HTMLAudioElement }>).detail;
      tap.attach(detail?.audio ?? null);
    };
    window.addEventListener(AGENT_AUDIO_EVENT, onAudio as EventListener);

    const unsubscribe = agentVoice.subscribe((state) => {
      const isSpeaking = state.phase === 'speaking';
      speakingRef.current = isSpeaking;
      setSpeaking(isSpeaking);
      if (!isSpeaking) tapRef.current?.detach();
    });

    return () => {
      window.removeEventListener(AGENT_AUDIO_EVENT, onAudio as EventListener);
      unsubscribe();
      tap.detach();
    };
  }, []);

  const handleTap = useCallback(() => {
    const avatar = avatarRef.current;
    if (!avatar) return;
    avatar.playRandomMotion('TapBody');
  }, []);

  return (
    <aside
      className={`coexistir-live2d ${speaking ? 'is-speaking' : ''}`}
      data-testid="live2d-stage"
      data-status={status}
      data-emotion={cue?.emotion ?? ''}
      data-expression={activeExpression ?? cue?.expression ?? ''}
      data-speaking={speaking ? 'true' : 'false'}
      aria-label="Mara, the household manager, as a Live2D character"
    >
      <div className="coexistir-live2d__frame">
        <canvas
          ref={canvasRef}
          className="coexistir-live2d__canvas"
          onClick={handleTap}
          role="img"
          aria-label="Animated Live2D model of Mao"
        />
        {status !== 'ready' && (
          <div className={`coexistir-live2d__state is-${status}`} data-testid="live2d-state">
            {status === 'loading' ? 'Rigging Mao…' : `Rig offline: ${error ?? 'unknown error'}`}
          </div>
        )}
        <span className="coexistir-live2d__badge">{speaking ? 'speaking' : 'idle'}</span>
      </div>
      <footer className="coexistir-live2d__foot">
        <span className="coexistir-live2d__name">Mara · Live2D</span>
        <span className="coexistir-live2d__cue" data-testid="live2d-cue">
          {cue ? `${cue.emotion} · ${activeExpression ?? cue.expression}` : 'listening'}
        </span>
        <span className="coexistir-live2d__credit">{CREDIT}</span>
      </footer>
    </aside>
  );
};

export default CoexistirLive2DStage;
