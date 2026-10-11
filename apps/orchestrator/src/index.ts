import Fastify from 'fastify';

const fastify = Fastify({ logger: true });

// Health Check
fastify.get('/health', async () => {
  return { status: 'OK', service: 'orchestrator' };
});

// 1. Start a Session Endpoint
fastify.post('/api/v1/session/start', async (request, reply) => {
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 7);
  
  return {
    sessionId: `session_${timestamp}_${randomSuffix}`,
    edgeNodeId: "edge-node-region-a",
    signalingUrl: `ws://localhost:3000/ws/signaling?sessionId=session_${timestamp}_${randomSuffix}`
  };
});

// 2. Test Connection Disconnect & Grace Period Endpoint
fastify.post('/api/v1/session/disconnect', async (request, reply) => {
  const { sessionId } = request.body as { sessionId: string };
  
  fastify.log.warn(`Session ${sessionId} entered its 60-second teardown window.`);
  
  return {
    status: "GRACE_PERIOD_ACTIVE",
    durationSeconds: 60
  };
});

const start = async () => {
  try {
    const port = Number(process.env.PORT) || 3000;
    await fastify.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
