/**
 * PortalStage — the always-on stage for Mara.
 *
 * Same rig as the room (CubismAvatar + Mao), framed as an UPPER-BODY portrait.
 * Every face and gesture it wears comes from `motionMap.ts` — the inventory of
 * Mao's real files plus the explicit agent-state table. Nothing here picks a
 * motion by index and nothing is random except the rig's own idle variety.
 *
 *   idle        the `breath` motion (Idle[0]) loops; physics/blink run in the rig
 *   listening   the `nod` beat (TapBody[0]) when the ear opens
 *   thinking    the `tilt` beat (TapBody[1]) + the pondering face while a turn is
 *               in flight
 *   speaking    `breath` again, with ParamA following the REAL output amplitude
 *               of the streamed TTS (agentVoice analyser); the emotion face is
 *               KEPT (the map's `keepFace`) so the answer does not reset it
 *   greeting    `flourish` (TapBody[2]) + smile
 *   sentiment   the answer's emotion, resolved by `sentiment.ts` → the map
 *   bargeIn     cut the motion queue, nod, neutral face — the floor goes back
 *
 * Framing (review #5/#2) is per breakpoint and lives on the VIEW MATRIX
 * (`CubismAvatar.setFraming`), never on the model and never as a CSS transform:
 *   tall  (portrait, ≤999px)  the 9:16 card keeps the door's original composition
 *   wide  (desktop, ≥1000px)  head and shoulders fill the bigger stage
 * The canvas backing store follows the CSS box at devicePixelRatio, capped in
 * pixels by `backingScale`, so a 1440p stage cannot allocate an unbounded
 * framebuffer for a portrait nobody in the room can tell apart.
 *
 * Rendering PAUSES while the tab is hidden: no updates, no draws, so a door left
 * in a background tab costs nothing and does not fight the audio thread.
 *
 * Proof surface: every state change goes through `recordTrigger`, so the console
 * carries one `[live2d:trigger]` line per change and `window.__portalRig` can be
 * asked for the current motion, the expression, the map, and the fired states.
 * A load failure is shown, never papered over with a stand-in.
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { CubismAvatar, type AvatarFraming } from '../live2d/CubismAvatar';
import { classifyTurn, type StageCue } from '../live2d/sentiment';
import {
  AGENT_STATE_MAP,
  instructionFor,
  unknownMapEntries,
  type AgentState,
  type StageInstruction,
} from '../live2d/motionMap';
import {
  firedStates,
  readTriggers,
  recordTrigger,
  subscribeTriggers,
  type TriggerRecord,
} from '../live2d/stageTriggers';
import { agentVoice } from '../coexistir/agentVoice';
import type { DoorState } from './doorState';

const MODEL_URL = '/live2d/models/mao/Mao.model3.json';

/** The CSS breakpoint that switches the door to the desktop (stage + rail) layout. */
export const PORTAL_WIDE_QUERY = '(min-width: 1000px)';

/**
 * Upper-body framing per breakpoint, in clip space (-1..1, 2.0 = full height).
 * `offsetY` is negative because the head sits ABOVE the stage centre: zooming
 * about the centre pushes it out of frame, so it has to be pulled back down.
 */
export const STAGE_FRAMING: Record<'tall' | 'wide', AvatarFraming> = {
  tall: { scale: 1.55, offsetY: -0.46 },
  wide: { scale: 3.0, offsetY: -1.15 },
};

export type StageStatus = 'loading' | 'ready' | 'error';

/** The door's own state, in the map's vocabulary. */
export function agentStateOf(state: DoorState): AgentState {
  if (state === 'speaking') return 'speaking';
  if (state === 'thinking') return 'thinking';
  if (state === 'listening') return 'listening';
  return 'idle';
}

export interface PortalRigTelemetry {
  status: StageStatus;
  frames: number;
  expression: string | null;
  motion: { group: string; index: number } | null;
  mouth: number;
  cue: StageCue | null;
  /** The map entry the rig was last told to wear. */
  state: AgentState | null;
  framing: AvatarFraming;
  paused: boolean;
  dpr: number;
  canvas: { width: number; height: number; cssWidth: number; cssHeight: number };
  lastTrigger: TriggerRecord | null;
}

export interface PortalStageHandle {
  applyCue: (text: string, intent?: string, override?: AgentState) => StageCue | null;
  applyState: (state: AgentState, why?: 'debug' | 'door-state') => StageInstruction | null;
  telemetry: () => PortalRigTelemetry;
  setExpression: (name: string) => boolean;
  setFraming: (framing: AvatarFraming) => void;
  closeMouth: () => void;
}

interface PortalStageProps {
  speaking: boolean;
  /** The door's ONE state; the badge prints it, the stage paints it. */
  state: DoorState;
  /** The exact word on the state line — the badge must not invent its own. */
  stateLabel: string;
  /** Bumped by the page on a barge-in: the mouth must shut on this frame. */
  cutAt: number;
  onStatus?: (status: StageStatus, error?: string) => void;
}

declare global {
  interface Window {
    __portalRig?: {
      ready: () => boolean;
      frames: () => number;
      expression: () => string | null;
      motion: () => { group: string; index: number } | null;
      mouth: () => number;
      cue: () => StageCue | null;
      framing: () => AvatarFraming;
      paused: () => boolean;
      play: (group: string, index?: number) => boolean;
      setExpression: (name: string) => boolean;
      setFraming: (framing: AvatarFraming) => void;
      /** Drive a state through the SAME path the pipeline uses (debug/proof). */
      applyState: (state: AgentState) => StageInstruction | null;
      /** Drive a manager line through sentiment → the map (debug/proof). */
      applyCue: (text: string, intent?: string, override?: AgentState) => StageCue | null;
      /** The whole map, so a probe can assert against the door's own table. */
      map: () => typeof AGENT_STATE_MAP;
      /** Every trigger this page load, in order. */
      triggers: () => TriggerRecord[];
      /** States that fired at least once. */
      fired: () => AgentState[];
      state: () => AgentState | null;
    };
    __portalRigError?: string;
  }
}

const isWide = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(PORTAL_WIDE_QUERY).matches
    : false;

export const PortalStage = forwardRef<PortalStageHandle, PortalStageProps>(function PortalStage(
  { speaking, state, stateLabel, cutAt, onStatus },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const avatarRef = useRef<CubismAvatar | null>(null);
  const frameRef = useRef<number | null>(null);
  const cueRef = useRef<StageCue | null>(null);
  const speakingRef = useRef(false);
  const mouthRef = useRef(0);
  const expressionRef = useRef<string | null>(null);
  const cutRef = useRef(0);
  const wideRef = useRef(isWide());
  const framingRef = useRef<AvatarFraming>(STAGE_FRAMING[wideRef.current ? 'wide' : 'tall']);
  const pausedRef = useRef(false);
  /** The state the rig is currently wearing (mirror for the badge/telemetry). */
  const agentStateRef = useRef<AgentState | null>(null);

  const [status, setStatus] = useState<StageStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [expression, setExpression] = useState<string | null>(null);
  const [cue, setCue] = useState<StageCue | null>(null);
  const [agentState, setAgentState] = useState<AgentState | null>(null);
  const [triggers, setTriggers] = useState<TriggerRecord[]>([]);
  /** Printed on the stage so the framing in force is visible, not inferred. */
  const [framingText, setFramingText] = useState(
    `${STAGE_FRAMING[wideRef.current ? 'wide' : 'tall'].scale}/${STAGE_FRAMING[wideRef.current ? 'wide' : 'tall'].offsetY}`,
  );

  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  speakingRef.current = speaking;

  // The panel and the stage read the same ring buffer the console prints from.
  useEffect(() => subscribeTriggers(setTriggers), []);
  useEffect(() => {
    setTriggers(readTriggers());
  }, []);

  /**
   * Tell the rig to wear one map entry, and record what actually happened.
   *
   * `applied` is the AND of what `playMotion` and `setExpression` returned, so a
   * missing file or a rig that is not ready yet shows up as `applied=false`
   * instead of a green log line nobody can trust.
   */
  const applyInstruction = useCallback(
    (instruction: StageInstruction, why: TriggerRecord['why'], cut = false): boolean => {
      const avatar = avatarRef.current;
      // Before the rig is mounted nothing was asked of it: do not record a
      // "trigger" that never reached a model. The pending cue is re-applied on
      // load (see the `cueRef` replay in the boot effect), which logs the real
      // one.
      if (!avatar) {
        agentStateRef.current = instruction.state;
        setAgentState(instruction.state);
        return false;
      }
      if (cut) avatar.stopMotion();
      const played = avatar.playMotion(instruction.motion.group, instruction.motion.index);
      const keepsFace = AGENT_STATE_MAP[instruction.state].keepFace === true;
      const faced = keepsFace ? true : avatar.setExpression(instruction.expression.name);
      const applied = played && faced;
      agentStateRef.current = instruction.state;
      setAgentState(instruction.state);
      recordTrigger({ instruction, applied, why });
      return applied;
    },
    [],
  );

  const applyState = useCallback(
    (next: AgentState, why: TriggerRecord['why'] = 'door-state'): StageInstruction | null => {
      const instruction = instructionFor(next);
      applyInstruction(instruction, why, next === 'bargeIn');
      return instruction;
    },
    [applyInstruction],
  );

  const applyCue = useCallback(
    (text: string, intent?: string, override?: AgentState): StageCue | null => {
      const base = classifyTurn(text, intent);
      const state = override ?? base.state;
      const instruction = instructionFor(state);
      // A caller that KNOWS the beat (the greeting) wins over the text's mood:
      // the door's hello is a flourish even when the composed sentence reads
      // "happy". Everything else keeps the sentiment's own state.
      const next: StageCue = {
        ...base,
        state,
        expression: instruction.expression.name,
        motionGroup: instruction.motion.group,
        motionIndex: instruction.motion.group === 'TapBody' ? instruction.motion.index : null,
        motionFile: instruction.motion.file,
      };
      cueRef.current = next;
      setCue(next);
      applyInstruction(instruction, 'turn-text');
      return next;
    },
    [applyInstruction],
  );

  const closeMouth = useCallback(() => {
    avatarRef.current?.closeMouth();
    mouthRef.current = 0;
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      applyCue,
      applyState,
      closeMouth,
      setExpression: (name: string) => avatarRef.current?.setExpression(name) ?? false,
      setFraming: (framing: AvatarFraming) => {
        framingRef.current = framing;
        avatarRef.current?.setFraming(framing);
      },
      telemetry: () => {
        const canvas = canvasRef.current;
        const all = readTriggers();
        return {
          status,
          frames: avatarRef.current?.renderedFrames ?? 0,
          expression: avatarRef.current?.currentExpression ?? null,
          motion: avatarRef.current?.currentMotion ?? null,
          mouth: mouthRef.current,
          cue: cueRef.current,
          state: agentStateRef.current,
          framing: avatarRef.current?.currentFraming ?? framingRef.current,
          paused: pausedRef.current,
          dpr: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
          canvas: {
            width: canvas?.width ?? 0,
            height: canvas?.height ?? 0,
            cssWidth: Math.round(canvas?.clientWidth ?? 0),
            cssHeight: Math.round(canvas?.clientHeight ?? 0),
          },
          lastTrigger: all.length > 0 ? all[all.length - 1] : null,
        };
      },
    }),
    [applyCue, applyState, closeMouth, status],
  );

  // --- the door state drives the map (listening / thinking / speaking / idle) --
  const doorAgentState = agentStateOf(state);
  useEffect(() => {
    const worn = agentStateRef.current;
    // The greeting and the sentiment beats are MORE specific than the door
    // state. A finished answer leaves her wearing that face until the ear or a
    // barge-in asks for something else — the door going quiet is not a cue.
    const sentimentStates: AgentState[] = [
      'greeting', 'happy', 'excited', 'sad', 'shy', 'skeptical', 'angry',
    ];
    if (worn && sentimentStates.includes(worn) && doorAgentState === 'listening') return;
    if (worn === doorAgentState) return;
    applyState(doorAgentState, 'door-state');
  }, [applyState, doorAgentState]);

  // --- a barge-in shuts the mouth AND cuts the beat -------------------------
  useEffect(() => {
    if (cutAt === cutRef.current) return;
    cutRef.current = cutAt;
    if (cutAt > 0) {
      closeMouth();
      applyState('bargeIn', 'barge-in');
    }
  }, [applyState, closeMouth, cutAt]);

  // --- boot the rig + one RAF loop -----------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let last = performance.now();

    const loop = (now: number) => {
      // Hidden tab: hold the frame, draw nothing, keep the loop cheap.
      if (typeof document !== 'undefined' && document.hidden) {
        pausedRef.current = true;
        last = now;
        frameRef.current = requestAnimationFrame(loop);
        return;
      }
      pausedRef.current = false;
      const dt = Math.max(0, (now - last) / 1000);
      last = now;
      const avatar = avatarRef.current;
      if (avatar) {
        try {
          const mouth = speakingRef.current ? agentVoice.getLevel() : 0;
          mouthRef.current = mouth;
          avatar.setMouthOpen(mouth);
          avatar.update(dt);
          avatar.draw();
          canvas.dataset.mouth = mouth.toFixed(2);
          const worn = avatar.currentExpression;
          if (worn && worn !== expressionRef.current) {
            expressionRef.current = worn;
            setExpression(worn);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          window.__portalRigError = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : message;
          setError(message);
          setStatus('error');
          onStatusRef.current?.('error', message);
          frameRef.current = null;
          return;
        }
      }
      frameRef.current = requestAnimationFrame(loop);
    };
    frameRef.current = requestAnimationFrame(loop);

    CubismAvatar.load({ canvas, modelUrl: MODEL_URL, label: 'mao-portal' })
      .then((avatar) => {
        if (cancelled) {
          avatar.dispose();
          return;
        }
        avatarRef.current = avatar;
        avatar.setFraming(framingRef.current);
        avatar.resize();
        setStatus('ready');
        onStatusRef.current?.('ready');
        // A map that names a file the model does not ship is a bug: say it on
        // boot, before a visitor sees a silent gesture.
        const problems = unknownMapEntries();
        if (problems.length > 0) {
          console.error('[live2d] map references missing model entries:', problems.join('; '));
        }
        // Boot face: the rest face (eyes closed) until the first cue lands — the
        // same "rigging / not yet awake" beat the door had before.
        avatar.setExpression('exp_03');
        applyInstruction(instructionFor('idle'), 'boot');
        if (cueRef.current) applyInstruction(instructionFor(cueRef.current.state), 'turn-text');
        window.__portalRig = {
          ready: () => Boolean(avatarRef.current),
          frames: () => avatarRef.current?.renderedFrames ?? 0,
          expression: () => avatarRef.current?.currentExpression ?? null,
          motion: () => avatarRef.current?.currentMotion ?? null,
          mouth: () => mouthRef.current,
          cue: () => cueRef.current,
          framing: () => avatarRef.current?.currentFraming ?? framingRef.current,
          paused: () => pausedRef.current,
          play: (group: string, index = 0) => avatarRef.current?.playMotion(group, index) ?? false,
          setExpression: (name: string) => avatarRef.current?.setExpression(name) ?? false,
          setFraming: (framing: AvatarFraming) => {
            framingRef.current = framing;
            avatarRef.current?.setFraming(framing);
            setFramingText(`${framing.scale}/${framing.offsetY}`);
          },
          applyState: (next: AgentState) => applyState(next, 'debug'),
          applyCue: (text: string, intent?: string, override?: AgentState) =>
            applyCue(text, intent, override),
          map: () => AGENT_STATE_MAP,
          triggers: () => readTriggers(),
          fired: () => firedStates(),
          state: () => agentStateRef.current,
        };
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setStatus('error');
        onStatusRef.current?.('error', message);
        console.error('[portal] Live2D stage failed:', message);
      });

    const resize = () => avatarRef.current?.resize();
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    observer?.observe(canvas.parentElement ?? canvas);
    window.addEventListener('resize', resize);

    // A breakpoint flip re-frames the same model: the view matrix changes, the
    // canvas box changes, and the backing store follows the CSS box.
    const query =
      typeof window.matchMedia === 'function' ? window.matchMedia(PORTAL_WIDE_QUERY) : null;
    const onBreakpoint = () => {
      wideRef.current = query ? query.matches : isWide();
      framingRef.current = STAGE_FRAMING[wideRef.current ? 'wide' : 'tall'];
      avatarRef.current?.setFraming(framingRef.current);
      setFramingText(`${framingRef.current.scale}/${framingRef.current.offsetY}`);
      resize();
    };
    query?.addEventListener?.('change', onBreakpoint);

    return () => {
      cancelled = true;
      observer?.disconnect();
      query?.removeEventListener?.('change', onBreakpoint);
      window.removeEventListener('resize', resize);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      delete window.__portalRig;
      avatarRef.current?.dispose();
      avatarRef.current = null;
    };
  }, [applyCue, applyInstruction, applyState]);

  const handleTap = useCallback(() => {
    // A tap is a greeting beat, not a random draw: the same flourish the
    // greeting uses, logged like any other trigger.
    applyState('greeting', 'debug');
  }, [applyState]);

  const lastTrigger = triggers.length > 0 ? triggers[triggers.length - 1] : null;

  return (
    <div
      className={`portal-stage is-${status}${speaking ? ' is-speaking' : ''} is-${state}`}
      data-testid="portal-stage"
      data-status={status}
      data-state={state}
      data-speaking={speaking ? 'true' : 'false'}
      data-expression={expression ?? ''}
      data-agent-state={agentState ?? ''}
      data-motion={lastTrigger ? `${lastTrigger.motionGroup}:${lastTrigger.motionIndex}` : ''}
      data-emotion={cue?.emotion ?? ''}
      data-framing={framingText}
      aria-label="Mara, the household manager, on the front-door stage"
    >
      <span className="portal-stage__corner portal-stage__corner--tl" aria-hidden="true" />
      <span className="portal-stage__corner portal-stage__corner--tr" aria-hidden="true" />
      <span className="portal-stage__corner portal-stage__corner--bl" aria-hidden="true" />
      <span className="portal-stage__corner portal-stage__corner--br" aria-hidden="true" />

      <div className="portal-stage__halo" aria-hidden="true" />
      <div className="portal-stage__halo portal-stage__halo--outer" aria-hidden="true" />

      <canvas
        ref={canvasRef}
        className="portal-stage__canvas"
        onClick={handleTap}
        role="img"
        aria-label="Animated Live2D portrait of Mao"
      />

      {status !== 'ready' && (
        <div className={`portal-stage__state is-${status}`} data-testid="portal-stage-state">
          {status === 'loading' ? 'Rigging Mara…' : `Rig offline — ${error ?? 'unknown error'}`}
        </div>
      )}

      <div className="portal-stage__plate">
        {/* The badge is the state line's word, verbatim — no second opinion. */}
        <span className="portal-stage__badge" data-testid="portal-stage-badge" data-state={state}>
          {status === 'ready' ? stateLabel : status === 'loading' ? 'RIGGING' : 'RIG OFFLINE'}
        </span>
        {/* What she is actually wearing, from the trigger log — not a guess. */}
        <span
          className="portal-stage__cue"
          data-testid="portal-cue"
          title={lastTrigger?.line ?? undefined}
        >
          {lastTrigger
            ? `${lastTrigger.state} · ${lastTrigger.motionGroup}[${lastTrigger.motionIndex}] · ${lastTrigger.expression}`
            : 'idle'}
        </span>
      </div>
    </div>
  );
});

export default PortalStage;
