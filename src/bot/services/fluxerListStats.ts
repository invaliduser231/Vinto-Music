export interface FluxerListStatsPush {
  apiBase: string;
  botId: string;
  apiKey: string;
  guildCount: number;
}

export async function pushFluxerListStats(opts: FluxerListStatsPush, fetchImpl: typeof fetch = fetch): Promise<void> {
  const url = `${opts.apiBase}/api/v1/bots/${encodeURIComponent(opts.botId)}/stats`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ serverCount: opts.guildCount }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`FluxerList stats push failed: ${res.status} ${res.statusText}`);
  }
}
