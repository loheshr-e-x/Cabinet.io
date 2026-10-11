import { useEffect } from 'react';
import { BUTTONS, encodeInput } from '../../../../packages/protocol/src/input';

const KEY_MAPPINGS: Record<string, number> = {
  ArrowUp: BUTTONS.UP,
  ArrowDown: BUTTONS.DOWN,
  ArrowLeft: BUTTONS.LEFT,
  ArrowRight: BUTTONS.RIGHT,
  z: BUTTONS.A,
  x: BUTTONS.B,
  Shift: BUTTONS.SELECT,
  Enter: BUTTONS.START,
};

export function useInputHandler(
  dataChannel: RTCDataChannel | null,
  playerSlot = 0,
) {
  useEffect(() => {
    if (!dataChannel) return;

    const handleKeyEvent = (event: KeyboardEvent, isPressed: boolean) => {
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const bitmask = KEY_MAPPINGS[key];
      if (bitmask === undefined || (isPressed && event.repeat)) return;

      event.preventDefault();
      if (dataChannel.readyState === 'open') {
        dataChannel.send(encodeInput(playerSlot, bitmask, isPressed));
      }
    };

    const onKeyDown = (event: KeyboardEvent) => handleKeyEvent(event, true);
    const onKeyUp = (event: KeyboardEvent) => handleKeyEvent(event, false);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [dataChannel, playerSlot]);
}
