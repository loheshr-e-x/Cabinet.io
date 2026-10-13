import {
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config as loadEnv } from 'dotenv';
import pg from 'pg';

const { Pool } = pg;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: path.join(projectRoot, 'apps/orchestrator/.env') });
loadEnv({ path: path.join(projectRoot, '.env') });

const CORE_BY_EXTENSION: Record<string, string> = {
  '.nes': 'fceumm',
  '.sfc': 'snes9x',
  '.gba': 'mgba',
};

export interface RomFile {
  path: string;
  filename: string;
  extension: string;
}

export function getCoreForRom(filePath: string): string | null {
  return CORE_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? null;
}

export function getRomTitle(filename: string): string {
  return path.basename(filename, path.extname(filename))
    .replace(/[._]+/g, ' ')
    .trim();
}

export function hashRom(rom: Uint8Array): string {
  return createHash('sha256').update(rom).digest('hex');
}

export async function scanRomDirectory(directory: string): Promise<RomFile[]> {
  const resolvedDirectory = path.resolve(directory);
  const files: RomFile[] = [];

  const visit = async (currentDirectory: string): Promise<void> => {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && getCoreForRom(entry.name)) {
        files.push({
          path: entryPath,
          filename: entry.name,
          extension: path.extname(entry.name).toLowerCase(),
        });
      }
    }
  };

  await visit(resolvedDirectory);
  files.sort((a, b) => a.path.localeCompare(b.path));

  const filesByName = new Map<string, string>();
  for (const file of files) {
    const previousPath = filesByName.get(file.filename);
    if (previousPath) {
      throw new Error(
        `ROM filenames must be unique because R2 keys use filenames: "${file.filename}" appears in "${previousPath}" and "${file.path}".`,
      );
    }
    filesByName.set(file.filename, file.path);
  }

  return files;
}

function createR2Client(): S3Client {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'Set R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY before running ingestion.',
    );
  }

  return new S3Client({
    endpoint,
    region: 'auto',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
}

export async function ingestRomDirectory(directory: string): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const bucket = process.env.R2_BUCKET;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  if (!bucket) throw new Error('R2_BUCKET is required.');

  const files = await scanRomDirectory(directory);
  if (files.length === 0) {
    console.info('[Ingest] No .nes, .sfc, or .gba ROM files found.');
    return;
  }

  const r2 = createR2Client();
  const db = new Pool({ connectionString: databaseUrl });
  let failures = 0;

  try {
    for (const file of files) {
      try {
        const rom = await readFile(file.path);
        const checksum = hashRom(rom);
        const systemCore = getCoreForRom(file.filename);
        if (!systemCore) continue;

        const romR2Key = `roms/${file.filename}`;
        await r2.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: romR2Key,
            Body: rom,
            ContentType: 'application/octet-stream',
            Metadata: { sha256: checksum },
          }),
        );

        await db.query(
          `
            INSERT INTO games
              (id, title, system_core, rom_r2_key, checksum, created_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
            ON CONFLICT (checksum)
            DO UPDATE SET
              title = EXCLUDED.title,
              system_core = EXCLUDED.system_core,
              rom_r2_key = EXCLUDED.rom_r2_key
          `,
          [
            randomUUID(),
            getRomTitle(file.filename),
            systemCore,
            romR2Key,
            checksum,
          ],
        );
        console.info(
          `[Ingest] Uploaded ${file.filename} -> R2 (${romR2Key}) & updated Neon DB`,
        );
      } catch (error) {
        failures += 1;
        console.error(
          `[Ingest] Failed ${file.filename}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  } finally {
    r2.destroy();
    await db.end();
  }

  console.info(`[Ingest] Finished: ${files.length - failures} succeeded, ${failures} failed.`);
  if (failures > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (!directory || process.argv.length > 3) {
    throw new Error('Usage: npx tsx scripts/ingest-roms.ts <directory_path>');
  }
  await ingestRomDirectory(directory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error('[Ingest] Fatal error:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
