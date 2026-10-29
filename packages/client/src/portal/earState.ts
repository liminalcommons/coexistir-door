/**
 * earState — the honest readout for the door's ear.
 *
 * The report from the door was: the tag says OUVINDO, the visitor speaks, and
 * no transcript ever appears. FOUR different faults produce that same picture,
 * and the door used to print every one of them as "listening":
 *
 *   denied     the browser blocked the microphone (getUserMedia rejected)
 *   no-frames  capture opened but delivers no blocks at all (suspended context)
 *   silent     blocks arrive and carry no audible energy (muted / zero capture)
 *   below-bar  audio arrives but never reaches the VAD's speech gate
 *
 * Everything here is a pure function of measurements, so the door can say which
 * one it is instead of guessing — and so the classification is unit-testable
 * without a microphone.
 */

export type MicErrorKind =
  | 'denied'
  | 'insecure'
  | 'no-device'
  | 'busy'
  | 'constraints'
  | 'unavailable'
  | 'error';

export type EarVerdict = 'idle' | 'ok' | 'no-frames' | 'silent' | 'below-bar';

/**
 * RMS below this carries no audible program: −50 dBFS. Real room tone sits at
 * −65…−55 and quiet speech at 1 m at −40…−30, so a peak below −50 for several
 * seconds is a capture that cannot produce a word — not a quiet room.
 */
export const SILENT_RMS = 0.0032;

/**
 * A capture is not judged before this: opening the socket, the worklet and the
 * context legitimately produces no blocks for the first few hundred ms, and a
 * door that cries "no audio" during its own boot is the same dishonesty in the
 * other direction.
 */
export const EAR_WARMUP_MS = 4000;

/**
 * Silence is confirmed later than it is first suspected: a visitor who has not
 * spoken yet is not evidence of a broken microphone, so the plain-language
 * notice waits this long (and disappears the moment an onset happens).
 */
export const SILENT_CONFIRM_MS = 6000;

/** RMS → dBFS. 0 is silence, and callers print it as −∞. */
export function dbfsOf(rms: number): number {
  if (!(rms > 0)) return -Infinity;
  return 20 * Math.log10(rms);
}

/** `-42 dBFS`, or `-∞ dBFS` for a dead-clean digital zero. */
export function dbfsText(rms: number): string {
  const db = dbfsOf(rms);
  // −100 dBFS is already below a 16-bit noise floor: printing five digits of
  // steadily decreasing negative numbers is a readout that looks broken.
  if (!Number.isFinite(db) || db < -100) return '−∞ dBFS';
  return `${Math.round(db)} dBFS`;
}

/**
 * A 0..1 meter value that follows the EAR, not the arithmetic: linear RMS
 * squashed a normal speaking voice (−30 dBFS ≈ 0.03) into the bottom half-lit
 * bar, so a quiet-but-working microphone looked identical to a dead one.
 * −60..0 dBFS now spans the whole meter.
 */
export function levelFromRms(rms: number): number {
  const db = dbfsOf(rms);
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

const DENIED_NAMES = ['NotAllowedError', 'PermissionDeniedError', 'PermissionDismissedError'];
const MISSING_NAMES = ['NotFoundError', 'DevicesNotFoundError'];
const BUSY_NAMES = ['NotReadableError', 'TrackStartError', 'AbortError'];
const CONSTRAINT_NAMES = ['OverconstrainedError', 'ConstraintNotSatisfiedError'];
const INSECURE_NAMES = ['SecurityError'];

/**
 * Classify a getUserMedia rejection by its DOMException name. The name is the
 * contract; the message is localized by the browser and cannot be matched on.
 */
export function classifyMicError(name: string | undefined, message = ''): MicErrorKind {
  const value = name ?? '';
  if (DENIED_NAMES.includes(value)) return 'denied';
  if (MISSING_NAMES.includes(value)) return 'no-device';
  if (BUSY_NAMES.includes(value)) return 'busy';
  if (CONSTRAINT_NAMES.includes(value)) return 'constraints';
  if (INSECURE_NAMES.includes(value)) return 'insecure';
  if (!value && /not supported|not found|undefined/i.test(message)) return 'unavailable';
  // A TypeError is how Chrome reports a mediaDevices that does not exist (an
  // insecure origin) or a malformed constraint — the message is the only clue.
  if (value === 'TypeError' && /not supported|undefined|secure/i.test(message)) return 'unavailable';
  return 'error';
}

export interface EarCopy {
  /** What is happening, in one sentence. Never an instruction to hurry. */
  title: string;
  /** What the visitor can do about it, plainly. */
  how: string;
}

/** How to allow the microphone, in the browser that is actually in front of them. */
const PERMISSION_HOW: Record<'pt' | 'en', string> = {
  pt: 'Clique no cadeado (ou no ícone do microfone) ao lado do endereço, escolha “Microfone → Permitir” e toque no microfone outra vez.',
  en: 'Click the padlock (or the microphone icon) next to the address, choose “Microphone → Allow”, then tap the microphone again.',
};

/**
 * The visible, plain-language explanation. `null` means "say nothing" — and
 * that is deliberate: a quiet room where nobody has spoken yet is not an error,
 * and the door does not nag.
 */
export function earNotice(
  verdict: EarVerdict,
  language: 'pt' | 'en',
  kind: MicErrorKind | null = null,
): EarCopy | null {
  // A rejected getUserMedia wins: the mic is not open at all.
  if (kind) {
    if (language === 'pt') {
      switch (kind) {
        case 'denied':
          return {
            title: 'O navegador bloqueou o microfone',
            how: PERMISSION_HOW.pt,
          };
        case 'insecure':
          return {
            title: 'Esta página não pode abrir o microfone',
            how: 'O microfone exige uma conexão segura (https). Abra o endereço com https ou use localhost.',
          };
        case 'no-device':
          return {
            title: 'Nenhum microfone encontrado',
            how: 'Conecte um microfone (ou escolha um dispositivo de entrada) e toque no microfone outra vez.',
          };
        case 'busy':
          return {
            title: 'O microfone está ocupado por outro aplicativo',
            how: 'Feche o aplicativo ou a aba que está usando o microfone e toque no microfone outra vez.',
          };
        case 'constraints':
          return {
            title: 'O microfone não aceitou as configurações pedidas',
            how: 'Troque o dispositivo de entrada no sistema e toque no microfone outra vez.',
          };
        default:
          return {
            title: 'Não foi possível abrir o microfone',
            how: 'Recarregue a página e toque no microfone outra vez. Se continuar, verifique a permissão do microfone no navegador.',
          };
      }
    }
    switch (kind) {
      case 'denied':
        return { title: 'The browser blocked the microphone', how: PERMISSION_HOW.en };
      case 'insecure':
        return {
          title: 'This page cannot open the microphone',
          how: 'The microphone needs a secure connection (https). Open the address over https or on localhost.',
        };
      case 'no-device':
        return {
          title: 'No microphone found',
          how: 'Connect a microphone (or pick an input device) and tap the microphone again.',
        };
      case 'busy':
        return {
          title: 'The microphone is held by another app',
          how: 'Close the app or tab that is using the microphone and tap the microphone again.',
        };
      case 'constraints':
        return {
          title: 'The microphone refused the requested settings',
          how: 'Pick another input device in the system and tap the microphone again.',
        };
      default:
        return {
          title: 'Could not open the microphone',
          how: 'Reload the page and tap the microphone again. If it persists, check the browser’s microphone permission.',
        };
    }
  }

  if (verdict === 'no-frames') {
    return language === 'pt'
      ? {
          title: 'O microfone abriu, mas não está entregando áudio',
          how: 'Feche outras abas que usam o microfone, confira o dispositivo de entrada e toque no microfone outra vez.',
        }
      : {
          title: 'The microphone opened but is delivering no audio',
          how: 'Close other tabs that use the microphone, check the input device, then tap the microphone again.',
        };
  }

  if (verdict === 'silent') {
    return language === 'pt'
      ? {
          title: 'Estou ouvindo, mas não chega áudio',
          how: `O microfone está aberto e nenhum som chega — verifique a permissão do microfone no navegador. ${PERMISSION_HOW.pt}`,
        }
      : {
          title: 'I’m listening, but no audio is arriving',
          how: `The microphone is open and no sound reaches it — check the browser’s microphone permission. ${PERMISSION_HOW.en}`,
        };
  }

  return null;
}

/**
 * Measurements → verdict. Thresholds are deliberately conservative: the only
 * claims the door makes are the ones a muted or blocked capture cannot fake.
 */
export function earVerdictOf(input: {
  blocks: number;
  maxRms: number;
  onsets: number;
  threshold: number;
  listeningMs: number;
}): EarVerdict {
  if (input.listeningMs < EAR_WARMUP_MS) return 'idle';
  if (input.blocks === 0) return 'no-frames';
  // Once a syllable has opened an utterance the microphone is PROVEN: a later
  // pause is the visitor thinking, and the door must not start nagging again.
  if (input.onsets > 0) return 'ok';
  if (!(input.maxRms > SILENT_RMS)) {
    return input.listeningMs >= SILENT_CONFIRM_MS ? 'silent' : 'idle';
  }
  // Audio is arriving but the speech gate never opened. Disclosed in the rail
  // and the log, never as a door banner: a quiet room with nobody speaking
  // yet looks exactly like this, and the door must not nag.
  if (input.maxRms < input.threshold) return 'below-bar';
  return 'ok';
}
