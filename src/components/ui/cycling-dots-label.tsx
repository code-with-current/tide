/** Cycles "Label." → "Label.." → "Label..." every 500ms — the streaming
 *  reasoning-header animation (Tide-native, user request). Shared by the
 *  timeline ReasoningPart, the legacy ThinkingBlock, and the Agents
 *  panel's stream view so the animation language matches everywhere. */

import { useEffect, useState, type CSSProperties } from 'react';
import { cn } from '@/lib/utils';

const DOT_INTERVAL_MS = 500;

export function CyclingDotsLabel({
  label,
  className,
  style,
}: {
  label: string;
  className?: string;
  style?: CSSProperties;
}) {
  const [dotCount, setDotCount] = useState(1);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const id = window.setInterval(() => {
      setDotCount((count) => (count % 3) + 1);
    }, DOT_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <span className={cn(className)} style={style}>
      {label}
      {'.'.repeat(dotCount)}
    </span>
  );
}
