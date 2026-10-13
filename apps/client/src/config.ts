export const ORCHESTRATOR_URL = (
  import.meta.env.VITE_ORCHESTRATOR_URL || 'http://localhost:3000'
).replace(/\/+$/, '');
