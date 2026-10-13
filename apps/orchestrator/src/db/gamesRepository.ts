import { db } from './client.js';

export interface CatalogGame {
  id: string;
  title: string;
  system: string;
}

export interface GameLaunchDetails {
  id: string;
  systemCore: string;
  romR2Key: string;
}

export interface GamesRepository {
  listGames(): Promise<CatalogGame[]>;
  getLaunchDetails(gameId: string): Promise<GameLaunchDetails | null>;
}

export const gamesRepository: GamesRepository = {
  async listGames() {
    const result = await db.query<CatalogGame>(
      `SELECT id::text, title, system_core AS system
       FROM games
       ORDER BY title ASC`,
    );
    return result.rows;
  },

  async getLaunchDetails(gameId) {
    const result = await db.query<GameLaunchDetails>(
      // Launch metadata is read from its own column; display-title edits cannot derive or replace this key.
      `SELECT id::text, system_core AS "systemCore", rom_r2_key AS "romR2Key"
       FROM games
       WHERE id = $1`,
      [gameId],
    );
    return result.rows[0] ?? null;
  },
};
