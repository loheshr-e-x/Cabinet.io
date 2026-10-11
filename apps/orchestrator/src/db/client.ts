import pg from 'pg';

const { Pool } = pg;

export const db = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/cabinet',
  connectionTimeoutMillis: 5_000,
});

function describePostgresError(error: unknown): string {
  if (error instanceof Error) {
    const details: Record<string, unknown> = {
      name: error.name,
      message: error.message || '(no message)',
    };
    const connectionError = error as Error & {
      code?: unknown;
      address?: unknown;
      port?: unknown;
      syscall?: unknown;
      errors?: unknown;
      cause?: unknown;
    };

    for (const key of ['code', 'address', 'port', 'syscall'] as const) {
      if (connectionError[key] !== undefined) details[key] = connectionError[key];
    }
    if (Array.isArray(connectionError.errors)) {
      details.errors = connectionError.errors.map(describePostgresError);
    }
    if (connectionError.cause !== undefined) {
      details.cause = describePostgresError(connectionError.cause);
    }
    return JSON.stringify(details);
  }

  if (typeof error === 'string') return error;
  return JSON.stringify({ error: String(error) });
}

db.on('error', (error) => {
  console.error(
    '[Cabinet DB] Unexpected PostgreSQL pool error:',
    describePostgresError(error),
  );
});

export async function verifyDatabaseConnection(): Promise<void> {
  try {
    const result = await db.query<{ now: Date }>('SELECT NOW() AS now');
    console.info('[Cabinet DB] Connected to PostgreSQL at:', result.rows[0]?.now);
  } catch (error) {
    console.error(
      '[Cabinet DB] Failed to connect to PostgreSQL:',
      describePostgresError(error),
    );
  }
}
