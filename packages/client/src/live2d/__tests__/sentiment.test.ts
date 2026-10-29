/**
 * sentiment — keyword rules v1.
 *
 * These pin the contract the Live2D stage depends on: text in, expression +
 * TapBody motion out. The table is intentionally boring; if a rule changes,
 * this is where the change is visible.
 */
import { classifyTurn, normalize, EXPRESSION_BY_EMOTION, MOTION_BY_EMOTION } from '../sentiment';
import { AGENT_STATE_MAP, MAO_MOTIONS } from '../motionMap';

describe('normalize', () => {
  it('strips accents and lowercases so PT and EN share one table', () => {
    expect(normalize('ÓTIMO, Ação!')).toBe('otimo, acao!');
  });
});

describe('classifyTurn', () => {
  it('greets warm (intent fallback, no keyword needed)', () => {
    const cue = classifyTurn('A casa está pronta para hoje.', 'greeting');
    expect(cue.emotion).toBe('happy');
    expect(cue.state).toBe('happy');
    expect(cue.expression).toBe('exp_02');
    // happy is the nod beat (TapBody[0] mtn_02), not an arbitrary index.
    expect(cue.motionIndex).toBe(0);
    expect(cue.motionFile).toBe('motions/mtn_02.motion3.json');
  });

  it('reads PT excitement and escalates intensity on !', () => {
    const calm = classifyTurn('Conseguimos terminar a lista.', 'briefing');
    const loud = classifyTurn('Conseguimos! Que ótimo, parabéns!', 'briefing');
    expect(loud.emotion).toBe('excited');
    expect(loud.expression).toBe('exp_04');
    expect(loud.intensity).toBeGreaterThan(calm.intensity);
    expect(loud.matched).toEqual(expect.arrayContaining(['otimo', 'parabens']));
  });

  it('reads bad news as sad', () => {
    const cue = classifyTurn('Infelizmente a tarefa da cozinha está atrasada.', 'briefing');
    expect(cue.emotion).toBe('sad');
    expect(cue.state).toBe('sad');
    expect(cue.expression).toBe('exp_05');
    // Sad is the quiet shimmer IDLE, so there is no TapBody beat to play.
    expect(cue.motionGroup).toBe('Idle');
    expect(cue.motionIndex).toBeNull();
    expect(cue.motionFile).toBe('motions/sample_01.motion3.json');
  });

  it('reads hedging as skeptical', () => {
    const cue = classifyTurn('Talvez seja melhor revisar isso antes?', 'briefing');
    expect(cue.emotion).toBe('skeptical');
    expect(cue.state).toBe('skeptical');
    expect(cue.expression).toBe('exp_07');
    expect(cue.motionIndex).toBe(1);
    expect(cue.motionFile).toBe('motions/mtn_03.motion3.json');
  });

  it('reads anger and outranks a generic greeting', () => {
    const cue = classifyTurn('Bom dia. Isso é inaceitável, estou com raiva.', 'greeting');
    expect(cue.emotion).toBe('angry');
    expect(cue.expression).toBe('exp_08');
  });

  it('does not let a trailing question mark darken a greeting', () => {
    const cue = classifyTurn('Boa tarde! O que você está carregando hoje?', 'greeting');
    expect(cue.emotion).toBe('happy');
    expect(cue.expression).toBe('exp_02');
  });

  it('does not let a salutation outrank the intent baseline', () => {
    // The manager opens every turn with "Boa tarde"; on a flat briefing that
    // must read as neutral, not as happiness.
    const cue = classifyTurn('Boa tarde, Rig Verifier. Nada está aberto para a casa agora.', 'briefing');
    expect(cue.emotion).toBe('neutral');
    // Neutral has no mood state: the door's own state (idle) owns the face, and
    // that is exp_01 — the untouched face. exp_03 (eyes closed) is the BOOT face,
    // not "neutral", which is what the old table got wrong.
    expect(cue.state).toBe('idle');
    expect(cue.expression).toBe('exp_01');
  });

  it('falls back to the intent when the text is flat', () => {
    expect(classifyTurn('', 'todos').emotion).toBe('skeptical');
    expect(classifyTurn('', 'reflection').emotion).toBe('shy');
    expect(classifyTurn('', 'briefing').emotion).toBe('neutral');
  });

  it('keeps emotion → expression/motion a total mapping', () => {
    for (const cue of [
      classifyTurn('bom dia', 'greeting'),
      classifyTurn('infelizmente atrasou', 'briefing'),
      classifyTurn('', 'briefing'),
    ]) {
      expect(EXPRESSION_BY_EMOTION[cue.emotion]).toBe(cue.expression);
      expect(MOTION_BY_EMOTION[cue.emotion]).toBe(cue.motionIndex);
    }
  });

  it('never returns an unknown expression name', () => {
    const cue = classifyTurn('???', 'briefing');
    expect(Object.values(EXPRESSION_BY_EMOTION)).toContain(cue.expression);
  });

  it('always resolves to a state that exists in the map', () => {
    const cue = classifyTurn('Infelizmente deu tudo errado e estou com raiva!', 'reflection');
    expect(AGENT_STATE_MAP[cue.state]).toBeDefined();
    expect(MAO_MOTIONS[AGENT_STATE_MAP[cue.state].motion]).toBeDefined();
  });
});
