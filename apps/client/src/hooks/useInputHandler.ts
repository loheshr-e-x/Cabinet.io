import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BUTTONS, encodeInput } from '../../../../packages/protocol/src/input';
import {
  DEFAULT_KEYBINDINGS,
  getControlMappings,
  KEYBINDINGS_STORAGE_KEY,
  type ControlAction,
  type Keybindings,
} from '../gameControls';

function loadKeybindings(): Keybindings {
  if (typeof window === 'undefined') return { ...DEFAULT_KEYBINDINGS };

  try {
    const stored = window.localStorage.getItem(KEYBINDINGS_STORAGE_KEY);
    if (!stored) return { ...DEFAULT_KEYBINDINGS };

    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_KEYBINDINGS };
    }

    const result = { ...DEFAULT_KEYBINDINGS };
    for (const action of Object.keys(DEFAULT_KEYBINDINGS) as ControlAction[]) {
      const value = (parsed as Partial<Record<ControlAction, unknown>>)[action];
      if (typeof value === 'string' && value.trim()) result[action] = value;
    }
    return result;
  } catch (error) {
    console.warn('[Cabinet UI] Could not load saved keybindings:', error);
    return { ...DEFAULT_KEYBINDINGS };
  }
}

const BUTTON_BITS: Record<string, number> = {
  Up: BUTTONS.UP,
  Down: BUTTONS.DOWN,
  Left: BUTTONS.LEFT,
  Right: BUTTONS.RIGHT,
  A: BUTTONS.A,
  B: BUTTONS.B,
  X: BUTTONS.X,
  Y: BUTTONS.Y,
  L: BUTTONS.L,
  R: BUTTONS.R,
  Start: BUTTONS.START,
  Select: BUTTONS.SELECT,
};

function normalizeKeyCode(code: string): string {
  if (code.startsWith('Shift')) return 'Shift';
  if (code.startsWith('Control')) return 'Control';
  if (code.startsWith('Alt')) return 'Alt';
  if (code.startsWith('Meta')) return 'Meta';
  return code;
}

export function useInputHandler(
  dataChannel: RTCDataChannel | null,
  systemCore = '',
  gameTitle = '',
) {
  const pressedButtons = useRef(0);
  const [keybindings, setKeybindings] = useState(loadKeybindings);
  const keyMappings = useMemo(() => {
    const mappings = new Map<string, number>();
    for (const { button, bindingAction } of getControlMappings(
      systemCore,
      gameTitle,
      keybindings,
    )) {
      const bit = BUTTON_BITS[button];
      if (bit === undefined) continue;
      const keycode = normalizeKeyCode(keybindings[bindingAction]);
      mappings.set(
        keycode,
        (mappings.get(keycode) ?? 0) | bit,
      );
    }
    return mappings;
  }, [gameTitle, keybindings, systemCore]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        KEYBINDINGS_STORAGE_KEY,
        JSON.stringify(keybindings),
      );
    } catch (error) {
      console.warn('[Cabinet UI] Could not save keybindings:', error);
    }
  }, [keybindings]);

  const setCustomKeybinding = useCallback(
    (action: ControlAction, keycode: string) => {
      setKeybindings((current) => ({ ...current, [action]: keycode }));
    },
    [],
  );

  const resetCustomKeybindings = useCallback(() => {
    setKeybindings({ ...DEFAULT_KEYBINDINGS });
  }, []);

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
      const bitmask = keyMappings.get(normalizeKeyCode(event.code));
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
  }, [dataChannel, keyMappings, setButton]);

  return {
    setButton,
    keybindings,
    setCustomKeybinding,
    resetCustomKeybindings,
  };
}
