type SearchSelectionContext = {
  guildId?: string | null;
  authorId?: string | null;
  config: {
    searchPickTimeoutMs?: number;
  };
};

const pendingSearchSelections = new Map<string, { tracks: unknown[]; expiresAt: number }>();

function searchSelectionKey(ctx: SearchSelectionContext) {
  const guildId = String(ctx.guildId ?? '');
  const userId = String(ctx.authorId ?? '');
  return `${guildId}:${userId}`;
}

export function saveSearchSelection(ctx: SearchSelectionContext, tracks: unknown[]) {
  const key = searchSelectionKey(ctx);
  const ttl = Math.max(5_000, Number.parseInt(String(ctx.config.searchPickTimeoutMs ?? 45_000), 10) || 45_000);
  const now = Date.now();

  pendingSearchSelections.set(key, {
    tracks,
    expiresAt: now + ttl,
  });

  if (pendingSearchSelections.size > 10_000) {
    for (const [entryKey, entry] of pendingSearchSelections.entries()) {
      if (entry.expiresAt <= now) {
        pendingSearchSelections.delete(entryKey);
      }
    }
  }

  return ttl;
}

export function consumeSearchSelection(ctx: SearchSelectionContext) {
  const key = searchSelectionKey(ctx);
  const entry = pendingSearchSelections.get(key);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    pendingSearchSelections.delete(key);
    return null;
  }

  return entry.tracks;
}

export function clearSearchSelection(ctx: SearchSelectionContext) {
  pendingSearchSelections.delete(searchSelectionKey(ctx));
}


