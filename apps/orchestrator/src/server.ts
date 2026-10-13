import 'dotenv/config';
import fastifyCors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyWebsocket, { type WebSocket } from '@fastify/websocket';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { authRepository, type AuthRepository } from './db/authRepository.js';
import { verifyDatabaseConnection } from './db/client.js';
import { getSaveState, upsertSaveState } from './db/saveRepository.js';
import { authRoutes } from './routes/auth.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: {
      sub: string;
      email?: string;
      username?: string;
      role?: string;
      edgeNodeId?: string;
    };
  }
}

type SignalRole = 'client' | 'edge';
type SignalingPayload = {
  type: 'offer' | 'answer' | 'candidate' | 'client-reconnected';
  [key: string]: unknown;
};

interface SessionState {
  userId: string;
  gameId: string;
  edgeNodeId: string;
  teardownTimer: NodeJS.Timeout | null;
  peers: Partial<Record<SignalRole, WebSocket>>;
  pendingSignals: Partial<Record<SignalRole, SignalingPayload[]>>;
}

const GRACE_PERIOD_MS = 60_000;
const SIGNALING_MESSAGE_LIMIT = 1_048_576;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function buildServer(
  jwtSecret: string,
  users: AuthRepository = authRepository,
) {
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }

  const fastify = Fastify({ logger: true });
  const activeSessions = new Map<string, SessionState>();

  await fastify.register(fastifyCors, { origin: process.env.CORS_ORIGIN ?? '*' });
  await fastify.register(fastifyJwt, { secret: jwtSecret });
  await fastify.register(fastifyWebsocket, {
    options: { maxPayload: SIGNALING_MESSAGE_LIMIT },
  });
  await fastify.register(authRoutes, {
    prefix: '/api/v1/auth',
    repository: users,
  });

  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };

  const getOwnedSession = (
    request: FastifyRequest,
    reply: FastifyReply,
    sessionId: unknown,
  ): SessionState | null => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      reply.code(400).send({ error: 'sessionId is required' });
      return null;
    }

    const session = activeSessions.get(sessionId);
    if (!session) {
      reply.code(404).send({ error: 'Session not found' });
      return null;
    }
    if (session.userId !== request.user.sub) {
      reply.code(403).send({ error: 'Forbidden' });
      return null;
    }

    return session;
  };

  const startGracePeriod = (sessionId: string, session: SessionState) => {
    if (session.teardownTimer) clearTimeout(session.teardownTimer);

    session.teardownTimer = setTimeout(() => {
      fastify.log.info(`[Cabinet Grace Period] 60s expired for session ${sessionId}.`);
      for (const peer of Object.values(session.peers)) peer?.close(1000, 'Session expired');
      activeSessions.delete(sessionId);
    }, GRACE_PERIOD_MS);
    session.teardownTimer.unref();
    fastify.log.warn(
      `[Cabinet Grace Period] Session ${sessionId} disconnected. Waiting 60s for client recovery.`,
    );
  };

  fastify.get('/health', async () => ({ status: 'OK', service: 'orchestrator' }));

  fastify.post(
    '/api/v1/saves/sync',
    { preHandler: authenticate },
    async (request, reply) => {
      const body = request.body as
        | {
            gameId?: unknown;
            slotId?: unknown;
            r2ObjectKey?: unknown;
            byteSize?: unknown;
          }
        | undefined;

      if (typeof request.user.sub !== 'string' || !UUID_PATTERN.test(request.user.sub)) {
        return reply.code(401).send({ error: 'Authenticated user must have a UUID subject' });
      }
      if (typeof body?.gameId !== 'string' || !UUID_PATTERN.test(body.gameId)) {
        return reply.code(400).send({ error: 'gameId must be a UUID' });
      }
      if (
        !Number.isInteger(body.slotId) ||
        (body.slotId as number) < 0 ||
        (body.slotId as number) > 255
      ) {
        return reply.code(400).send({ error: 'slotId must be an integer from 0 to 255' });
      }
      if (
        !Number.isInteger(body.byteSize) ||
        (body.byteSize as number) <= 0 ||
        (body.byteSize as number) > 2_147_483_647
      ) {
        return reply.code(400).send({ error: 'byteSize must be a positive 32-bit integer' });
      }
      if (
        typeof body.r2ObjectKey !== 'string' ||
        body.r2ObjectKey.length === 0 ||
        body.r2ObjectKey.length > 500 ||
        body.r2ObjectKey.startsWith('/') ||
        body.r2ObjectKey.split('/').includes('..')
      ) {
        return reply.code(400).send({ error: 'r2ObjectKey must be a valid object key' });
      }

      try {
        const record = await upsertSaveState(
          request.user.sub,
          body.gameId,
          body.slotId as number,
          body.r2ObjectKey,
          body.byteSize as number,
        );
        return reply.send({ status: 'SUCCESS', record });
      } catch (error) {
        request.log.error({ err: error }, '[Cabinet DB] Failed to record save metadata.');
        return reply.code(503).send({ error: 'Save metadata storage is unavailable' });
      }
    },
  );

  fastify.get(
    '/api/v1/saves/:gameId/:slotId',
    { preHandler: authenticate },
    async (request, reply) => {
      const { gameId, slotId: rawSlotId } = request.params as {
        gameId: string;
        slotId: string;
      };
      const slotId = Number(rawSlotId);
      if (typeof request.user.sub !== 'string' || !UUID_PATTERN.test(request.user.sub)) {
        return reply.code(401).send({ error: 'Authenticated user must have a UUID subject' });
      }
      if (!UUID_PATTERN.test(gameId)) {
        return reply.code(400).send({ error: 'gameId must be a UUID' });
      }
      if (!/^(0|[1-9]\d*)$/.test(rawSlotId) || !Number.isInteger(slotId) || slotId > 255) {
        return reply.code(400).send({ error: 'slotId must be an integer from 0 to 255' });
      }

      try {
        const record = await getSaveState(request.user.sub, gameId, slotId);
        if (!record) return reply.code(404).send({ error: 'Save state not found' });
        return reply.send({ record });
      } catch (error) {
        request.log.error({ err: error }, '[Cabinet DB] Failed to query save metadata.');
        return reply.code(503).send({ error: 'Save metadata storage is unavailable' });
      }
    },
  );

  fastify.post(
    '/api/v1/session/start',
    { preHandler: authenticate },
    async (request, reply) => {
      const body = request.body as { gameId?: unknown } | undefined;
      if (typeof body?.gameId !== 'string' || body.gameId.trim().length === 0) {
        return reply.code(400).send({ error: 'gameId is required' });
      }

      const sessionId = `session_${randomUUID()}`;
      const session: SessionState = {
        userId: request.user.sub,
        gameId: body.gameId,
        edgeNodeId: 'edge-node-region-a',
        teardownTimer: null,
        peers: {},
        pendingSignals: {},
      };
      activeSessions.set(sessionId, session);
      const protocol = request.protocol === 'https' ? 'wss' : 'ws';

      return reply.send({
        sessionId,
        edgeNodeId: session.edgeNodeId,
        signalingUrl: `${protocol}://${request.hostname}/ws/signaling?sessionId=${encodeURIComponent(sessionId)}`,
      });
    },
  );

  fastify.post(
    '/api/v1/session/disconnect',
    { preHandler: authenticate },
    async (request, reply) => {
      const body = request.body as { sessionId?: unknown } | undefined;
      const session = getOwnedSession(request, reply, body?.sessionId);
      if (!session) return reply;

      const sessionId = body?.sessionId as string;
      startGracePeriod(sessionId, session);
      return reply.send({ status: 'GRACE_PERIOD_ACTIVE', durationSeconds: 60 });
    },
  );

  fastify.post(
    '/api/v1/session/reconnect',
    { preHandler: authenticate },
    async (request, reply) => {
      const body = request.body as { sessionId?: unknown } | undefined;
      const session = getOwnedSession(request, reply, body?.sessionId);
      if (!session) return reply;

      if (session.teardownTimer) {
        clearTimeout(session.teardownTimer);
        session.teardownTimer = null;
      }
      fastify.log.info(
        `[Cabinet Grace Period] Client successfully reconnected to session ${body?.sessionId}.`,
      );
      return reply.send({ status: 'RECONNECTED', edgeNodeId: session.edgeNodeId });
    },
  );

  fastify.get('/ws/signaling', { websocket: true }, (connection, request) => {
    const socket = connection;
    const sessionId = new URL(
      request.raw.url ?? request.url,
      'http://localhost',
    ).searchParams.get('sessionId');
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      socket.close(1008, 'sessionId is required');
      return;
    }

    let role: SignalRole | null = null;
    let session: SessionState | undefined;
    let messageQueue = Promise.resolve();

    const handleMessage = async (rawMessage: Buffer | ArrayBuffer | Buffer[]) => {
      const raw = Buffer.isBuffer(rawMessage)
        ? rawMessage.toString()
        : Array.isArray(rawMessage)
          ? Buffer.concat(rawMessage).toString()
          : Buffer.from(rawMessage).toString();
      if (Buffer.byteLength(raw) > SIGNALING_MESSAGE_LIMIT) {
        socket.close(1009, 'Message too large');
        return;
      }

      let payload: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('Expected a JSON object');
        }
        payload = parsed as Record<string, unknown>;
      } catch (error) {
        fastify.log.warn({ err: error }, '[Cabinet Signaling] Invalid JSON message.');
        socket.close(1003, 'Invalid JSON');
        return;
      }

      if (!role) {
        if (
          payload.type !== 'auth' ||
          typeof payload.token !== 'string' ||
          (payload.role !== 'client' && payload.role !== 'edge')
        ) {
          socket.close(1008, 'Signaling authentication required');
          return;
        }

        const targetSession = activeSessions.get(sessionId);
        if (!targetSession) {
          socket.close(1008, 'Session not found');
          return;
        }

        let claims: FastifyRequest['user'];
        try {
          claims = fastify.jwt.verify<FastifyRequest['user']>(payload.token);
        } catch {
          socket.close(1008, 'Invalid token');
          return;
        }

        if (
          (payload.role === 'client' && claims.sub !== targetSession.userId) ||
          (payload.role === 'edge' &&
            (claims.role !== 'edge' || claims.edgeNodeId !== targetSession.edgeNodeId))
        ) {
          socket.close(1008, 'Not authorized for this session');
          return;
        }

        role = payload.role;
        session = targetSession;
        if (role === 'client' && session.teardownTimer) {
          clearTimeout(session.teardownTimer);
          session.teardownTimer = null;
        }
        session.peers[role]?.close(1000, 'Replaced by a newer connection');
        session.peers[role] = socket;
        socket.send(JSON.stringify({ type: 'authenticated', role }));
        const queuedSignals = session.pendingSignals[role] ?? [];
        delete session.pendingSignals[role];
        for (const queuedSignal of queuedSignals) {
          socket.send(JSON.stringify(queuedSignal));
        }
        if (role === 'client' && session.peers.edge?.readyState === 1) {
          session.peers.edge.send(JSON.stringify({ type: 'client-reconnected' }));
        }
        fastify.log.info(
          `[Cabinet Signaling] Authenticated ${role} peer for session ${sessionId}.`,
        );
        return;
      }

      if (
        payload.type !== 'offer' &&
        payload.type !== 'answer' &&
        payload.type !== 'candidate'
      ) {
        fastify.log.warn(`[Cabinet Signaling] Unknown message type: ${String(payload.type)}`);
        return;
      }

      const recipientRole: SignalRole = role === 'client' ? 'edge' : 'client';
      const recipient = session?.peers[recipientRole];
      if (recipient?.readyState === 1) {
        recipient.send(JSON.stringify(payload));
      } else if (session) {
        const queued = session.pendingSignals[recipientRole] ?? [];
        if (queued.length >= 128) {
          fastify.log.warn(
            `[Cabinet Signaling] Pending signal limit reached for session ${sessionId}.`,
          );
          return;
        }
        queued.push(payload as SignalingPayload);
        session.pendingSignals[recipientRole] = queued;
      }
    };

    socket.on('message', (message: Buffer) => {
      messageQueue = messageQueue
        .then(() => handleMessage(message))
        .catch((error: unknown) => {
          fastify.log.error({ err: error }, '[Cabinet Signaling] Message handler failed.');
          socket.close(1011, 'Signaling error');
        });
    });

    socket.on('close', () => {
      if (!role || !session) return;
      if (session.peers[role] === socket) delete session.peers[role];
      if (role === 'client' && activeSessions.get(sessionId) === session) {
        startGracePeriod(sessionId, session);
      }
    });
  });

  return fastify;
}

async function start() {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) throw new Error('JWT_SECRET must be configured');

  const fastify = await buildServer(jwtSecret);
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  await fastify.listen({ port, host });
  void verifyDatabaseConnection();
  fastify.log.info(`[Cabinet Control Plane] Orchestrator running on http://localhost:${port}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error: unknown) => {
    console.error('[Cabinet Control Plane] Startup failed:', error);
    process.exitCode = 1;
  });
}
