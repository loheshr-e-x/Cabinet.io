import { db } from './client.js';

export interface CatalogGame {
  id: string;
  title: string;
  system: string;
}

export interface GamesRepository {
  listGames(): Promise<CatalogGame[]>;
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
};
