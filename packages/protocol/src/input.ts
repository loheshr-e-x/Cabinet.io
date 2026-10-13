export const BUTTONS = {
  B: 1 << 0,
  Y: 1 << 1,
  SELECT: 1 << 2,
  START: 1 << 3,
  UP: 1 << 4,
  DOWN: 1 << 5,
  LEFT: 1 << 6,
  RIGHT: 1 << 7,
  A: 1 << 8,
  X: 1 << 9,
  L: 1 << 10,
  R: 1 << 11,
} as const;

export function encodeInput(bitmask: number) {
  return new Uint8Array([
    bitmask & 0xff,
    (bitmask >> 8) & 0xff,
  ]);
}
