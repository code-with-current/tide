/** Provisional terminal sizing before ghostty mounts (OpenChamber technique):
 *  measure the cell box with canvas text metrics and derive cols/rows from the
 *  container, so the PTY spawns at the right dimensions while the WASM emulator
 *  is still loading — no 80x24 flash with re-wrapped shell output. Reserves
 *  FitAddon's 15px scrollbar gutter. Returns null when measurement is
 *  impossible (no canvas context, tiny container) — callers fall back. */

export interface TerminalCellSize {
  cols: number;
  rows: number;
}

const SCROLLBAR_RESERVE_PX = 15;
const MIN_COLS = 2;
const MIN_ROWS = 1;

export function measureTerminalCells(input: {
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
  fontSize: number;
  fontFamily: string;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
}): TerminalCellSize | null {
  const {
    context, width, height, fontSize, fontFamily,
    paddingLeft = 0, paddingRight = 0, paddingTop = 0, paddingBottom = 0,
  } = input;
  if (width < 24 || height < 24) return null;
  context.font = `${fontSize}px ${fontFamily}`;
  const m = context.measureText('M');
  const cellWidth = Math.ceil(m.width);
  const cellHeight = Math.ceil(
    (m.actualBoundingBoxAscent || fontSize * 0.8) +
    (m.actualBoundingBoxDescent || fontSize * 0.2),
  ) + 2;
  if (cellWidth < 1 || cellHeight < 1) return null;
  return {
    cols: Math.max(MIN_COLS, Math.floor((width - paddingLeft - paddingRight - SCROLLBAR_RESERVE_PX) / cellWidth)),
    rows: Math.max(MIN_ROWS, Math.floor((height - paddingTop - paddingBottom) / cellHeight)),
  };
}

/** DOM convenience wrapper — builds the measuring context from a container element. */
export function measureTerminalContainer(
  container: HTMLElement,
  fontSize: number,
  fontFamily: string,
): TerminalCellSize | null {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return null;
  const style = window.getComputedStyle(container);
  return measureTerminalCells({
    context,
    width: container.clientWidth,
    height: container.clientHeight,
    fontSize,
    fontFamily,
    paddingLeft: Number.parseInt(style.paddingLeft, 10) || 0,
    paddingRight: Number.parseInt(style.paddingRight, 10) || 0,
    paddingTop: Number.parseInt(style.paddingTop, 10) || 0,
    paddingBottom: Number.parseInt(style.paddingBottom, 10) || 0,
  });
}
