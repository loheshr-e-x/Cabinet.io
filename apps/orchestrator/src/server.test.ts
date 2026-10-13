import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import type { WebSocket } from '@fastify/websocket';
import type {
  AuthCredentials,
  AuthRepository,
  AuthUser,
} from './db/authRepository.js';
import type { GamesRepository } from './db/gamesRepository.js';
import { buildServer } from './server.js';

const JWT_SECRET = 'test-signaling-gateway-secret-that-is-at-least-32-characters';
const TEST_GAME_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440001';
const testGamesRepository: GamesRepository = {
  async listGames() {
    return [];
  },
  async getLaunchDetails(gameId) {
    return gameId === TEST_GAME_ID
      ? { id: TEST_GAME_ID, systemCore: 'nes', romR2Key: 'roms/test-game.nes' }
      : null;
  },
};

async function createSession(
  app: Awaited<ReturnType<typeof buildServer>>,
  token: string,
  gameId = TEST_GAME_ID,
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/session/start',
    headers: { authorization: `Bearer ${token}` },
    payload: { gameId },
  });
  return {
    response,
    body: response.json() as {
      sessionId: string;
      edgeNodeId: string;
      edgeWsUrl: string;
    },
  };
}

function nextMessage(socket: WebSocket) {
  return once(socket, 'message').then(([data]) => data.toString());
}

test('signs up and authenticates users with a JWT subject tied to the database user', async () => {
  const user: AuthUser = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'player@example.com',
    username: 'arcade_player',
  };
  let savedCredentials: AuthCredentials | null = null;
  const repository: AuthRepository = {
    async createUser(email, username, passwordHash) {
      if (savedCredentials) {
        const error = Object.assign(new Error('duplicate account'), { code: '23505' });
        throw error;
      }
      savedCredentials = { ...user, email, username, passwordHash };
      return { ...user, email, username };
    },
    async findUserByEmail(email) {
      return savedCredentials?.email === email ? savedCredentials : null;
    },
  };
  const app = await buildServer(JWT_SECRET, repository);
  await app.ready();
  try {
    const invalidSignup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { username: 'ab', email: 'invalid', password: 'short' },
    });
    assert.equal(invalidSignup.statusCode, 400);

    const signup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        username: 'Arcade_Player',
        email: 'PLAYER@example.com',
        password: 'A-secure-password-123',
      },
    });
    assert.equal(signup.statusCode, 201);
    const signupBody = signup.json() as {
      token: string;
      user: AuthUser;
    };
    assert.equal(signupBody.user.email, 'player@example.com');
    assert.equal(signupBody.user.username, 'arcade_player');
    assert.equal(app.jwt.verify<{ sub: string }>(signupBody.token).sub, user.id);
    assert.equal(
      await bcrypt.compare('A-secure-password-123', savedCredentials!.passwordHash),
      true,
    );

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        username: 'another_player',
        email: 'another@example.com',
        password: 'A-secure-password-123',
      },
    });
    assert.equal(duplicate.statusCode, 409);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ' PLAYER@example.com ', password: 'A-secure-password-123' },
    });
    assert.equal(login.statusCode, 200);
    assert.equal(
      app.jwt.verify<{ sub: string }>(login.json().token).sub,
      user.id,
    );

    const rejectedLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'player@example.com', password: 'incorrect-password' },
    });
    assert.equal(rejectedLogin.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('requires JWT authentication before creating sessions', async () => {
  const app = await buildServer(JWT_SECRET);
  await app.ready();
  try {
    const health = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
    });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: 'OK', service: 'orchestrator' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/session/start',
      payload: { gameId: 'game-1' },
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('serves the database game catalog only to authenticated users', async () => {
  const catalog = [
    {
      id: '550e8400-e29b-41d4-a716-446655440000',
      title: 'Arcade Adventure',
      system: 'libretro_snes',
    },
  ];
  const repository: GamesRepository = {
    async listGames() {
      return catalog;
    },
    async getLaunchDetails() {
      return null;
    },
  };
  const app = await buildServer(
    JWT_SECRET,
    undefined,
    repository,
    'wss://edge.example.com/ws',
  );
  await app.ready();
  try {
    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/api/v1/games',
    });
    assert.equal(unauthenticated.statusCode, 401);

    const token = app.jwt.sign({ sub: 'user-1' });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/games',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { games: catalog });
  } finally {
    await app.close();
  }
});

test('reports game catalog database failures without returning a fake catalog', async () => {
  const repository: GamesRepository = {
    async listGames() {
      throw new Error('database unavailable');
    },
    async getLaunchDetails() {
      throw new Error('database unavailable');
    },
  };
  const app = await buildServer(JWT_SECRET, undefined, repository);
  await app.ready();
  try {
    const token = app.jwt.sign({ sub: 'user-1' });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/games',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: 'Game catalog is unavailable' });
  } finally {
    await app.close();
  }
});

test('protects save metadata routes and validates database identifiers before querying', async () => {
  const app = await buildServer(JWT_SECRET);
  await app.ready();
  try {
    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/api/v1/saves/sync',
      payload: {
        gameId: '550e8400-e29b-41d4-a716-446655440000',
        slotId: 0,
        r2ObjectKey: 'saves/slot-0.lz4',
        byteSize: 128,
      },
    });
    assert.equal(unauthenticated.statusCode, 401);

    const token = app.jwt.sign({
      sub: '550e8400-e29b-41d4-a716-446655440001',
    });
    const invalidSave = await app.inject({
      method: 'POST',
      url: '/api/v1/saves/sync',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userId: 'another-user',
        gameId: 'not-a-uuid',
        slotId: 0,
        r2ObjectKey: 'saves/slot-0.lz4',
        byteSize: 128,
      },
    });
    assert.equal(invalidSave.statusCode, 400);
    assert.equal(invalidSave.json().error, 'gameId must be a UUID');

    const invalidLookup = await app.inject({
      method: 'GET',
      url: '/api/v1/saves/not-a-uuid/0',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(invalidLookup.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('allows owner to start, disconnect, and reconnect a session', async () => {
  const app = await buildServer(
    JWT_SECRET,
    undefined,
    testGamesRepository,
    'wss://edge.example.com/ws',
  );
  await app.ready();
  try {
    const token = app.jwt.sign({ sub: TEST_USER_ID });
    const { response, body } = await createSession(app, token);
    assert.equal(response.statusCode, 200);
    assert.match(body.sessionId, /^session_/);
    const edgeUrl = new URL(body.edgeWsUrl);
    assert.equal(edgeUrl.origin, 'wss://edge.example.com');
    const sessionClaims = app.jwt.verify<{
      tokenType: string;
      sessionId: string;
      userId: string;
      romKey: string;
      systemCore: string;
    }>(edgeUrl.searchParams.get('token') ?? '');
    assert.equal(sessionClaims.tokenType, 'edge-session');
    assert.equal(sessionClaims.sessionId, body.sessionId);
    assert.equal(sessionClaims.userId, TEST_USER_ID);
    assert.equal(sessionClaims.romKey, 'roms/test-game.nes');
    assert.equal(sessionClaims.systemCore, 'nes');

    const disconnected = await app.inject({
      method: 'POST',
      url: '/api/v1/session/disconnect',
      headers: { authorization: `Bearer ${token}` },
      payload: { sessionId: body.sessionId },
    });
    assert.equal(disconnected.json().status, 'GRACE_PERIOD_ACTIVE');

    const reconnected = await app.inject({
      method: 'POST',
      url: '/api/v1/session/reconnect',
      headers: { authorization: `Bearer ${token}` },
      payload: { sessionId: body.sessionId },
    });
    assert.equal(reconnected.json().status, 'RECONNECTED');

    const otherUser = app.jwt.sign({ sub: '550e8400-e29b-41d4-a716-446655440002' });
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/v1/session/disconnect',
      headers: { authorization: `Bearer ${otherUser}` },
      payload: { sessionId: body.sessionId },
    });
    assert.equal(forbidden.statusCode, 403);
  } finally {
    await app.close();
  }
});

test('authenticates signaling peers and relays offer and ICE candidate messages', async () => {
  const app = await buildServer(
    JWT_SECRET,
    undefined,
    testGamesRepository,
    'wss://edge.example.com/ws',
  );
  await app.ready();
  try {
    const clientToken = app.jwt.sign({ sub: TEST_USER_ID });
    const { body: session } = await createSession(app, clientToken);
    const edgeToken = app.jwt.sign({
      sub: 'edge-1',
      role: 'edge',
      edgeNodeId: session.edgeNodeId,
    });
    const client = await app.injectWS(
      `/ws/signaling?sessionId=${encodeURIComponent(session.sessionId)}`,
    );
    const edge = await app.injectWS(
      `/ws/signaling?sessionId=${encodeURIComponent(session.sessionId)}`,
    );

    try {
      const clientAuth = nextMessage(client);
      client.send(JSON.stringify({ type: 'auth', role: 'client', token: clientToken }));
      assert.equal(JSON.parse(await clientAuth).type, 'authenticated');

      const edgeAuth = nextMessage(edge);
      edge.send(JSON.stringify({ type: 'auth', role: 'edge', token: edgeToken }));
      assert.equal(JSON.parse(await edgeAuth).type, 'authenticated');

      const offer = { type: 'offer', sdp: 'mock-sdp' };
      const forwardedOffer = nextMessage(edge);
      client.send(JSON.stringify(offer));
      assert.deepEqual(JSON.parse(await forwardedOffer), offer);

      const candidate = { type: 'candidate', candidate: { candidate: 'mock-ice' } };
      const forwardedCandidate = nextMessage(client);
      edge.send(JSON.stringify(candidate));
      assert.deepEqual(JSON.parse(await forwardedCandidate), candidate);
    } finally {
      client.terminate();
      edge.terminate();
    }
  } finally {
    await app.close();
  }
});
