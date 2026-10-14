export type ControlAction =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'jump'
  | 'primary'
  | 'action1'
  | 'action2'
  | 'action3'
  | 'action4'
  | 'action5'
  | 'start'
  | 'select';

export type Keybindings = Record<ControlAction, string>;

export interface ControlMapping {
  button: string;
  key: string;
  action?: string;
  bindingAction: ControlAction;
}

export const KEYBINDINGS_STORAGE_KEY = 'cabinet_keybindings';

export const DEFAULT_KEYBINDINGS: Keybindings = {
  up: 'KeyW',
  down: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  primary: 'KeyJ',
  action1: 'KeyK',
  action2: 'KeyL',
  action3: 'Digit1',
  action4: 'Digit2',
  action5: 'Digit3',
  start: 'Enter',
  select: 'ShiftLeft',
};

interface SystemControl {
  button: string;
  bindingAction: ControlAction;
}

const SYSTEM_CONTROLS: Record<string, SystemControl[]> = {
  nes: [
    { button: 'Up', bindingAction: 'up' },
    { button: 'Down', bindingAction: 'down' },
    { button: 'Left', bindingAction: 'left' },
    { button: 'Right', bindingAction: 'right' },
    { button: 'A', bindingAction: 'primary' },
    { button: 'B', bindingAction: 'jump' },
    { button: 'Start', bindingAction: 'start' },
    { button: 'Select', bindingAction: 'select' },
  ],
  snes: [
    { button: 'Up', bindingAction: 'up' },
    { button: 'Down', bindingAction: 'down' },
    { button: 'Left', bindingAction: 'left' },
    { button: 'Right', bindingAction: 'right' },
    { button: 'A', bindingAction: 'primary' },
    { button: 'B', bindingAction: 'jump' },
    { button: 'Y', bindingAction: 'action1' },
    { button: 'X', bindingAction: 'action2' },
    { button: 'L', bindingAction: 'action3' },
    { button: 'R', bindingAction: 'action4' },
    { button: 'Start', bindingAction: 'start' },
    { button: 'Select', bindingAction: 'select' },
  ],
  gba: [
    { button: 'Up', bindingAction: 'up' },
    { button: 'Down', bindingAction: 'down' },
    { button: 'Left', bindingAction: 'left' },
    { button: 'Right', bindingAction: 'right' },
    { button: 'A', bindingAction: 'jump' },
    { button: 'B', bindingAction: 'primary' },
    { button: 'L', bindingAction: 'action1' },
    { button: 'R', bindingAction: 'action2' },
    { button: 'Start', bindingAction: 'start' },
    { button: 'Select', bindingAction: 'action5' },
  ],
};

function getConsole(systemCore: string): string {
  const core = systemCore.toLocaleLowerCase().replace(/^libretro[_-]/, '');
  if (core.includes('fceumm') || core.includes('nes')) return 'nes';
  if (core.includes('snes9x') || core.includes('snes')) return 'snes';
  if (core.includes('mgba') || core.includes('gba')) return 'gba';
  return 'nes';
}

function getGameActions(
  systemCore: string,
  gameTitle: string,
): Record<string, string> {
  const title = gameTitle.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const consoleType = getConsole(systemCore);

  if (consoleType === 'snes' && title.includes('street fighter ii turbo')) {
    return {
      Y: 'Light Punch',
      X: 'Medium Punch',
      L: 'Heavy Punch',
      B: 'Light Kick',
      A: 'Medium Kick',
      R: 'Heavy Kick',
    };
  }
  if (consoleType === 'snes' && title.includes('super mario world')) {
    return {
      Y: 'Run / Carry',
      B: 'Jump',
      A: 'Spin Jump',
      Select: 'Item Drop',
    };
  }
  if (consoleType === 'gba' && title.includes('castlevania aria of sorrow')) {
    return {
      B: 'Attack',
      A: 'Jump',
      R: 'Soul Power',
      L: 'Backdash',
    };
  }
  return {};
}

function getGameBindingOverrides(
  systemCore: string,
  gameTitle: string,
): Partial<Record<string, ControlAction>> {
  const title = gameTitle.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (
    getConsole(systemCore) === 'snes' &&
    title.includes('street fighter ii turbo')
  ) {
    return {
      Y: 'action1',
      X: 'action2',
      L: 'action3',
      B: 'action4',
      R: 'action5',
    };
  }
  return {};
}

function formatKeybinding(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'ShiftLeft' || code === 'ShiftRight') return 'Shift';
  if (code === 'ControlLeft' || code === 'ControlRight') return 'Ctrl';
  if (code === 'AltLeft' || code === 'AltRight') return 'Alt';
  if (code === 'MetaLeft' || code === 'MetaRight') return 'Meta';
  if (code === 'ArrowUp') return '↑';
  if (code === 'ArrowDown') return '↓';
  if (code === 'ArrowLeft') return '←';
  if (code === 'ArrowRight') return '→';
  return code;
}

export function getControlMappings(
  systemCore: string,
  gameTitle: string,
  keybindings: Keybindings = DEFAULT_KEYBINDINGS,
): ControlMapping[] {
  const consoleType = getConsole(systemCore);
  const actions = getGameActions(systemCore, gameTitle);
  const bindingOverrides = getGameBindingOverrides(systemCore, gameTitle);
  return (SYSTEM_CONTROLS[consoleType] ?? SYSTEM_CONTROLS.nes).map(
    ({ button, bindingAction: defaultBindingAction }) => {
      const bindingAction = bindingOverrides[button] ?? defaultBindingAction;
      return {
        button,
        bindingAction,
        key: formatKeybinding(keybindings[bindingAction]),
        ...(actions[button] ? { action: actions[button] } : {}),
      };
    },
  );
}

export function getTouchActionLabel(
  button: string,
  systemCore: string,
  gameTitle: string,
): string {
  const actionKey =
    button.toLocaleLowerCase() === 'select' ? 'Select' : button.toLocaleUpperCase();
  const action = getGameActions(systemCore, gameTitle)[actionKey];
  return action ? `${button} · ${action}` : button;
}
