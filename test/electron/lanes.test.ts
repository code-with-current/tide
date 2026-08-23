import { describe, it, expect } from 'vitest';
import { assignLanes, type LaneCommit } from '@/lib/git/lanes';

function lanesOf(commits: LaneCommit[]) {
  return assignLanes(commits).map((l) => l.lane);
}

function mergeFromOf(commits: LaneCommit[]) {
  return assignLanes(commits).map((l) => l.mergeFromLanes ?? []);
}

describe('assignLanes', () => {
  it('keeps linear history on a single lane', () => {
    const commits: LaneCommit[] = [
      { sha: 'c3', parents: ['c2'] },
      { sha: 'c2', parents: ['c1'] },
      { sha: 'c1', parents: [] },
    ];
    expect(lanesOf(commits)).toEqual([0, 0, 0]);
    expect(mergeFromOf(commits)).toEqual([[], [], []]);
  });

  it('puts a branch on lane 1 and merges back onto lane 0 with a curve', () => {
    const commits: LaneCommit[] = [
      { sha: 'M', parents: ['b2', 'd2'] },
      { sha: 'b2', parents: ['b1'] },
      { sha: 'd2', parents: ['b1'] },
      { sha: 'b1', parents: ['a'] },
      { sha: 'a', parents: [] },
    ];
    expect(lanesOf(commits)).toEqual([0, 0, 1, 0, 0]);
    expect(mergeFromOf(commits)[0]).toEqual([1]);
  });

  it('reuses the freed lane for a second sequential branch', () => {
    const commits: LaneCommit[] = [
      { sha: 'M2', parents: ['M1', 'e2'] },
      { sha: 'e2', parents: ['M1'] },
      { sha: 'M1', parents: ['b2', 'd2'] },
      { sha: 'd2', parents: ['c'] },
      { sha: 'b2', parents: ['c'] },
      { sha: 'c', parents: ['a'] },
      { sha: 'a', parents: [] },
    ];
    expect(lanesOf(commits)).toEqual([0, 1, 0, 1, 0, 0, 0]);
    expect(mergeFromOf(commits)[0]).toEqual([1]);
    expect(mergeFromOf(commits)[2]).toEqual([1]);
  });

  it('keeps concurrent branches on distinct lanes', () => {
    const commits: LaneCommit[] = [
      { sha: 'M2', parents: ['M1', 'e2'] },
      { sha: 'M1', parents: ['b2', 'd2'] },
      { sha: 'b2', parents: ['c'] },
      { sha: 'd2', parents: ['c'] },
      { sha: 'e2', parents: ['c'] },
      { sha: 'c', parents: ['a'] },
      { sha: 'a', parents: [] },
    ];
    expect(lanesOf(commits)).toEqual([0, 0, 0, 2, 1, 0, 0]);
    expect(mergeFromOf(commits)[0]).toEqual([1]);
    expect(mergeFromOf(commits)[1]).toEqual([2]);
  });

  it('handles the initial commit (no parents) and unseen parents beyond the window', () => {
    const commits: LaneCommit[] = [
      { sha: 'c2', parents: ['c1'] },
      { sha: 'c1', parents: ['x'] },
    ];
    expect(lanesOf(commits)).toEqual([0, 0]);
    expect(() => assignLanes([{ sha: 'solo', parents: [] }])).not.toThrow();
    expect(lanesOf([{ sha: 'solo', parents: [] }])).toEqual([0]);
  });

  it('gives orphan roots in one list their own lanes', () => {
    const commits: LaneCommit[] = [
      { sha: 'm', parents: ['x', 'y'] },
      { sha: 'x', parents: [] },
      { sha: 'y', parents: [] },
    ];
    expect(lanesOf(commits)).toEqual([0, 0, 1]);
  });

  it('assigns one lane per extra parent for octopus merges', () => {
    const commits: LaneCommit[] = [
      { sha: 'O', parents: ['p1', 'p2', 'p3'] },
      { sha: 'p1', parents: ['r'] },
      { sha: 'p2', parents: ['r'] },
      { sha: 'p3', parents: ['r'] },
      { sha: 'r', parents: [] },
    ];
    expect(lanesOf(commits)).toEqual([0, 0, 1, 2, 0]);
    expect(mergeFromOf(commits)[0]).toEqual([1, 2]);
  });

  it('returns commits in input order carrying the original commit', () => {
    const commits: LaneCommit[] = [
      { sha: 'c1', parents: [], isHead: true, branchHeads: ['main'] },
    ];
    const out = assignLanes(commits);
    expect(out).toHaveLength(1);
    expect(out[0].commit).toBe(commits[0]);
    expect(out[0].lane).toBe(0);
    expect(out[0].mergeFromLanes).toBeUndefined();
  });

  it('reuses a lane already waiting on the same parent for a later merge', () => {
    const commits: LaneCommit[] = [
      { sha: 'N', parents: ['M', 'b'] },
      { sha: 'M', parents: ['a', 'b'] },
      { sha: 'b', parents: ['r'] },
      { sha: 'a', parents: ['r'] },
      { sha: 'r', parents: [] },
    ];
    const laid = assignLanes(commits);
    expect(laid.map((l) => l.lane)).toEqual([0, 0, 1, 0, 0]);
    expect(laid[0].mergeFromLanes).toEqual([1]);
    expect(laid[1].mergeFromLanes).toEqual([1]);
  });
});
