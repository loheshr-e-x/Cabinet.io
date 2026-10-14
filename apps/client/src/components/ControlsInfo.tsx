import { useEffect, useState } from 'react';
import { getControlMappings } from '../gameControls';

interface ControlsInfoProps {
  systemCore: string;
  gameTitle: string;
}

function getConsoleName(systemCore: string) {
  const core = systemCore.toLocaleLowerCase().replace(/^libretro[_-]/, '');
  if (core.includes('fceumm') || core.includes('nes')) return 'nes';
  if (core.includes('snes9x') || core.includes('snes')) return 'snes';
  if (core.includes('mgba') || core.includes('gba')) return 'gba';
  return 'generic';
}

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

export function ControlsInfo({ systemCore, gameTitle }: ControlsInfoProps) {
  const [isOpen, setIsOpen] = useState(false);
  const isTouch = useTouchDevice();
  const consoleType = getConsoleName(systemCore);
  const buttons = getControlMappings(systemCore, gameTitle);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isOpen]);

  const consoleName =
    consoleType === 'generic' ? 'RETROPAD' : consoleType.toLocaleUpperCase();

  return (
    <>
      <button
        className="button button--secondary"
        type="button"
        onClick={() => setIsOpen(true)}
      >
        CONTROLS
      </button>
      {isOpen && (
        <div
          className="controls-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setIsOpen(false);
          }}
        >
          <section
            className="controls-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="controls-title"
          >
            <button
              className="controls-modal-close"
              type="button"
              onClick={() => setIsOpen(false)}
              aria-label="Close controls"
            >
              ×
            </button>
            <span className="eyebrow">PLAYER GUIDE / {consoleName}</span>
            <h2 id="controls-title">CONTROLS</h2>
            <p className="controls-device">
              DEVICE: {isTouch ? 'TOUCHSCREEN' : 'KEYBOARD'}
            </p>
            <dl className="controls-list">
              {buttons.map(({ button, key, action }) => (
                <div key={button}>
                  <dt>{action ? `${button} · ${action}` : button}</dt>
                  <dd>{key}</dd>
                </div>
              ))}
            </dl>
            {isTouch && (
              <p className="controls-touch-note">
                Touch buttons appear below the game, or over it in fullscreen.
              </p>
            )}
          </section>
        </div>
      )}
    </>
  );
}
