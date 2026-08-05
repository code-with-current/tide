import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Braille-dot ASCII spinner: cycles 10 frames at ~12fps; pairs with `.ascii-spinner` CSS (1ch width, no layout shift). */
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
