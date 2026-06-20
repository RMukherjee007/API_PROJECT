const { spawn } = require('child_process');

const services = [
  { name: 'ESB', command: 'node', args: ['src/esb/index.js'] },
  { name: 'Microservice', command: 'node', args: ['src/microservice/index.js'] },
  { name: 'Gateway', command: 'node', args: ['src/gateway/index.js'] },
  { name: 'Frontend', command: 'node', args: ['src/frontend/index.js'] }
];

const children = [];

services.forEach(service => {
  console.log(`[Manager] Starting ${service.name}...`);
  // Using shell: true so node can resolve paths correctly on any environment
  const child = spawn(service.command, service.args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: true
  });

  child.stdout.on('data', data => {
    // Prefix output lines with the service name for clear debugging
    const lines = data.toString().trim().split('\n');
    lines.forEach(line => {
      if (line) console.log(`[${service.name}] ${line}`);
    });
  });

  child.stderr.on('data', data => {
    const lines = data.toString().trim().split('\n');
    lines.forEach(line => {
      if (line) console.error(`[${service.name}] ERROR: ${line}`);
    });
  });

  child.on('close', code => {
    console.log(`[Manager] ${service.name} exited with code ${code}`);
  });

  children.push(child);
});

// Handle termination signals to clean up child processes
const cleanup = () => {
  console.log('\n[Manager] Shutting down all services...');
  children.forEach(child => {
    try {
      child.kill();
    } catch (e) {
      // ignore
    }
  });
  process.exit();
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);
