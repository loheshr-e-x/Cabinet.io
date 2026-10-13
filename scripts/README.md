# ROM ingestion

Run the ROM catalog ingestion CLI from the repository root:

```sh
npx tsx scripts/ingest-roms.ts <directory_path>
```

The script scans the directory recursively for `.nes`, `.sfc`, and `.gba`
files. It uses `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_BUCKET`, and `DATABASE_URL` from the environment. For local runs, it loads
`apps/orchestrator/.env` and then fills any still-unset variables from the root
`.env`.

The corresponding database must have the orchestrator schema applied. The
ingester upserts on the unique `games.checksum`, preserves the existing ID when
the same ROM content is ingested again, and updates title/core/R2 key metadata.
R2 object keys use `roms/{filename}`, so duplicate basenames in separate
subdirectories are rejected before any upload.

Focused local tests:

```sh
npx tsx --test scripts/ingest-roms.test.ts
```
