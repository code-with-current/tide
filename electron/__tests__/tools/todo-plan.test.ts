import { describe, expect, it } from 'vitest';
import { renderTodoPlanLines, type TodoItem } from '../../agent/tools/todo-write';

function item(content: string, status: TodoItem['status']): TodoItem {
  return { content, status };
}

describe('renderTodoPlanLines', () => {
  it('renders the four status marks distinctly', () => {
    const lines = renderTodoPlanLines([
      item('Done work', 'completed'),
      item('Active work', 'in_progress'),
      item('Dropped work', 'cancelled'),
      item('Future work', 'pending'),
    ]);
    expect(lines).toEqual([
      '[x] 1. Done work',
      '[~] 2. Active work',
      '[-] 3. Dropped work',
      '[ ] 4. Future work',
    ]);
  });

  it('numbers items by position', () => {
    const lines = renderTodoPlanLines([item('a', 'pending'), item('b', 'pending'), item('c', 'completed')]);
    expect(lines[0]).toBe('[ ] 1. a');
    expect(lines[1]).toBe('[ ] 2. b');
    expect(lines[2]).toBe('[x] 3. c');
  });

  it('returns an empty array for an empty list (no section rendered)', () => {
    expect(renderTodoPlanLines([])).toEqual([]);
  });

  it('maps unknown statuses to the open checkbox', () => {
    const lines = renderTodoPlanLines([{ content: 'odd', status: 'garbage' as TodoItem['status'] }]);
    expect(lines).toEqual(['[ ] 1. odd']);
  });
});
