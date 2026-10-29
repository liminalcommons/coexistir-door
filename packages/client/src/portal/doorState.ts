/**
 * doorState — the ONE state the door is allowed to be in, and the words for it.
 *
 * The owner's screenshot had three widgets disagreeing (tag IDLE, caption "Pode
 * falar", dock STOP). The fix is not more copy: it is ONE derived state, printed
 * by the stage badge and the dock state line from the same object.
 *
 * The locked behaviour removes the old `idle`/`error` states from the readout:
 *   deaf      the mic is OFF — the door is not hearing anything (idle-deaf)
 *   listening the mic is ON and the ear is open. This is the resting state and
 *             it has NO timeout: no nag, no "tap to speak", no auto-stop.
 *   thinking  an utterance is in flight (STT) or the turn is being composed
 *   speaking  Mara's own audio is audible
 *
 * `error` is not a state: an error is a banner, and the state line keeps telling
 * the truth about the ear while the banner explains the failure.
 *
 * Hints are CONSTANT properties of a state — never timers. Nothing here changes
 * with the passage of silence, which is what "waits indefinitely, never nags"
 * means in code.
 */

export type DoorState = 'deaf' | 'listening' | 'thinking' | 'speaking';

export interface DoorCopy {
  /** The word on the stage tag and on the state line — identical strings. */
  label: string;
  /** What is true, or what the dock does. Never an instruction to hurry. */
  hint: string;
}

export const DOOR_COPY: Record<'pt' | 'en', Record<DoorState, DoorCopy>> = {
  pt: {
    deaf: { label: 'MIC DESLIGADO', hint: 'Toque no microfone para ela ouvir' },
    listening: { label: 'OUVINDO', hint: 'Fale — a pergunta vai sozinha' },
    thinking: { label: 'PENSANDO', hint: 'Ela está preparando a resposta' },
    speaking: { label: 'MARA FALANDO', hint: 'Fale por cima para interromper' },
  },
  en: {
    deaf: { label: 'MIC OFF', hint: 'Tap the microphone so she can hear' },
    listening: { label: 'LISTENING', hint: 'Speak — your question sends itself' },
    thinking: { label: 'THINKING', hint: 'She is composing the answer' },
    speaking: { label: 'MARA SPEAKING', hint: 'Talk over her to interrupt' },
  },
};

export interface DoorFacts {
  micOn: boolean;
  speaking: boolean;
  thinking: boolean;
}

/**
 * Priority is deliberate:
 *   speaking > deaf > thinking > listening
 *
 * Speaking outranks `deaf` because her voice is an audible fact about the room
 * even with the mic shut; hiding it would be the readout lying in the other
 * direction. With the mic ON, thinking is a sub-state of listening — the ear is
 * still open — but the label says what the visitor is waiting on.
 */
export function doorStateOf(facts: DoorFacts): DoorState {
  if (facts.speaking) return 'speaking';
  if (!facts.micOn) return 'deaf';
  if (facts.thinking) return 'thinking';
  return 'listening';
}

/** True while the microphone should be live. The single source for the dock. */
export function isEarOpen(state: DoorState): boolean {
  return state !== 'deaf';
}
