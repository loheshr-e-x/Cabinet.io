import { useCallback, useEffect, useRef } from 'react';
import { BUTTONS, encodeInput } from '../../../../packages/protocol/src/input';

const KEY_MAPPINGS: Record<string, number> = {
  ArrowUp: BUTTONS.UP,
  ArrowDown: BUTTONS.DOWN,
  ArrowLeft: BUTTONS.LEFT,
  ArrowRight: BUTTONS.RIGHT,
  z: BUTTONS.A,
  x: BUTTONS.B,
  a: BUTTONS.Y,
  s: BUTTONS.X,
  q: BUTTONS.L,
  w: BUTTONS.R,
  Shift: BUTTONS.SELECT,
  Enter: BUTTONS.START,
};

export function useInputHandler(dataChannel: RTCDataChannel | null) {
  const pressedButtons = useRef(0);

  const setButton = useCallback(
    (button: number, isPressed: boolean) => {
      const nextMask = isPressed
        ? pressedButtons.current | button
        : pressedButtons.current & ~button;
      if (pressedButtons.current === nextMask) return;
      pressedButtons.current = nextMask;
      if (dataChannel?.readyState === 'open') {
        dataChannel.send(encodeInput(nextMask));
      }
    },
    [dataChannel],
  );

  useEffect(() => {
    if (!dataChannel) return;

    const sendInputState = () => {
      if (dataChannel.readyState === 'open') {
        dataChannel.send(encodeInput(pressedButtons.current));
      }
    };

    const handleKeyEvent = (event: KeyboardEvent, isPressed: boolean) => {
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const bitmask = KEY_MAPPINGS[key];
      if (bitmask === undefined || (isPressed && event.repeat)) return;

      event.preventDefault();
      setButton(bitmask, isPressed);
    };

    const onKeyDown = (event: KeyboardEvent) => handleKeyEvent(event, true);
    const onKeyUp = (event: KeyboardEvent) => handleKeyEvent(event, false);
    const onChannelOpen = () => sendInputState();
    const releaseAllKeys = () => {
      if (pressedButtons.current === 0) return;
      pressedButtons.current = 0;
      sendInputState();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', releaseAllKeys);
    dataChannel.addEventListener('open', onChannelOpen);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseAllKeys);
      dataChannel.removeEventListener('open', onChannelOpen);
      releaseAllKeys();
    };
  }, [dataChannel, setButton]);

  return setButton;
}
