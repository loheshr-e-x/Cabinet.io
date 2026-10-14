import { useEffect, useState } from 'react';
import {
  getControlMappings,
  type ControlAction,
  type Keybindings,
} from '../gameControls';

interface ControlsInfoProps {
  systemCore: string;
  gameTitle: string;
  keybindings: Keybindings;
  setCustomKeybinding: (action: ControlAction, keycode: string) => void;
  resetCustomKeybindings: () => void;
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

export function ControlsInfo({
  systemCore,
  gameTitle,
  keybindings,
  setCustomKeybinding,
  resetCustomKeybindings,
}: ControlsInfoProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isCustomizing, setIsCustomizing] = useState(false);
  const [capturingAction, setCapturingAction] = useState<ControlAction | null>(
    null,
  );
  const isTouch = useTouchDevice();
  const consoleType = getConsoleName(systemCore);
  const buttons = getControlMappings(systemCore, gameTitle, keybindings);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        setCapturingAction(null);
        setIsCustomizing(false);
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isOpen]);

  useEffect(() => {
    if (!capturingAction) return;

    const captureKey = (event: KeyboardEvent) => {
      if (event.code === 'Unidentified') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setCustomKeybinding(capturingAction, event.code);
      setCapturingAction(null);
    };

    window.addEventListener('keydown', captureKey, true);
    return () => window.removeEventListener('keydown', captureKey, true);
  }, [capturingAction, setCustomKeybinding]);

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
            if (event.target === event.currentTarget) {
              setIsOpen(false);
              setCapturingAction(null);
              setIsCustomizing(false);
            }
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
              onClick={() => {
                setIsOpen(false);
                setCapturingAction(null);
                setIsCustomizing(false);
              }}
              aria-label="Close controls"
            >
              ×
            </button>
            <span className="eyebrow">PLAYER GUIDE / {consoleName}</span>
            <h2 id="controls-title">CONTROLS</h2>
            <p className="controls-device">
              DEVICE: {isTouch ? 'TOUCHSCREEN' : 'KEYBOARD'}
            </p>
            <div className="controls-tabs" role="tablist" aria-label="Controls view">
              <button
                className="button button--secondary"
                type="button"
                role="tab"
                aria-selected={!isCustomizing}
                onClick={() => {
                  setCapturingAction(null);
                  setIsCustomizing(false);
                }}
              >
                DEFAULT CONTROLS
              </button>
              <button
                className="button button--secondary"
                type="button"
                role="tab"
                aria-selected={isCustomizing}
                onClick={() => setIsCustomizing(true)}
              >
                CUSTOMIZE CONTROLS
              </button>
            </div>
            <dl className="controls-list">
              {buttons.map(({ button, key, action, bindingAction }) => (
                <div key={button}>
                  <dt>{action ? `${button} · ${action}` : button}</dt>
                  <dd>
                    {isCustomizing ? (
                      <button
                        className="controls-keybinding"
                        type="button"
                        onClick={() => setCapturingAction(bindingAction)}
                        aria-label={`Rebind ${action ? `${button} ${action}` : button}`}
                      >
                        {capturingAction === bindingAction
                          ? 'Press any key…'
                          : key}
                      </button>
                    ) : (
                      key
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            {isCustomizing && (
              <div className="controls-customize-actions">
                <p className="controls-touch-note">
                  Select a binding, then press any key to assign it.
                </p>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => {
                    setCapturingAction(null);
                    resetCustomKeybindings();
                  }}
                >
                  RESET TO DEFAULTS
                </button>
              </div>
            )}
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
