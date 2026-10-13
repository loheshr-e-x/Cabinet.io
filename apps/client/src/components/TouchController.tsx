import { useEffect, useRef, type PointerEvent } from 'react';
import { BUTTONS } from '../../../../packages/protocol/src/input';

interface TouchControllerProps {
  setButton: (button: number, isPressed: boolean) => void;
  enabled: boolean;
}

const directions = [
  { label: 'UP', button: BUTTONS.UP, className: 'touch-up' },
  { label: 'LEFT', button: BUTTONS.LEFT, className: 'touch-left' },
  { label: 'RIGHT', button: BUTTONS.RIGHT, className: 'touch-right' },
  { label: 'DOWN', button: BUTTONS.DOWN, className: 'touch-down' },
];

export function TouchController({ setButton, enabled }: TouchControllerProps) {
  const activeButtons = useRef(new Set<number>());

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
        {directions.map(({ label, button, className }) => (
          <button
            className={`touch-button ${className}`}
            key={label}
            type="button"
            aria-label={label}
            onPointerDown={(event) => pointerDown(event, button)}
            onPointerUp={(event) => pointerEnd(event, button)}
            onPointerCancel={(event) => pointerEnd(event, button)}
            onLostPointerCapture={(event) => pointerEnd(event, button)}
          >
            {label === 'UP' ? '▲' : label === 'DOWN' ? '▼' : label === 'LEFT' ? '◀' : '▶'}
          </button>
        ))}
      </div>
      <div className="touch-actions">
        {[
          { label: 'B', button: BUTTONS.B },
          { label: 'A', button: BUTTONS.A },
        ].map(({ label, button }) => (
          <button
            className={`touch-button touch-action touch-action--${label.toLowerCase()}`}
            key={label}
            type="button"
            aria-label={label}
            onPointerDown={(event) => pointerDown(event, button)}
            onPointerUp={(event) => pointerEnd(event, button)}
            onPointerCancel={(event) => pointerEnd(event, button)}
            onLostPointerCapture={(event) => pointerEnd(event, button)}
          >
            {label}
          </button>
        ))}
        <div className="touch-utility-actions">
          {[
            { label: 'SELECT', button: BUTTONS.SELECT },
            { label: 'START', button: BUTTONS.START },
          ].map(({ label, button }) => (
            <button
              className="touch-button touch-utility"
              key={label}
              type="button"
              aria-label={label}
              onPointerDown={(event) => pointerDown(event, button)}
              onPointerUp={(event) => pointerEnd(event, button)}
              onPointerCancel={(event) => pointerEnd(event, button)}
              onLostPointerCapture={(event) => pointerEnd(event, button)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
