export interface ControlMapping {
  button: string;
  key: string;
  action?: string;
}

const SYSTEM_CONTROLS: Record<string, ControlMapping[]> = {
  nes: [
    { button: 'D-Pad', key: 'Arrow Keys' },
    { button: 'A', key: 'Z' },
    { button: 'B', key: 'X' },
    { button: 'Start', key: 'Enter' },
    { button: 'Select', key: 'Shift' },
  ],
  snes: [
    { button: 'D-Pad', key: 'Arrow Keys' },
    { button: 'A', key: 'Z' },
    { button: 'B', key: 'X' },
    { button: 'Y', key: 'A' },
    { button: 'X', key: 'S' },
    { button: 'L', key: 'Q' },
    { button: 'R', key: 'W' },
    { button: 'Start', key: 'Enter' },
    { button: 'Select', key: 'Shift' },
  ],
  gba: [
    { button: 'D-Pad', key: 'Arrow Keys' },
    { button: 'A', key: 'X' },
    { button: 'B', key: 'Z' },
    { button: 'L', key: 'Q' },
    { button: 'R', key: 'W' },
    { button: 'Start', key: 'Enter' },
    { button: 'Select', key: 'Shift' },
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

export function getControlMappings(
  systemCore: string,
  gameTitle: string,
): ControlMapping[] {
  const consoleType = getConsole(systemCore);
  const actions = getGameActions(systemCore, gameTitle);
  return (SYSTEM_CONTROLS[consoleType] ?? SYSTEM_CONTROLS.nes).map((mapping) => ({
    ...mapping,
    ...(actions[mapping.button] ? { action: actions[mapping.button] } : {}),
  }));
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
