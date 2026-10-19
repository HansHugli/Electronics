/**
 * Breadboard internal wiring model.
 *
 * Each breadboard has this layout:
 *
 *   | Power Rails |  Component Area Left  | GAP |  Component Area Right  | Power Rails |
 *   |  2 cols     |      5 cols           |     |       5 cols           |   2 cols    |
 *   |  ×50 rows   |      ×50 rows         |     |       ×50 rows        |   ×50 rows  |
 *
 * Power rails: 2 columns per side (one '+' column, one '-' column). Like a
 *   real breadboard, each column is ONE connected strip that runs the full
 *   length of its side: all 50 holes of a '+' column are one node, and all
 *   50 holes of the '-' column next to it are another. '+' and '-' are not
 *   connected to each other, the left and right sides are separate, and the
 *   two breadboards are separate (jumper them with a wire). The holes are
 *   drawn in groups of 5 only as a visual guide. The power supply terminals
 *   are NOT connected to any rail until you run a wire to a rail hole.
 *
 * Component area: 5 columns per half. Each row of 5 pins is connected horizontally.
 *   The center gap breaks the connection — left 5 and right 5 are separate.
 *   A DIP chip straddles the gap.
 *
 * Two breadboards are placed side by side with a small gap.
 *
 * All coordinates are in grid units (multiply by GRID_SIZE for pixels).
 */

export const GRID_W = 24;  // horizontal spacing
export const GRID_H = 17;  // vertical spacing (30% smaller than horizontal)
// Legacy alias — use GRID_W/GRID_H where direction matters
export const GRID_SIZE = GRID_W;

// Single board dimensions in grid units
export const RAIL_COLS = 2;
export const COMP_COLS = 5;
export const GAP_COLS = 1;
export const TOTAL_ROWS = 50;
export const SINGLE_BOARD_COLS = RAIL_COLS + COMP_COLS + GAP_COLS + COMP_COLS + RAIL_COLS; // 15

// Rows per visual rail group (drawn spacing only; the whole rail column is one node)
export const RAIL_GROUP_SIZE = 5;
export const RAIL_GROUPS = TOTAL_ROWS / RAIL_GROUP_SIZE; // 10

// Number of breadboards
export const NUM_BOARDS = 2;
export const BOARD_GAP_COLS = 1; // gap between boards

// Total board area columns
export const BOARD_TOTAL_COLS = NUM_BOARDS * SINGLE_BOARD_COLS + (NUM_BOARDS - 1) * BOARD_GAP_COLS; // 31

// Column offsets within a single board (relative to board start)
export const REL_COL_LEFT_RAIL = 0;
export const REL_COL_LEFT_COMP = RAIL_COLS;                          // 2
export const REL_COL_GAP = REL_COL_LEFT_COMP + COMP_COLS;            // 7
export const REL_COL_RIGHT_COMP = REL_COL_GAP + GAP_COLS;            // 8
export const REL_COL_RIGHT_RAIL = REL_COL_RIGHT_COMP + COMP_COLS;    // 13

/**
 * Get the starting column for a given board index.
 */
export function boardColOffset(boardIndex: number): number {
  return boardIndex * (SINGLE_BOARD_COLS + BOARD_GAP_COLS);
}

/**
 * Get column positions for a specific board.
 */
export function boardColumns(boardIndex: number) {
  const off = boardColOffset(boardIndex);
  return {
    leftRailStart: off + REL_COL_LEFT_RAIL,
    leftCompStart: off + REL_COL_LEFT_COMP,
    gap: off + REL_COL_GAP,
    rightCompStart: off + REL_COL_RIGHT_COMP,
    rightRailStart: off + REL_COL_RIGHT_RAIL,
  };
}

// Board pixel dimensions
export const BOARD_PIXEL_WIDTH = BOARD_TOTAL_COLS * GRID_W;
export const BOARD_PIXEL_HEIGHT = TOTAL_ROWS * GRID_H;

// Power supply area to the left
export const SUPPLY_COLS = 4;
export const SUPPLY_WIDTH = SUPPLY_COLS * GRID_W;
export const TOTAL_PIXEL_WIDTH = SUPPLY_WIDTH + BOARD_PIXEL_WIDTH;
export const BOARD_X_OFFSET = SUPPLY_WIDTH;

/**
 * A connected group of pin holes.
 */
export interface PinGroup {
  id: string;
  pins: { col: number; row: number }[];
  type: 'rail-pos' | 'rail-neg' | 'component';
}

/**
 * Build all pin groups for all breadboards.
 */
export function buildPinGroups(): PinGroup[] {
  const groups: PinGroup[] = [];

  for (let bi = 0; bi < NUM_BOARDS; bi++) {
    const cols = boardColumns(bi);
    const prefix = `b${bi}`;

    // Power rails — each column is one strip running the full length of the
    // board (one '+' node and one '-' node per side)
    for (const [side, railCol] of [['left', cols.leftRailStart], ['right', cols.rightRailStart]] as const) {
      const posGroup: PinGroup = { id: `${prefix}-${side}-rail-pos`, pins: [], type: 'rail-pos' };
      const negGroup: PinGroup = { id: `${prefix}-${side}-rail-neg`, pins: [], type: 'rail-neg' };
      for (let r = 0; r < TOTAL_ROWS; r++) {
        posGroup.pins.push({ col: railCol, row: r });
        negGroup.pins.push({ col: railCol + 1, row: r });
      }
      groups.push(posGroup, negGroup);
    }

    // Left component area — each row of 5 is a group
    for (let row = 0; row < TOTAL_ROWS; row++) {
      const group: PinGroup = { id: `${prefix}-left-comp-${row}`, pins: [], type: 'component' };
      for (let c = 0; c < COMP_COLS; c++) {
        group.pins.push({ col: cols.leftCompStart + c, row });
      }
      groups.push(group);
    }

    // Right component area — each row of 5 is a group
    for (let row = 0; row < TOTAL_ROWS; row++) {
      const group: PinGroup = { id: `${prefix}-right-comp-${row}`, pins: [], type: 'component' };
      for (let c = 0; c < COMP_COLS; c++) {
        group.pins.push({ col: cols.rightCompStart + c, row });
      }
      groups.push(group);
    }
  }

  return groups;
}

/**
 * Build a lookup: "col,row" → group id.
 */
export function buildPinLookup(groups: PinGroup[]): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const group of groups) {
    for (const pin of group.pins) {
      lookup.set(`${pin.col},${pin.row}`, group.id);
    }
  }
  return lookup;
}

/**
 * Convert board grid coordinates (col, row) to pixel coordinates.
 * Returns the CENTER of the pin hole.
 */
export function gridToPixel(col: number, row: number): { x: number; y: number } {
  return {
    x: BOARD_X_OFFSET + col * GRID_W + GRID_W / 2,
    y: row * GRID_H + GRID_H / 2,
  };
}

/**
 * Convert pixel coordinates to nearest board grid (col, row).
 */
export function pixelToGrid(px: number, py: number): { col: number; row: number } {
  return {
    col: Math.round((px - BOARD_X_OFFSET - GRID_W / 2) / GRID_W),
    row: Math.round((py - GRID_H / 2) / GRID_H),
  };
}

/**
 * Check if a grid column is a gap (center gap or inter-board gap).
 */
export function isGapColumn(col: number): boolean {
  for (let bi = 0; bi < NUM_BOARDS; bi++) {
    if (col === boardColOffset(bi) + REL_COL_GAP) return true;
  }
  // Inter-board gap
  for (let bi = 0; bi < NUM_BOARDS - 1; bi++) {
    const gapCol = boardColOffset(bi) + SINGLE_BOARD_COLS;
    if (col === gapCol) return true;
  }
  return false;
}

/**
 * Check if a grid position is a valid pin hole.
 */
export function isValidPinHole(col: number, row: number): boolean {
  if (row < 0 || row >= TOTAL_ROWS) return false;
  if (col < 0 || col >= BOARD_TOTAL_COLS) return false;
  if (isGapColumn(col)) return false;
  return true;
}
