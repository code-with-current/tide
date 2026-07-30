import { useEffect, useState } from 'react';
import { AsciiSpinner } from '@/components/AsciiSpinner';
import { cn } from '@/lib/utils';

/**
 * "Vibe words" — the rotating playful verbs that show next to the spinner
 * while the assistant is working. Same convention as Claude Code's status
 * line and Copilot's loading state. The list is intentionally goofy: it
 * humanizes the wait without making promises about what's happening.
 *
 * Words rotate on a ~1.6s cadence, picked at random (no repeats back-to-back).
 */
const VIBE_WORDS = [
  'Accomplishing', 'Elucidating', 'Perusing',
  'Actioning', 'Enchanting', 'Philosophising',
  'Actualizing', 'Envisioning', 'Pondering',
  'Baking', 'Finagling', 'Pontificating',
  'Booping', 'Flibbertigibbeting', 'Processing',
  'Brewing', 'Forging', 'Puttering',
  'Calculating', 'Forming', 'Puzzling',
  'Cerebrating', 'Frolicking', 'Reticulating',
  'Channelling', 'Generating', 'Ruminating',
  'Churning', 'Germinating', 'Scheming',
  'Clauding', 'Hatching', 'Schlepping',
  'Coalescing', 'Herding', 'Shimmying',
  'Cogitating', 'Honking', 'Shucking',
  'Combobulating', 'Hustling', 'Simmering',
  'Computing', 'Ideating', 'Smooshing',
  'Concocting', 'Imagining', 'Spelunking',
  'Conjuring', 'Incubating', 'Spinning',
  'Considering', 'Inferring', 'Stewing',
  'Contemplating', 'Jiving', 'Sussing',
  'Cooking', 'Manifesting', 'Synthesizing',
  'Crafting', 'Marinating', 'Thinking',
  'Creating', 'Meandering', 'Tinkering',
  'Crunching', 'Moseying', 'Transmuting',
  'Deciphering', 'Mulling', 'Unfurling',
  'Deliberating', 'Mustering', 'Unravelling',
  'Determining', 'Musing', 'Vibing',
  'Discombobulating', 'Noodling', 'Wandering',
  'Divining', 'Percolating', 'Whirring',
  'Doing', 'Wibbling',
  'Effecting', 'Wizarding',
  'Working',
  'Wrangling',
];

function randomWord(exclude?: string): string {
  // Pick a random word, avoiding an immediate repeat of `exclude`.
  if (VIBE_WORDS.length <= 1) return VIBE_WORDS[0];
  let next = exclude;
  let tries = 0;
  while (next === exclude && tries < 8) {
    next = VIBE_WORDS[Math.floor(Math.random() * VIBE_WORDS.length)];
    tries++;
  }
  return next ?? VIBE_WORDS[0];
}

/**
 * Braille spinner + rotating vibe word. Mounts its own timer; cleans up on
 * unmount. Use anywhere the assistant is "doing work" and you want a
 * playful, low-key indicator.
 */
export function VibeSpinner({
  intervalMs = 1600,
  className,
}: {
  intervalMs?: number;
  className?: string;
}) {
  const [word, setWord] = useState<string>(() => randomWord());

  useEffect(() => {
    const t = setInterval(() => setWord((prev) => randomWord(prev)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);

  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs text-muted-foreground/60', className)}>
      <AsciiSpinner />
      <span className="font-mono">{word}</span>
    </span>
  );
}
