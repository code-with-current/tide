// Sample fixture: a mix of top-level declarations the chunker should
// slice into separate chunks.
export const VERSION = '1.0.0';

export interface User {
  id: number;
  name: string;
}

export type UserID = number;

export enum Direction {
  Up,
  Down,
}

export function add(a: number, b: number): number {
  return a + b;
}

export function* counter() {
  let i = 0;
  while (true) yield i++;
}

export class Calculator {
  constructor(private readonly base: number) {}

  add(x: number): number {
    return this.base + x;
  }

  private secret(): void {
    console.log('shh');
  }
}

const internal = (): void => {
  console.log('not exported');
};

// Trailing comment — should NOT be its own chunk.
