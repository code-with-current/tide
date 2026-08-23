import { describe, expect, it } from 'vitest';
import { measureTerminalCells } from '@/lib/terminal-size';

const metrics = (w: number, asc: number, desc: number) => ({
  width: w,
  actualBoundingBoxAscent: asc,
  actualBoundingBoxDescent: desc,
}) as unknown as TextMetrics;

const makeCtx = (m: TextMetrics) => ({
  font: '',
  measureText: () => m,
});

describe('measureTerminalCells', () => {
  it('derives cols/rows from container and cell metrics', () => {
    const ctx = makeCtx(metrics(10, 12, 3)); // cell = 10 x 17
    const size = measureTerminalCells({
      context: ctx as unknown as CanvasRenderingContext2D,
      width: 300, // 300 / 10 = 30
      height: 170, // 170 / 17 = 10
      fontSize: 15,
      fontFamily: 'MesloLGS NF',
    });
    expect(size).toEqual({ cols: 30, rows: 10 });
  });

  it('clamps to minimum 2 cols / 1 row', () => {
    const ctx = makeCtx(metrics(12, 12, 14)); // cell = 12 x 28
    const size = measureTerminalCells({
      context: ctx as unknown as CanvasRenderingContext2D,
      width: 30, // 30 / 12 = 2.5 → 2
      height: 26, // 26 / 28 = 0.9 → clamp 1
      fontSize: 15,
      fontFamily: 'monospace',
    });
    expect(size).toEqual({ cols: 2, rows: 1 });
  });

  it('subtracts container padding', () => {
    const ctx = makeCtx(metrics(5, 8, 2)); // cell = 5 x 12
    const size = measureTerminalCells({
      context: ctx as unknown as CanvasRenderingContext2D,
      width: 200,
      height: 124,
      paddingLeft: 10,
      paddingRight: 10,
      paddingTop: 4,
      paddingBottom: 4,
      fontSize: 10,
      fontFamily: 'monospace',
    });
    // (200 - 20) / 5 = 36 ; (124 - 8) / 12 = 9.67 → 9
    expect(size).toEqual({ cols: 36, rows: 9 });
  });

  it('returns null for degenerate metrics or tiny containers', () => {
    const ctx = makeCtx(metrics(0, 0, 0));
    expect(measureTerminalCells({
      context: ctx as unknown as CanvasRenderingContext2D,
      width: 300, height: 200, fontSize: 14, fontFamily: 'monospace',
    })).toBeNull();
    const good = makeCtx(metrics(10, 12, 3));
    expect(measureTerminalCells({
      context: good as unknown as CanvasRenderingContext2D,
      width: 10, height: 10, fontSize: 14, fontFamily: 'monospace',
    })).toBeNull();
  });
});
