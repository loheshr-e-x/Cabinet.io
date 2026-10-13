import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  getCoreForRom,
  getRomTitle,
  hashRom,
  scanRomDirectory,
} from './ingest-roms.js';

test('maps supported ROM extensions to their Libretro cores case-insensitively', () => {
  assert.equal(getCoreForRom('game.nes'), 'fceumm');
  assert.equal(getCoreForRom('game.SFC'), 'snes9x');
  assert.equal(getCoreForRom('game.gba'), 'mgba');
  assert.equal(getCoreForRom('game.zip'), null);
});

test('derives a readable title from the ROM filename', () => {
  assert.equal(getRomTitle('Super_Mario.World.sfc'), 'Super Mario World');
});

test('computes the SHA-256 checksum for ROM bytes', () => {
  assert.equal(
    hashRom(Buffer.from('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('recursively scans supported ROM files and rejects duplicate R2 filenames', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cabinet-roms-'));
  try {
    await mkdir(path.join(directory, 'nested'));
    await writeFile(path.join(directory, 'game.nes'), 'nes');
    await writeFile(path.join(directory, 'nested', 'handheld.GBA'), 'gba');
    await writeFile(path.join(directory, 'ignored.zip'), 'archive');

    const files = await scanRomDirectory(directory);
    assert.deepEqual(
      files.map(({ filename, extension }) => [filename, extension]),
      [
        ['game.nes', '.nes'],
        ['handheld.GBA', '.gba'],
      ],
    );

    await writeFile(path.join(directory, 'nested', 'game.nes'), 'duplicate');
    await assert.rejects(scanRomDirectory(directory), /filenames must be unique/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
