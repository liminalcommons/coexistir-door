/**
 * useVoiceNameClaims — fetch + cache claims for one voiceKey.
 *
 * Cache: module-level Map with a 30s TTL so a gallery of stranger tiles
 * doesn't stampede GET /api/voice-name-claims. `refresh()` bypasses it
 * (used right after filing).
 *
 * Filing a claim happens in ONE component (the dialog) while the chip is
 * rendered by ANOTHER (the tile overlay). `invalidateVoiceClaims(voiceKey)`
 * clears the cached rows and wakes every mounted hook for that key, so the
 * tile chip flips to the unverified claim immediately instead of waiting for
 * a remount.
 */
import { useEffect, useState, useCallback } from 'react';
import { listVoiceNameClaims } from './voiceNameClaimsApi';
import type { VoiceNameClaimView } from './voiceIdentityUtils';

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  claims: VoiceNameClaimView[];
  at: number;
}

const claimsCache = new Map<string, CacheEntry>();

/** voiceKey -> mounted hooks that want a refetch when that key changes. */
const claimSubscribers = new Map<string, Set<() => void>>();

export function __clearVoiceClaimsCacheForTests(): void {
  claimsCache.clear();
  claimSubscribers.clear();
}

/**
 * Drop cached rows for a voiceKey and refetch in every mounted hook using it.
 * Call after a claim is filed/confirmed — claims are per-voice, not per-view.
 */
export function invalidateVoiceClaims(voiceKey: string | null | undefined): void {
  if (!voiceKey) return;
  claimsCache.delete(voiceKey);
  claimSubscribers.get(voiceKey)?.forEach((fn) => fn());
}

export function useVoiceNameClaims(voiceKey: string | null): {
  claims: VoiceNameClaimView[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [claims, setClaims] = useState<VoiceNameClaimView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!voiceKey) {
      setClaims([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const rows = await listVoiceNameClaims(voiceKey);
      claimsCache.set(voiceKey, { claims: rows, at: Date.now() });
      setClaims(rows);
    } catch (e) {
      setError((e as Error)?.message || 'failed to load claims');
    } finally {
      setLoading(false);
    }
  }, [voiceKey]);

  useEffect(() => {
    if (!voiceKey) {
      setClaims([]);
      setLoading(false);
      return;
    }
    const cached = claimsCache.get(voiceKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      setClaims(cached.claims);
      setLoading(false);
    } else {
      void refresh();
    }
    const listener = () => {
      void refresh();
    };
    const set = claimSubscribers.get(voiceKey) ?? new Set<() => void>();
    set.add(listener);
    claimSubscribers.set(voiceKey, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) claimSubscribers.delete(voiceKey);
    };
  }, [voiceKey, refresh]);

  return { claims, loading, error, refresh };
}
