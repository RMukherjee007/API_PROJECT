const { spawn } = require('child_process');

const services = [
  { name: 'Auth', command: 'node', args: ['src/auth-service/src/index.js'] },
  { name: 'Audit', command: 'node', args: ['src/audit-service/src/index.js'] },
  { name: 'ESB', command: 'node', args: ['src/esb/index.js'] },
  { name: 'BankIntegration', command: 'node', args: ['src/bank-integration-service/src/index.js'] },
  { name: 'YieldEngine', command: 'node', args: ['src/yield-engine/src/index.js'] },
  { name: 'Gateway', command: 'node', args: ['src/gateway/index.js'] },
  { name: 'Frontend', command: 'node', args: ['src/frontend/index.js'] },
];

const children = [];
const childEnv = {
  ...process.env,
  REDIS_ENABLED: process.env.REDIS_ENABLED || 'false',
  REDIS_URL: process.env.REDIS_URL === 'redis://redis:6379' ? 'redis://127.0.0.1:6379' : process.env.REDIS_URL,
  YIELD_ENGINE_URL: process.env.YIELD_ENGINE_URL === 'http://yield-engine:8082' ? 'http://127.0.0.1:8082' : (process.env.YIELD_ENGINE_URL || 'http://127.0.0.1:8082'),
  ESB_URL: process.env.ESB_URL === 'http://esb:8081' ? 'http://127.0.0.1:8081' : (process.env.ESB_URL || 'http://127.0.0.1:8081'),
  AUDIT_SERVICE_URL: process.env.AUDIT_SERVICE_URL === 'http://audit:8084' ? 'http://127.0.0.1:8084' : (process.env.AUDIT_SERVICE_URL || 'http://127.0.0.1:8084'),
  AUTH_SERVICE_URL: process.env.AUTH_SERVICE_URL === 'http://auth:8083' ? 'http://127.0.0.1:8083' : (process.env.AUTH_SERVICE_URL || 'http://127.0.0.1:8083'),
  BANK_INTEGRATION_SERVICE_URL: process.env.BANK_INTEGRATION_SERVICE_URL === 'http://bank:8085' ? 'http://127.0.0.1:8085' : (process.env.BANK_INTEGRATION_SERVICE_URL || 'http://127.0.0.1:8085'),
};

services.forEach((service) => {
  console.log(`[Manager] Starting ${service.name}...`);
  const child = spawn(service.command, service.args, { stdio: ['inherit', 'pipe', 'pipe'], shell: false, env: childEnv });
  child.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach((line) => { if (line) console.log(`[${service.name}] ${line}`); });
  });
  child.stderr.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach((line) => { if (line) console.error(`[${service.name}] ERROR: ${line}`); });
  });
  child.on('close', (code) => console.log(`[Manager] ${service.name} exited with code ${code}`));
  children.push(child);
});

const cleanup = () => {
  console.log('\n[Manager] Shutting down all services...');
  children.forEach((child) => { try { child.kill(); } catch { /* ignore */ } });
  process.exit();
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);
