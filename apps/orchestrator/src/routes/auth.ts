import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import type { AuthRepository } from '../db/authRepository.js';

interface AuthRouteOptions {
  repository: AuthRepository;
}

interface CredentialsBody {
  email?: unknown;
  password?: unknown;
  username?: unknown;
}

function isRecord(value: unknown): value is CredentialsBody {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

export const authRoutes: FastifyPluginAsync<AuthRouteOptions> = async (
  fastify,
  { repository },
) => {
  fastify.post('/signup', async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const username =
      typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!isValidEmail(email)) {
      return reply.code(400).send({ error: 'A valid email address is required' });
    }
    if (!/^[a-z0-9_-]{3,50}$/.test(username)) {
      return reply
        .code(400)
        .send({ error: 'Username must be 3–50 characters using letters, numbers, _ or -' });
    }
    if (
      password.length < 12 ||
      Buffer.byteLength(password, 'utf8') > 72
    ) {
      return reply
        .code(400)
        .send({ error: 'Password must be at least 12 characters and at most 72 bytes' });
    }

    try {
      const passwordHash = await bcrypt.hash(password, 12);
      const user = await repository.createUser(email, username, passwordHash);
      const token = fastify.jwt.sign(
        { sub: user.id, email: user.email, username: user.username },
        { expiresIn: '1d' },
      );
      return reply.code(201).send({ token, user });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: 'Email or username is already registered' });
      }
      request.log.error({ err: error }, '[Cabinet Auth] Failed to create account.');
      return reply.code(503).send({ error: 'Account service is unavailable' });
    }
  });

  fastify.post('/login', async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!isValidEmail(email) || password.length === 0 || Buffer.byteLength(password) > 72) {
      return reply.code(400).send({ error: 'A valid email and password are required' });
    }

    try {
      const user = await repository.findUserByEmail(email);
      if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        return reply.code(401).send({ error: 'Invalid email or password' });
      }

      const token = fastify.jwt.sign(
        { sub: user.id, email: user.email, username: user.username },
        { expiresIn: '1d' },
      );
      return reply.send({
        token,
        user: { id: user.id, email: user.email, username: user.username },
      });
    } catch (error) {
      request.log.error({ err: error }, '[Cabinet Auth] Failed to authenticate user.');
      return reply.code(503).send({ error: 'Authentication service is unavailable' });
    }
  });
};
