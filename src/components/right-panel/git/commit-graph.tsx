/** SVG lane graph rendered as one tall column behind the virtualized History
 *  rows. Rows are transparent for the first 64px so this graph shows through;
 *  keeping it a single absolute svg (instead of per-row slices) means
 *  virtualization never cuts edges mid-curve. */
import { memo } from 'react';
import type { LaidOutCommit } from '@/lib/git/lanes';

export const GRAPH_WIDTH = 64;
export const ROW_H = 24;
const LANE_X0 = 14;
const LANE_DX = 9;
const MAX_LANE = 5;

export const LANE_COLORS = ['#7aa2f7', '#bb9af7', '#9ece6a', '#e0af68', '#f7768e', '#7dcfff'];

function laneX(lane: number) {
  return LANE_X0 + Math.min(lane, MAX_LANE) * LANE_DX;
}

/** Path for one parent edge: from the child's dot down to the parent's dot.
 *  Straight when both sit on the edge's lane; otherwise a bezier split just
 *  below the child and a bezier join just above the parent. `toBottom` is
 *  used when the parent lies beyond the fetched window. */
function edgePath(
  childLane: number,
  edgeLane: number,
  yChild: number,
  parent: { y: number; lane: number } | null,
  bottom: number,
): string {
  const xs = laneX(childLane);
  const xe = laneX(edgeLane);
  if (!parent) {
    const endY = Math.min(yChild + ROW_H, bottom);
    if (edgeLane === childLane) return `M${xs},${yChild} L${xs},${bottom}`;
    return `M${xs},${yChild} C${xs},${(yChild + endY) / 2} ${xe},${(yChild + endY) / 2} ${xe},${endY} L${xe},${bottom}`;
  }
  const yParent = parent.y;
  const parentLaneX = laneX(parent.lane);
  if (edgeLane === childLane && parent.lane === edgeLane) {
    return `M${xs},${yChild} L${xs},${yParent}`;
  }
  const splitY = Math.min(yChild + ROW_H, yParent);
  const joinY = Math.max(yParent - ROW_H, splitY);
  let d = `M${xs},${yChild}`;
  if (edgeLane !== childLane) {
    d += ` C${xs},${(yChild + splitY) / 2} ${xe},${(yChild + splitY) / 2} ${xe},${splitY}`;
  }
  if (parent.lane === edgeLane) {
    d += ` L${xe},${yParent}`;
  } else {
    d += ` L${xe},${joinY} C${xe},${(joinY + yParent) / 2} ${parentLaneX},${(joinY + yParent) / 2} ${parentLaneX},${yParent}`;
  }
  return d;
}

export function GraphColumnBase({ commits, height }: { commits: LaidOutCommit[]; height: number }) {
  const rowIndex = new Map(commits.map((l, i) => [l.commit.sha, i]));
  const edges: { d: string; color: string }[] = [];
  const dots: { cx: number; cy: number; r: number; color: string }[] = [];

  commits.forEach((laid, i) => {
    const y = i * ROW_H + ROW_H / 2;
    const color = LANE_COLORS[laid.lane % LANE_COLORS.length];
    const { commit } = laid;
    commit.parents.forEach((p, pi) => {
      const edgeLane = pi === 0 ? laid.lane : laid.mergeFromLanes?.[pi - 1] ?? laid.lane;
      const k = rowIndex.get(p);
      const parent = k === undefined ? null : { y: k * ROW_H + ROW_H / 2, lane: commits[k].lane };
      edges.push({
        d: edgePath(laid.lane, edgeLane, y, parent, height),
        color: LANE_COLORS[edgeLane % LANE_COLORS.length],
      });
    });
    const isTip = commit.isHead || (commit.branchHeads?.length ?? 0) > 0;
    dots.push({ cx: laneX(laid.lane), cy: y, r: isTip ? 4.5 : 3, color });
  });

  return (
    <svg
      className="pointer-events-none absolute left-0 top-0"
      width={GRAPH_WIDTH}
      height={Math.max(height, 1)}
      aria-hidden
    >
      {edges.map((e, i) => (
        <path key={i} d={e.d} fill="none" stroke={e.color} strokeWidth={1.5} opacity={0.85} />
      ))}
      {dots.map((d, i) => (
        <circle key={i} cx={d.cx} cy={d.cy} r={d.r} fill={d.color} stroke="var(--background)" strokeWidth={1.5} />
      ))}
    </svg>
  );
}

export const GraphColumn = memo(GraphColumnBase);
