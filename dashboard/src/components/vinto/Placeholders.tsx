'use client';

import type { ReactNode } from 'react';

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="vinto-empty-state">
      {icon}
      <strong>{title}</strong>
      {hint ? <span>{hint}</span> : null}
      {action}
    </div>
  );
}

export function SkeletonStack({ rows = 4, tall = false }: { rows?: number; tall?: boolean }) {
  return (
    <div className="vinto-skeleton-stack" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={`vinto-skeleton${tall ? ' tall' : ''}`} />
      ))}
    </div>
  );
}
