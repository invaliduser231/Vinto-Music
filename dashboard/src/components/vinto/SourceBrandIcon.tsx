'use client';

import { sourceBrandColor, sourceBrandIconUrl, sourceBrandLabel } from '@/lib/source-brand';

export function SourceBrandIcon({ source }: { source: string | null | undefined }) {
  const iconUrl = sourceBrandIconUrl(source);
  if (!iconUrl) return null;

  return (
    <span
      className="vinto-source-badge"
      style={{ background: sourceBrandColor(source) }}
      title={sourceBrandLabel(source)}
    >
      <img src={iconUrl} alt="" className="vinto-source-icon" />
    </span>
  );
}
