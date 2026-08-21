/** Pure lane layout for the History graph column (lazygit-style).
 *
 *  Walks newest→oldest over an active-lane pool: each lane either waits for
 *  a specific sha (its next expected commit) or is free. A commit takes the
 *  lowest lane waiting on it (collapsing duplicates — merge joins), else the
 *  lowest free lane. Its first parent continues on that lane; extra parents
 *  claim free lanes (reusing one already waiting on the same sha), recorded
 *  in `mergeFromLanes` so the renderer can draw the join curves. */

export interface LaneCommit {
  sha: string;
  parents: string[];
  isHead?: boolean;
  /** Branch names whose tip is this sha. */
  branchHeads?: string[];
}

export interface LaidOutCommit {
  commit: LaneCommit;
  /** x-index of the commit's lane. */
  lane: number;
  /** Lanes assigned to parents[1..] (merge joins), aligned by index. */
  mergeFromLanes?: number[];
}

export function assignLanes(commits: LaneCommit[]): LaidOutCommit[] {
  const active: (string | undefined)[] = [];
  const out: LaidOutCommit[] = [];

  for (const c of commits) {
    let lane = active.findIndex((waiting) => waiting === c.sha);
    if (lane === -1) {
      lane = active.findIndex((waiting) => waiting === undefined);
      if (lane === -1) lane = active.length;
    } else {
      for (let i = lane + 1; i < active.length; i++) {
        if (active[i] === c.sha) active[i] = undefined;
      }
    }
    active[lane] = undefined;

    const mergeFromLanes: number[] = [];
    const [first, ...rest] = c.parents;
    if (first !== undefined) active[lane] = first;
    for (const p of rest) {
      let f = active.findIndex((w) => w === p);
      if (f === -1) {
        f = active.findIndex((w) => w === undefined);
        if (f === -1) f = active.length;
      }
      active[f] = p;
      mergeFromLanes.push(f);
    }

    out.push(mergeFromLanes.length ? { commit: c, lane, mergeFromLanes } : { commit: c, lane });
  }

  return out;
}
