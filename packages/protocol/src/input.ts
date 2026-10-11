export const BUTTONS = {
  UP: 0x01,
  DOWN: 0x02,
  LEFT: 0x04,
  RIGHT: 0x08,
  A: 0x10,
  B: 0x20,
  SELECT: 0x40,
  START: 0x80,
} as const;

export function encodeInput(
  slot: number,
  bitmask: number,
  isPressed: boolean,
) {
  return new Uint8Array([
    slot & 0xff,
    bitmask & 0xff,
    isPressed ? 0x01 : 0x00,
  ]);
}
