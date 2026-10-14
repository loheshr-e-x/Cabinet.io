import { useEffect, useRef, type PointerEvent } from 'react';
import { BUTTONS } from '../../../../packages/protocol/src/input';
import {
  getControlMappings,
  type ControlAction,
  type Keybindings,
} from '../gameControls';

interface TouchControllerProps {
  setButton: (button: number, isPressed: boolean) => void;
  enabled: boolean;
  systemCore: string;
  gameTitle: string;
  keybindings: Keybindings;
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

const DIRECTION_CLASSES: Record<string, string> = {
  up: 'touch-up',
  left: 'touch-left',
  right: 'touch-right',
  down: 'touch-down',
};

const DIRECTION_ACTIONS = new Set<ControlAction>([
  'up',
  'down',
  'left',
  'right',
]);

function getButtonFunction(
  button: string,
  bindingAction: ControlAction,
  customAction?: string,
): string {
  if (customAction) return customAction;
  if (bindingAction === 'jump') return 'Jump';
  if (bindingAction === 'primary') return 'Primary';
  if (bindingAction.startsWith('action')) {
    return `Action ${bindingAction.slice('action'.length)}`;
  }
  return `${button} Button`;
}

export function TouchController({
  setButton,
  enabled,
  systemCore,
  gameTitle,
  keybindings,
}: TouchControllerProps) {
  const activeButtons = useRef(new Set<number>());
  const mappings = getControlMappings(systemCore, gameTitle, keybindings);
  const directions = mappings.filter(({ bindingAction }) =>
    DIRECTION_ACTIONS.has(bindingAction),
  );
  const actionButtons = mappings.filter(
    ({ button }) =>
      !['Up', 'Down', 'Left', 'Right', 'Start', 'Select'].includes(button),
  );
  const utilityButtons = mappings.filter(({ button }) =>
    ['Select', 'Start'].includes(button),
  );

  useEffect(
    () => () => {
      for (const button of activeButtons.current) {
        setButton(button, false);
      }
      activeButtons.current.clear();
    },
    [enabled, setButton],
  );

  if (!enabled) return null;

  const press = (button: number, isPressed: boolean) => {
    if (isPressed) activeButtons.current.add(button);
    else activeButtons.current.delete(button);
    setButton(button, isPressed);
  };
  const pointerDown = (event: PointerEvent<HTMLButtonElement>, button: number) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    press(button, true);
    if (event.pointerType === 'touch' && 'vibrate' in navigator) {
      navigator.vibrate(10);
    }
  };
  const pointerEnd = (event: PointerEvent<HTMLButtonElement>, button: number) => {
    event.preventDefault();
    press(button, false);
  };
  return (
    <div
      className="touch-controller"
      aria-label="Touch game controller"
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="touch-dpad" aria-label="Directional pad">
        {directions.map(({ button, bindingAction, key }) => {
          const bit = BUTTON_BITS[button];
          if (bit === undefined) return null;
          return (
            <button
              className={`touch-button ${DIRECTION_CLASSES[bindingAction]}`}
              key={bindingAction}
              type="button"
              aria-label={`${key}, move ${bindingAction}`}
              onPointerDown={(event) => pointerDown(event, bit)}
              onPointerUp={(event) => pointerEnd(event, bit)}
              onPointerCancel={(event) => pointerEnd(event, bit)}
              onLostPointerCapture={(event) => pointerEnd(event, bit)}
            >
              <span>{key}</span>
              <small>MOVE {bindingAction.toUpperCase()}</small>
            </button>
          );
        })}
      </div>
      <div className="touch-actions">
        {actionButtons.map(({ button, key, bindingAction, action }) => {
          const bit = BUTTON_BITS[button];
          if (bit === undefined) return null;
          const functionLabel = getButtonFunction(button, bindingAction, action);
          return (
            <button
              className={`touch-button touch-action touch-action--${button.toLowerCase()}`}
              key={button}
              type="button"
              aria-label={`${key}, ${functionLabel}`}
              title={`${key} · ${functionLabel}`}
              onPointerDown={(event) => pointerDown(event, bit)}
              onPointerUp={(event) => pointerEnd(event, bit)}
              onPointerCancel={(event) => pointerEnd(event, bit)}
              onLostPointerCapture={(event) => pointerEnd(event, bit)}
            >
              <span>{key}</span>
              <small>{functionLabel}</small>
            </button>
          );
        })}
        <div className="touch-utility-actions">
          {utilityButtons.map(({ button, key }) => {
            const bit = BUTTON_BITS[button];
            if (bit === undefined) return null;
            return (
              <button
                className="touch-button touch-utility"
                key={button}
                type="button"
                aria-label={`${key}, ${button}`}
                title={`${key} · ${button}`}
                onPointerDown={(event) => pointerDown(event, bit)}
                onPointerUp={(event) => pointerEnd(event, bit)}
                onPointerCancel={(event) => pointerEnd(event, bit)}
                onLostPointerCapture={(event) => pointerEnd(event, bit)}
              >
                <span>{key}</span>
                <small>{button}</small>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
