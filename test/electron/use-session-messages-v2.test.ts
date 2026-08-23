import { describe, expect, it } from 'vitest';
import { mergeSessionWindow } from '@/hooks/use-session-messages-v2';
import type { MessageWithPartsV2, PartV2 } from '@/types/session-v2';

function msg(id: string, parts: PartV2[] = [], role = 'user'): MessageWithPartsV2 {
  return { id, role, model: null, timeCreated: 1, timeCompleted: null, parts };
}

function part(id: string, seq: number): PartV2 {
  return { id, seq, kind: 'text', data: { text: id } };
}

const ownerIn =
  (owners: Record<string, string>) =>
  (partId: string): string | undefined =>
    owners[partId];

describe('mergeSessionWindow', () => {
  it('flips newest-first pages to full ascending order (pages are ascending internally)', () => {
    // pages[0] is the newest window: [m3, m4]; pages[1] is older: [m1, m2]
    const out = mergeSessionWindow(
      [
        { messages: [msg('m3'), msg('m4')] },
        { messages: [msg('m1'), msg('m2')] },
      ],
      [],
      ownerIn({}),
    );
    expect(out.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('appends committed parts onto an existing message in the window', () => {
    const p1 = part('p1', 1);
    const out = mergeSessionWindow([{ messages: [msg('m1', [part('p0', 0)])] }], [p1], ownerIn({ p1: 'm1' }));
    expect(out).toHaveLength(1);
    expect(out[0].parts.map((p) => p.id)).toEqual(['p0', 'p1']);
  });

  it('shells an unknown messageId as a newest assistant message at the end', () => {
    const p1 = part('p1', 1);
    const p2 = part('p2', 2);
    const out = mergeSessionWindow([{ messages: [msg('m1')] }], [p1, p2], ownerIn({ p1: 'm-live', p2: 'm-live' }));
    expect(out.map((m) => m.id)).toEqual(['m1', 'm-live']);
    expect(out[1].role).toBe('assistant');
    expect(out[1].parts.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('skips parts the fetched window already has — the fetch/replay overlap after a switch-back', () => {
    const p1 = part('p1', 1);
    const out = mergeSessionWindow([{ messages: [msg('m1', [p1])] }], [p1], ownerIn({ p1: 'm1' }));
    expect(out[0].parts.map((p) => p.id)).toEqual(['p1']);
  });

  it('skips committed parts with no owner mapping', () => {
    const out = mergeSessionWindow([{ messages: [msg('m1')] }], [part('p1', 1)], ownerIn({}));
    expect(out).toHaveLength(1);
    expect(out[0].parts).toHaveLength(0);
  });

  it('never mutates the fetched pages or the committed list', () => {
    const pages = [{ messages: [msg('m1', [part('p0', 0)])] }];
    Object.freeze(pages[0].messages[0].parts);
    Object.freeze(pages[0].messages[0]);
    Object.freeze(pages[0].messages);
    Object.freeze(pages);
    const committed: PartV2[] = [part('p1', 1)];
    Object.freeze(committed);
    const out = mergeSessionWindow(pages, committed, ownerIn({ p1: 'm1' }));
    expect(out[0].parts.map((p) => p.id)).toEqual(['p0', 'p1']);
    expect(pages[0].messages[0].parts).toHaveLength(1);
  });

  it('returns an empty array for no pages and no commits (ref-stable empty path)', () => {
    expect(mergeSessionWindow([], [], ownerIn({}))).toEqual([]);
  });

  it('shells committed parts with no pages at all — fast stream before the first fetch resolves', () => {
    const out = mergeSessionWindow([], [part('p1', 1), part('p2', 2)], ownerIn({ p1: 'm-live', p2: 'm-live' }));
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('m-live');
    expect(out[0].role).toBe('assistant');
    expect(out[0].parts.map((p) => p.id)).toEqual(['p1', 'p2']);
  });
});
