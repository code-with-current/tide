import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Braille-dot ASCII spinner. Cycles through 10 frames at ~12fps.
 * Pairs with `.ascii-spinner` CSS (color + monospace + 1ch width) so the
 * layout doesn't shift as the glyph changes.
 */
export function AsciiSpinner({
  className,
  frameMs = 80,
}: {
  className?: string;
  frameMs?: number;
}) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % FRAMES.length), frameMs);
    return () => clearInterval(t);
  }, [frameMs]);

  return <span className={cn('ascii-spinner', className)}>{FRAMES[i]}</span>;
}
