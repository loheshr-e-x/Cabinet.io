import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import type { WebSocket } from '@fastify/websocket';
import { buildServer } from './server.js';

const JWT_SECRET = 'test-signaling-gateway-secret-that-is-at-least-32-characters';

async function createSession(
  app: Awaited<ReturnType<typeof buildServer>>,
  token: string,
  gameId = 'game-1',
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/session/start',
    headers: { authorization: `Bearer ${token}` },
    payload: { gameId },
  });
  return { response, body: response.json() as { sessionId: string; edgeNodeId: string } };
}

function nextMessage(socket: WebSocket) {
  return once(socket, 'message').then(([data]) => data.toString());
}

test('requires JWT authentication before creating sessions', async () => {
  const app = await buildServer(JWT_SECRET);
  await app.ready();
  try {
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
  const app = await buildServer(JWT_SECRET);
  await app.ready();
  try {
    const token = app.jwt.sign({ sub: 'user-1' });
    const { response, body } = await createSession(app, token);
    assert.equal(response.statusCode, 200);
    assert.match(body.sessionId, /^session_/);

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

    const otherUser = app.jwt.sign({ sub: 'user-2' });
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
  const app = await buildServer(JWT_SECRET);
  await app.ready();
  try {
    const clientToken = app.jwt.sign({ sub: 'user-1' });
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
