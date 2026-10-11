import { db } from './client.js';

export interface SaveStateRecord {
  id: string;
  userId: string;
  gameId: string;
  slotId: number;
  r2ObjectKey: string;
  byteSize: number;
  updatedAt: Date;
}

const SAVE_STATE_COLUMNS = `
  id,
  user_id AS "userId",
  game_id AS "gameId",
  slot_id AS "slotId",
  r2_object_key AS "r2ObjectKey",
  byte_size AS "byteSize",
  updated_at AS "updatedAt"
`;

export async function upsertSaveState(
  userId: string,
  gameId: string,
  slotId: number,
  r2ObjectKey: string,
  byteSize: number,
): Promise<SaveStateRecord> {
  const result = await db.query<SaveStateRecord>(
    `
      INSERT INTO save_states (user_id, game_id, slot_id, r2_object_key, byte_size, updated_at)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id, game_id, slot_id)
      DO UPDATE SET
        r2_object_key = EXCLUDED.r2_object_key,
        byte_size = EXCLUDED.byte_size,
        updated_at = CURRENT_TIMESTAMP
      RETURNING ${SAVE_STATE_COLUMNS}
    `,
    [userId, gameId, slotId, r2ObjectKey, byteSize],
  );
  const record = result.rows[0];
  if (!record) throw new Error('Save-state upsert returned no record');
  return record;
}

export async function getSaveState(
  userId: string,
  gameId: string,
  slotId: number,
): Promise<SaveStateRecord | null> {
  const result = await db.query<SaveStateRecord>(
    `
      SELECT ${SAVE_STATE_COLUMNS}
      FROM save_states
      WHERE user_id = $1 AND game_id = $2 AND slot_id = $3
    `,
    [userId, gameId, slotId],
  );
  return result.rows[0] ?? null;
}
