/**
 * doorLanguage.test.ts — the door's language pin, proved against the rig's own
 * misfires.
 *
 * Every text/confidence pair below is a REAL row from this rig's house log
 * (`portal-mic-rig/house/turns.jsonl`), not an invented example. That matters:
 * the two classes overlap on confidence (0.941 English vs 0.985 Portuguese), so
 * a test that only exercises clean 0.999 cases would prove nothing about the
 * bug this module exists to prevent.
 */

import {
  DOOR_DEFAULT_LANGUAGE,
  DOOR_STT_LANGUAGE,
  describeDoorLanguage,
  languageEvidence,
  resolveDoorLanguage,
  sttLanguageFor,
  tokenize,
} from '../doorLanguage';

describe('resolveDoorLanguage — the pin', () => {
  it('defaults to Portuguese when nothing was detected', () => {
    const decision = resolveDoorLanguage({ detected: null, confidence: null, text: '' });
    expect(DOOR_DEFAULT_LANGUAGE).toBe('pt');
    expect(decision.language).toBe('pt');
    expect(decision.reason).toBe('default');
    expect(decision.overridden).toBe(false);
  });

  it('keeps Portuguese when the provider agrees', () => {
    const decision = resolveDoorLanguage({
      detected: 'pt',
      confidence: 0.9990151,
      text: 'Mara, me dá o briefing da casa hoje?',
    });
    expect(decision.language).toBe('pt');
    expect(decision.reason).toBe('detected-pt');
    expect(decision.overridden).toBe(false);
  });

  it('overrules the known misfire: garbled PT detected as EN (0.941)', () => {
    // Real row: "Hola Mara, Okay Esta Hoberto para a Casa Hoggi" — det=en 0.9407
    const decision = resolveDoorLanguage({
      detected: 'en',
      confidence: 0.9407337,
      text: 'Hola Mara, Okay Esta Hoberto para a Casa Hoggi',
    });
    expect(decision.language).toBe('pt');
    expect(decision.detectedTurnLanguage).toBe('en');
    expect(decision.overridden).toBe(true);
    expect(decision.reason).toBe('pt-evidence');
  });

  it('overrules the higher-confidence misfire (0.985) that a threshold alone would miss', () => {
    // Real row: "Beau Ettard. Euca Sterea di Sabre que Sao as Tarifa's Abertas
    // Nacasa de coexistor nest memento." — det=en 0.9851, higher than a REAL
    // English clip in the same log (0.9819). Text evidence is what decides.
    const decision = resolveDoorLanguage({
      detected: 'en',
      confidence: 0.98511726,
      text:
        "Beau Ettard. Euca Sterea di Sabre que Sao as Tarifa's Abertas " +
        'Nacasa de coexistor nest memento.',
    });
    expect(decision.language).toBe('pt');
    expect(decision.overridden).toBe(true);
    expect(decision.evidence.pt).toBeGreaterThan(decision.evidence.en);
  });

  it('lets unmistakable English through (0.982 real clip)', () => {
    const decision = resolveDoorLanguage({
      detected: 'en',
      confidence: 0.98195183,
      text: 'Mara, what is on the list today?',
    });
    expect(decision.language).toBe('en');
    expect(decision.detectedTurnLanguage).toBe('en');
    expect(decision.reason).toBe('detected-en');
    expect(decision.overridden).toBe(false);
  });

  it('lets a lower-confidence but clearly English clip through (0.941 real clip)', () => {
    // Real row: "Hello, Mara. Do you hear my voice well?" — det=en 0.9408
    const decision = resolveDoorLanguage({
      detected: 'en',
      confidence: 0.940862,
      text: 'Hello, Mara. Do you hear my voice well?',
    });
    expect(decision.language).toBe('en');
    expect(decision.overridden).toBe(false);
  });

  it('answers clean English at 0.82 — the probe that used to be classed low-confidence', () => {
    // Opus finding #2, real probe clip. det=en 0.82, four English function
    // words, zero Portuguese ones. The old rule required confidence >= 0.9
    // and pinned this clip to Portuguese; the words are the evidence.
    const decision = resolveDoorLanguage({
      detected: 'en',
      confidence: 0.82,
      text: 'Do you actually see my face too, Mara?',
    });
    expect(decision.evidence.pt).toBe(0);
    expect(decision.evidence.en).toBeGreaterThanOrEqual(2);
    expect(decision.language).toBe('en');
    expect(decision.reason).toBe('detected-en');
    expect(decision.overridden).toBe(false);
  });

  it('keeps Portuguese at 0.82 when the words are Portuguese (loosening did not leak)', () => {
    // Same confidence as the EN probe: only the text differs. This is the
    // guard that stops the looser EN rule from becoming an EN leak.
    const decision = resolveDoorLanguage({
      detected: 'en',
      confidence: 0.82,
      text: 'Mara, esta aberto para a casa hoje?',
    });
    expect(decision.language).toBe('pt');
    expect(decision.reason).toBe('pt-evidence');
    expect(decision.overridden).toBe(true);
  });

  it('does not take a single borrowed English word as an English sentence', () => {
    const decision = resolveDoorLanguage({
      detected: 'en',
      confidence: 0.82,
      text: 'Mara, passa o briefing da casa hoje',
    });
    expect(decision.evidence.en).toBe(1);
    expect(decision.language).toBe('pt');
  });

  it('keeps Portuguese on a short sentence built from EN/PT homographs', () => {
    // "É só do meu filho": `so` and `do` score as EN markers but are also
    // Portuguese words. Two markers, no strong one — the door stays PT.
    const decision = resolveDoorLanguage({
      detected: 'en',
      confidence: 0.82,
      text: 'É só do meu filho',
    });
    expect(decision.evidence.en).toBe(2);
    expect(decision.language).toBe('pt');
  });

  it('treats an unmistakable verdict as enough even with one PT-looking token', () => {
    // "Da" in a name scores one PT marker; at 0.997 the provider is believed.
    const decision = resolveDoorLanguage({
      detected: 'en',
      confidence: 0.9979505,
      text: "Hello, Mara. I'm not sure if we... How much you can listen to me now.",
    });
    expect(decision.language).toBe('en');
  });

  it('never speaks a language the voice matrix cannot produce', () => {
    const decision = resolveDoorLanguage({ detected: 'ko', confidence: 0.40672937, text: '' });
    expect(decision.language).toBe('pt');
    expect(decision.reason).toBe('unsupported-detection');
    expect(decision.overridden).toBe(false);
  });

  it('honours an explicit caller pin over detection', () => {
    const asPt = resolveDoorLanguage({
      detected: 'en',
      confidence: 0.998,
      text: 'Mara, what is on the list today?',
      requested: 'pt',
    });
    expect(asPt.language).toBe('pt');
    expect(asPt.reason).toBe('requested');

    const asEn = resolveDoorLanguage({
      detected: 'pt',
      confidence: 0.999,
      text: 'Mara, me dá o briefing da casa hoje?',
      requested: 'en-US',
    });
    expect(asEn.language).toBe('en');
    expect(asEn.reason).toBe('requested');
  });

  it('treats `auto` as "no pin"', () => {
    const decision = resolveDoorLanguage({
      detected: 'pt',
      confidence: 0.999,
      text: 'bom dia',
      requested: 'auto',
    });
    expect(decision.reason).toBe('detected-pt');
  });

  it('stays Portuguese on a bare English detection with no words to judge', () => {
    const decision = resolveDoorLanguage({ detected: 'en', confidence: 0.99, text: '' });
    expect(decision.language).toBe('pt');
    expect(decision.overridden).toBe(true);
  });
});

describe('languageEvidence', () => {
  it('strips accents and splits on punctuation', () => {
    expect(tokenize('Mara, me dá o briefing da casa hoje?')).toEqual([
      'mara', 'me', 'da', 'o', 'briefing', 'da', 'casa', 'hoje',
    ]);
  });

  it('counts distinct markers, not repetitions', () => {
    const evidence = languageEvidence('para a casa, para a casa, para a casa');
    expect(evidence.ptTokens).toEqual(['para', 'casa']);
    expect(evidence.pt).toBe(2);
  });

  it('ignores short ambiguous forms that appear in both languages', () => {
    // "a", "e", "o", "me", "no", "um" are deliberately not PT markers.
    const evidence = languageEvidence('a e o me no um');
    expect(evidence.pt).toBe(0);
  });

  it('scores Portuguese diacritics as one extra marker', () => {
    const plain = languageEvidence('nao');
    const accented = languageEvidence('não');
    expect(accented.pt).toBe(plain.pt + 1);
  });
});

describe('sttLanguageFor — the STT pin', () => {
  it('leaves detection on when the caller names nothing', () => {
    expect(DOOR_STT_LANGUAGE).toBe('auto');
    expect(sttLanguageFor()).toBe('auto');
    expect(sttLanguageFor(null)).toBe('auto');
    expect(sttLanguageFor('  AUTO ')).toBe('auto');
  });

  it('passes an explicit caller tag through untouched', () => {
    expect(sttLanguageFor('en-US')).toBe('en-US');
    expect(sttLanguageFor('pt-BR')).toBe('pt-BR');
  });

  it('never pre-pins pt-BR, which would phonetically erase an English visitor', () => {
    expect(DOOR_STT_LANGUAGE).not.toMatch(/^pt/i);
    expect(DOOR_STT_LANGUAGE).not.toBe('en');
  });
});

describe('describeDoorLanguage', () => {
  it('names both sides of a disagreement for the log', () => {
    const line = describeDoorLanguage(
      resolveDoorLanguage({
        detected: 'en',
        confidence: 0.94,
        text: 'Esta aberto para a casa hoje',
      }),
    );
    expect(line).toContain('door language PT');
    expect(line).toContain('provider en');
    expect(line).toContain('reason pt-evidence');
  });
});
