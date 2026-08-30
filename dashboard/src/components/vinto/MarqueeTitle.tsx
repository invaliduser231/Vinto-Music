'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';

export function MarqueeTitle({ text }: { text: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    const inner = innerRef.current;
    if (!container || !inner) return undefined;

    const measure = () => {
      const overflow = inner.scrollWidth - container.clientWidth;
      setShift(overflow > 8 ? -overflow : 0);
    };
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [text]);

  return (
    <div
      ref={containerRef}
      className={`vinto-track-title${shift ? ' overflowing' : ''}`}
      title={text}
      style={{ '--marquee-shift': `${shift}px` } as CSSProperties}
    >
      <span ref={innerRef}>{text}</span>
    </div>
  );
}
