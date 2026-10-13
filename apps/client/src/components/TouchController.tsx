import { useEffect, useRef, useState, type TouchEvent } from 'react';
import { BUTTONS } from '../../../../packages/protocol/src/input';

interface TouchControllerProps {
  setButton: (button: number, isPressed: boolean) => void;
}

const directions = [
  { label: 'UP', button: BUTTONS.UP, className: 'touch-up' },
  { label: 'LEFT', button: BUTTONS.LEFT, className: 'touch-left' },
  { label: 'RIGHT', button: BUTTONS.RIGHT, className: 'touch-right' },
  { label: 'DOWN', button: BUTTONS.DOWN, className: 'touch-down' },
];

function useTouchDevice() {
  const [isTouch, setIsTouch] = useState(
    () =>
      window.matchMedia('(pointer: coarse)').matches ||
      window.matchMedia('(max-width: 768px)').matches,
  );

  useEffect(() => {
    const coarsePointer = window.matchMedia('(pointer: coarse)');
    const narrowScreen = window.matchMedia('(max-width: 768px)');
    const update = () =>
      setIsTouch(coarsePointer.matches || narrowScreen.matches);
    coarsePointer.addEventListener('change', update);
    narrowScreen.addEventListener('change', update);
    return () => {
      coarsePointer.removeEventListener('change', update);
      narrowScreen.removeEventListener('change', update);
    };
  }, []);

  return isTouch;
}

export function TouchController({ setButton }: TouchControllerProps) {
  const isTouch = useTouchDevice();
  const activeButtons = useRef(new Set<number>());
  const setButtonRef = useRef(setButton);

  useEffect(() => {
    setButtonRef.current = setButton;
  }, [setButton]);

  useEffect(
    () => () => {
      for (const button of activeButtons.current) {
        setButtonRef.current(button, false);
      }
      activeButtons.current.clear();
    },
    [],
  );

  if (!isTouch) return null;

  const press = (button: number, isPressed: boolean) => {
    if (isPressed) activeButtons.current.add(button);
    else activeButtons.current.delete(button);
    setButton(button, isPressed);
    if (isPressed && 'vibrate' in navigator) navigator.vibrate(10);
  };
  const touchStart = (event: TouchEvent, button: number) => {
    event.preventDefault();
    press(button, true);
  };
  const touchEnd = (event: TouchEvent, button: number) => {
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
            onTouchStart={(event) => touchStart(event, button)}
            onTouchEnd={(event) => touchEnd(event, button)}
            onTouchCancel={(event) => touchEnd(event, button)}
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
            onTouchStart={(event) => touchStart(event, button)}
            onTouchEnd={(event) => touchEnd(event, button)}
            onTouchCancel={(event) => touchEnd(event, button)}
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
              onTouchStart={(event) => touchStart(event, button)}
              onTouchEnd={(event) => touchEnd(event, button)}
              onTouchCancel={(event) => touchEnd(event, button)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
