/**
 * voiceProfiles — the single source of truth for who speaks in what voice.
 *
 * Extracted from `routes/ttsRoutes.ts` so the buffered `/api/tts/preview` path
 * and the streaming `/api/coexistir/voice/stream` path cannot drift: both
 * resolve an (agentId, language) pair through the same table and the same
 * rules.
 *
 * Language rule (learned the hard way):
 * - Deepgram Flux models encode the language IN THE MODEL ID (`flux-mariana-pt`);
 *   `/v2/speak` rejects a `language` query param with 400 INVALID_QUERY_PARAMETER,
 *   so language must be resolved server-side to a model, never forwarded.
 * - Cartesia takes `language` in the request body, so it gets the profile value
 *   instead of the previous hardcoded 'en'.
 */

export type VoiceProvider = 'inworld' | 'elevenlabs' | 'deepgram' | 'cartesia';

/** One voice that can speak one language. */
export interface VoiceVariant {
  provider: VoiceProvider;
  voiceId: string;
  modelId: string;
}

/** Pre-configured agent voice, with the language(s) it can actually speak. */
export interface AgentVoiceProfile extends VoiceVariant {
  language: string;
  languages?: string[];
  languageVoices?: Record<string, VoiceVariant>;
  voiceName?: string;
}

/** Inline voice config a caller may send instead of an agent profile. */
export interface VoiceConfig {
  enabled: boolean;
  provider: VoiceProvider;
  voiceId: string;
  modelId?: string;
  language?: string;
  inworldApiKey?: string;
}

// Pre-configured voice profiles for known agents.
//
// Every profile carries the language its voice actually speaks (`language`).
// An agent that can speak more than one language lists them in `languages` and
// maps each one to a voice variant in `languageVoices` — the request's language
// is resolved to a variant on the server, because Deepgram Flux encodes the
// language inside the model id and refuses a `language` parameter.
export const AGENT_VOICE_PROFILES: Record<string, AgentVoiceProfile> = {
  'daniel-schmachtenberger': {
    provider: 'cartesia',
    voiceId: '2c45c108-e9e4-4f82-8410-fd7e7b1bef02', // Daniel Schmachtenberger cloned voice
    modelId: 'sonic-3',
    language: 'en',
  },
  'alexander-bard': {
    provider: 'cartesia',
    voiceId: '79a125e8-cd45-4c13-8a67-188112f4dd22', // British voice placeholder
    modelId: 'sonic-3',
    language: 'en',
  },
  'jim-rutt': {
    provider: 'cartesia',
    voiceId: 'ee7ea9f8-c0c1-498c-9f62-dc2571ec3b5e', // Wise Man voice
    modelId: 'sonic-3',
    language: 'en',
  },
  // Simulation voices using Deepgram Aura (cheap & fast)
  'elena': {
    provider: 'deepgram',
    voiceId: 'aura-athena-en', // Female, warm
    modelId: 'aura',
    language: 'en',
  },
  'marcus': {
    provider: 'deepgram',
    voiceId: 'aura-orion-en', // Male, deep
    modelId: 'aura',
    language: 'en',
  },
  'yuki': {
    provider: 'deepgram',
    voiceId: 'aura-luna-en', // Female, soft
    modelId: 'aura',
    language: 'en',
  },
  // Coexistir front-door manager — bilingual household.
  // PT-BR: Deepgram Flux Mariana (settled voice, `/v2/speak?model=flux-mariana-pt`).
  // EN: Deepgram Aura Thalia on `/v1/speak` — functional placeholder until the
  // owner picks an English voice; Flux English models are not available on this
  // project (v2/speak rejects every `flux-*-en` id).
  'coexistir-manager': {
    provider: 'deepgram',
    voiceId: 'mariana',
    modelId: 'flux-mariana-pt',
    language: 'pt-BR',
    languages: ['pt-BR', 'en'],
    voiceName: 'Mariana',
    languageVoices: {
      'pt-BR': { provider: 'deepgram', voiceId: 'mariana', modelId: 'flux-mariana-pt' },
      'en': { provider: 'deepgram', voiceId: 'aura-2-thalia-en', modelId: 'aura-2-thalia-en' },
    },
  },
};

// Aliases so callers can ask for the room or the voice by name.
AGENT_VOICE_PROFILES['coexistir'] = AGENT_VOICE_PROFILES['coexistir-manager'];
AGENT_VOICE_PROFILES['mariana'] = AGENT_VOICE_PROFILES['coexistir-manager'];

/** Lowercase, `_` -> `-`; 'pt_br' / 'PT-BR' / 'pt-BR' all become 'pt-br'. */
export function normalizeLanguageTag(tag: string | undefined | null): string | undefined {
  if (!tag || typeof tag !== 'string') return undefined;
  const cleaned = tag.trim().toLowerCase().replace(/_/g, '-');
  if (!cleaned) return undefined;
  return cleaned;
}

/** Base subtag: 'pt-br' -> 'pt', 'en-us' -> 'en'. */
export function baseLanguage(tag: string): string {
  return tag.split('-')[0];
}

/**
 * Find a variant for `tag` (exact match first, then base-language match).
 * Returns the language as written in the profile so responses keep canonical
 * casing ('pt-BR', not 'pt-br').
 */
export function findLanguageVoice(
  map: Record<string, VoiceVariant> | undefined,
  tag: string,
): { variant: VoiceVariant; language: string } | undefined {
  if (!map) return undefined;
  const keys = Object.keys(map);
  const direct = keys.find((k) => normalizeLanguageTag(k) === tag);
  if (direct) return { variant: map[direct], language: direct };
  const base = baseLanguage(tag);
  const byBase = keys.find((k) => baseLanguage(normalizeLanguageTag(k) || '') === base);
  return byBase ? { variant: map[byBase], language: byBase } : undefined;
}

export type VoiceResolution =
  | { ok: true; variant: VoiceVariant; language: string; fallback: boolean }
  | { ok: false; requested: string; supported: string[] };

/**
 * Resolve the voice variant for a requested language.
 *
 * - No request language  -> the profile's default voice.
 * - Requested + mapped   -> that language's variant.
 * - Requested, unmapped  -> the default voice ONLY if it speaks a language
 *                           sharing the base tag (e.g. 'pt' vs 'pt-BR');
 *                           otherwise `ok: false` so the caller can answer 422
 *                           instead of shipping mispronounced audio.
 */
export function resolveVoiceForLanguage(
  profile: AgentVoiceProfile,
  requestedLanguage?: string,
): VoiceResolution {
  const requested = normalizeLanguageTag(requestedLanguage);
  const defaultLanguage = normalizeLanguageTag(profile.language) || 'en';

  if (!requested) {
    const found = findLanguageVoice(profile.languageVoices, defaultLanguage);
    if (found) return { ok: true, variant: found.variant, language: found.language, fallback: false };
    return { ok: true, variant: profile, language: profile.language, fallback: false };
  }

  const found = findLanguageVoice(profile.languageVoices, requested);
  if (found) {
    return { ok: true, variant: found.variant, language: found.language, fallback: false };
  }

  if (baseLanguage(requested) === baseLanguage(defaultLanguage)) {
    return { ok: true, variant: profile, language: profile.language, fallback: requested !== defaultLanguage };
  }

  const supported = profile.languages
    ? [...profile.languages]
    : Object.keys(profile.languageVoices || {});
  return { ok: false, requested: (requestedLanguage || '').trim() || requested, supported };
}

/**
 * Pick the Deepgram model id to request.
 *
 * Profiles written before Flux used friendly aliases (`modelId: 'aura'`) with a
 * real model id in `voiceId`, so a real model id must look like one: `flux-*` or
 * `aura-*`. Anything else falls back to the voice id, then to Aura's default.
 */
export function deepgramModelId(config: VoiceConfig | VoiceVariant): string {
  const looksReal = (value?: string) => !!value && /^(flux|aura)[-.]/.test(value);
  if (looksReal(config.modelId)) return config.modelId as string;
  if (looksReal(config.voiceId)) return config.voiceId;
  return config.voiceId || config.modelId || 'aura-asteria-en';
}

/**
 * Deepgram speaks two ways:
 * - `flux-*` (e.g. `flux-mariana-pt`) -> POST /v2/speak. Language lives in the
 *   model id; adding `?language=` is a 400 INVALID_QUERY_PARAMETER.
 * - everything else (Aura, `aura-2-thalia-en`) -> POST /v1/speak.
 */
export function deepgramEndpointFor(model: string): { url: string; flux: boolean } {
  const flux = model.startsWith('flux-');
  const version = flux ? 'v2' : 'v1';
  return {
    url: `https://api.deepgram.com/${version}/speak?model=${encodeURIComponent(model)}`,
    flux,
  };
}
