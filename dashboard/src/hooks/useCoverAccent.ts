'use client';

import { useEffect, useState } from 'react';

const DEFAULT_ACCENT = '#ff2d78';
const SAMPLE_SIZE = 24;

function toCss(r: number, g: number, b: number) {
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

function boostSaturation(r: number, g: number, b: number) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max <= 0) return [r, g, b] as const;

  const lift = max < 90 ? 90 / Math.max(1, max) : 1;
  const scaled = [r * lift, g * lift, b * lift] as const;
  const mid = (Math.max(...scaled) + Math.min(...scaled)) / 2;
  const saturation = max === min ? 0 : 1;
  const factor = saturation === 0 ? 1 : 1.25;
  return [
    Math.min(255, mid + ((scaled[0] - mid) * factor)),
    Math.min(255, mid + ((scaled[1] - mid) * factor)),
    Math.min(255, mid + ((scaled[2] - mid) * factor)),
  ] as const;
}

export function useCoverAccent(coverUrl: string | null | undefined): string {
  const [accent, setAccent] = useState(DEFAULT_ACCENT);

  useEffect(() => {
    const url = String(coverUrl ?? '').trim();
    if (!url || typeof window === 'undefined') {
      setAccent(DEFAULT_ACCENT);
      return undefined;
    }

    let cancelled = false;
    const image = new Image();
    image.crossOrigin = 'anonymous';

    image.onload = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = SAMPLE_SIZE;
        canvas.height = SAMPLE_SIZE;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return;
        context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
        const { data } = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

        let bestScore = -1;
        let best: readonly [number, number, number] = [255, 45, 120];
        let totalR = 0;
        let totalG = 0;
        let totalB = 0;
        let counted = 0;

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i] ?? 0;
          const g = data[i + 1] ?? 0;
          const b = data[i + 2] ?? 0;
          const alpha = data[i + 3] ?? 0;
          if (alpha < 200) continue;
          totalR += r;
          totalG += g;
          totalB += b;
          counted += 1;

          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const luminance = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
          if (luminance < 30 || luminance > 232) continue;
          const score = (max - min) + (luminance * 0.15);
          if (score > bestScore) {
            bestScore = score;
            best = [r, g, b];
          }
        }

        if (bestScore < 0 && counted > 0) {
          best = [totalR / counted, totalG / counted, totalB / counted];
        }

        const [r, g, b] = boostSaturation(best[0], best[1], best[2]);
        if (!cancelled) setAccent(toCss(r, g, b));
      } catch {
        if (!cancelled) setAccent(DEFAULT_ACCENT);
      }
    };

    image.onerror = () => {
      if (!cancelled) setAccent(DEFAULT_ACCENT);
    };

    image.src = url;

    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [coverUrl]);

  return accent;
}
