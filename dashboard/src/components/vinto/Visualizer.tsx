'use client';

import { memo, useEffect, useRef } from 'react';
import { SPECTRUM_BANDS, type SpectrumStore } from '@/lib/spectrum-store';
import { computeBarGeometry } from '@/lib/visualizer-geometry';

export const Visualizer = memo(function Visualizer({
  store,
  accent,
}: {
  store: SpectrumStore;
  accent: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const accentRef = useRef(accent);
  accentRef.current = accent;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext('2d');
    if (!context) return undefined;

    let frame = 0;
    let previous = performance.now();
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const resize = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!width || !height) return;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const draw = (now: number) => {
      const delta = Math.min(0.1, (now - previous) / 1000);
      previous = now;
      store.advance(delta);

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const geometry = computeBarGeometry(width, SPECTRUM_BANDS, 3);
      if (!geometry || height <= 0) {
        frame = window.requestAnimationFrame(draw);
        return;
      }

      context.clearRect(0, 0, width, height);
      const values = store.read();
      const { barWidth, gap, radius } = geometry;
      context.fillStyle = accentRef.current;

      for (let i = 0; i < SPECTRUM_BANDS; i += 1) {
        const level = values[i] ?? 0;
        const barHeight = Math.max(2, Math.min(height, level * height));
        const x = i * (barWidth + gap);
        const y = height - barHeight;
        context.globalAlpha = 0.22 + (level * 0.55);
        context.beginPath();
        context.roundRect(x, y, barWidth, barHeight, radius);
        context.fill();
      }
      context.globalAlpha = 1;

      frame = window.requestAnimationFrame(draw);
    };

    if (reduceMotion) {
      context.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    } else {
      frame = window.requestAnimationFrame(draw);
    }

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [store]);

  return <canvas ref={canvasRef} className="vinto-visualizer" aria-hidden="true" />;
});
