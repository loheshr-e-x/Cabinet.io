import { db } from './client.js';

export interface AuthUser {
  id: string;
  email: string;
  username: string;
}

export interface AuthCredentials extends AuthUser {
  passwordHash: string;
}

export interface AuthRepository {
  createUser(email: string, username: string, passwordHash: string): Promise<AuthUser>;
  findUserByEmail(email: string): Promise<AuthCredentials | null>;
}

export const authRepository: AuthRepository = {
  async createUser(email, username, passwordHash) {
    const result = await db.query<AuthUser>(
      `INSERT INTO users (email, username, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id::text, email, username`,
      [email, username, passwordHash],
    );
    return result.rows[0];
  },

  async findUserByEmail(email) {
    const result = await db.query<AuthCredentials>(
      `SELECT id::text, email, username, password_hash AS "passwordHash"
       FROM users
       WHERE email = $1`,
      [email],
    );
    return result.rows[0] ?? null;
  },
};
