/** Recover a valid JSON object from a model's malformed tool-call input.
 *  Streaming models occasionally emit duplicated or interleaved fragments
 *  before the final clean object (seen with GLM), so scan for top-level
 *  balanced objects and prefer the LAST parseable one — the model's latest
 *  attempt. Returns null when nothing recovers. */

export function repairJsonToolInput(raw: string): string | null {
  const cleaned = raw
    .replace(/<\/?tool_call>/g, '')
    .replace(/<\/?tool_use>/g, '')
    .replace(/<\/?function_call>/g, '')
    .trim();
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {}
  const objects = topLevelObjects(cleaned);
  for (let i = objects.length - 1; i >= 0; i--) {
    try {
      JSON.parse(objects[i]);
      return objects[i];
    } catch {}
  }
  const greedy = cleaned.match(/\{[\s\S]*\}/);
  if (greedy) {
    try {
      JSON.parse(greedy[0]);
      return greedy[0];
    } catch {}
  }
  return null;
}

/** All top-level balanced {...} substrings, brace-aware and string-aware. */
function topLevelObjects(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr && c === '\\') {
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) out.push(s.slice(start, i + 1));
      }
    }
  }
  return out;
}
