/**
 * motionMap — the inventory + the state table must agree with the model that
 * actually ships.
 *
 * This spec reads `public/live2d/models/mao/Mao.model3.json` off disk and checks
 * every motion/expression the map names: group exists, index is inside that
 * group, and the FILE those indices resolve to is the file the inventory claims.
 * That is the bug class this module was written to kill — a motion index that
 * "looked right" while pointing at a rainbow explosion.
 */
import fs from 'fs';
import path from 'path';
import {
  AGENT_STATE_MAP,
  AGENT_STATES,
  EXPRESSION_IDS,
  MAO_EXPRESSIONS,
  MAO_MOTIONS,
  MOTION_IDS,
  SENTIMENT_STATES,
  describeInstruction,
  instructionFor,
  unknownMapEntries,
  type AgentState,
} from '../motionMap';

const MODEL_DIR = path.join(__dirname, '..', '..', '..', 'public', 'live2d', 'models', 'mao');
const model = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'Mao.model3.json'), 'utf8')) as {
  FileReferences: {
    Motions: Record<string, Array<{ File: string }>>;
    Expressions: Array<{ Name: string; File: string }>;
  };
};

describe('Mao inventory (read from the shipped model)', () => {
  it('has exactly the motions the module lists, in the same order', () => {
    const fromModel: string[] = [];
    Object.entries(model.FileReferences.Motions).forEach(([group, list]) => {
      list.forEach((entry, index) => fromModel.push(`${group}:${index}=${entry.File}`));
    });
    const fromModule = MOTION_IDS.map(
      (id) => `${MAO_MOTIONS[id].group}:${MAO_MOTIONS[id].index}=${MAO_MOTIONS[id].file}`,
    );
    expect(fromModel.sort()).toEqual(fromModule.sort());
  });

  it('has exactly the expressions the module lists', () => {
    const fromModel = model.FileReferences.Expressions.map((e) => `${e.Name}=${e.File}`).sort();
    const fromModule = EXPRESSION_IDS.map(
      (id) => `${MAO_EXPRESSIONS[id].name}=${MAO_EXPRESSIONS[id].file}`,
    ).sort();
    expect(fromModel).toEqual(fromModule);
  });

  it('ships every file the inventory names', () => {
    MOTION_IDS.forEach((id) => {
      expect(fs.existsSync(path.join(MODEL_DIR, MAO_MOTIONS[id].file))).toBe(true);
    });
    EXPRESSION_IDS.forEach((id) => {
      expect(fs.existsSync(path.join(MODEL_DIR, MAO_EXPRESSIONS[id].file))).toBe(true);
    });
  });
});

describe('AGENT_STATE_MAP', () => {
  it('covers exactly the states the pipeline can be in, and nothing else', () => {
    expect(AGENT_STATES.sort()).toEqual(
      [
        'angry', 'bargeIn', 'excited', 'greeting', 'happy', 'idle',
        'listening', 'sad', 'shy', 'skeptical', 'speaking', 'thinking',
      ].sort(),
    );
  });

  it('names only motions and expressions that exist', () => {
    expect(unknownMapEntries()).toEqual([]);
  });

  it('uses every motion and every expression at least once', () => {
    const motions = new Set(AGENT_STATES.map((s) => AGENT_STATE_MAP[s].motion));
    const expressions = new Set(AGENT_STATES.map((s) => AGENT_STATE_MAP[s].expression));
    expect(Array.from(motions).sort()).toEqual([...MOTION_IDS].sort());
    expect(Array.from(expressions).sort()).toEqual(
      [...EXPRESSION_IDS.filter((id) => id !== 'rest')].sort(),
    );
    // `rest` is the boot face (eyes closed while the rig loads), not a state.
    expect(EXPRESSION_IDS).toContain('rest');
  });

  it('keeps the face in `speaking` and beats a motion everywhere else', () => {
    expect(AGENT_STATE_MAP.speaking.keepFace).toBe(true);
    expect(AGENT_STATE_MAP.speaking.beat).toBe('loop');
    expect(AGENT_STATE_MAP.thinking.beat).toBe('once');
    expect(AGENT_STATE_MAP.idle.beat).toBe('loop');
  });

  it('gives each sentiment its own state, and the map resolves to a real file', () => {
    SENTIMENT_STATES.forEach((state) => {
      const instruction = instructionFor(state as AgentState);
      expect(instruction.state).toBe(state);
      expect(fs.existsSync(path.join(MODEL_DIR, instruction.motion.file))).toBe(true);
      expect(instruction.expression.name).toMatch(/^exp_0[1-8]$/);
    });
  });

  it('prints one proof line naming state, motion file and expression', () => {
    const line = describeInstruction(instructionFor('excited'));
    expect(line).toBe(
      'state=excited · once · motion TapBody[4] special_02.motion3.json (rainbow spark burst) · ' +
        'expression exp_04 (sparkle eyes)',
    );
  });

  it('bargeIn cuts to the listening pose (nod + neutral)', () => {
    const cut = instructionFor('bargeIn');
    expect(cut.motion.group).toBe('TapBody');
    expect(cut.expression.name).toBe(MAO_EXPRESSIONS.neutral.name);
  });
});
