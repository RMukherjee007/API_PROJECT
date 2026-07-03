const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
let failures = 0;

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function fail(message) {
  failures += 1;
  console.error(`FAIL: ${message}`);
}

function pass(message) {
  console.log(`PASS: ${message}`);
}

function assertNotContains(file, pattern, message) {
  const content = read(file);
  if (pattern.test(content)) fail(`${message} (${file})`);
  else pass(message);
}

assertNotContains('src/frontend/public/index.html', /X-Internal-Signature|computeHMAC|HMAC_SHARED_SECRET|hmac_secret|localhost:8080/, 'frontend bundle does not expose signing material or direct gateway URLs');
assertNotContains('src/frontend/public/index.html', /socket\.io|predict|monte-carlo|logs\/download|swift|iso20022|deposits\/book|sanctions/i, 'frontend exposes only advice, rates, history, and report features');
assertNotContains('src/auth-service/src/index.js', /hmac\/exchange|hmac_session|sessionSecret|Demo@123/, 'auth service does not expose browser HMAC exchange or fixed demo passwords');
assertNotContains('src/gateway/index.js', /hmac\/exchange|hmac_session/, 'gateway does not proxy obsolete HMAC exchange route');
assertNotContains('src/gateway/index.js', /\/predict|\/monte-carlo|\/bank\/swift|\/bank\/iso20022|\/bank\/deposits|\/bank\/sanctions|logs\/download/, 'gateway exposes only the narrowed advisory surface');
assertNotContains('src/bank-integration-service/src/index.js', /\/swift|\/iso20022|\/deposits|\/sanctions|MT103|pain\.001/i, 'bank integration is narrowed to portfolio enrichment');
assertNotContains('docker-compose.yml', /\$\{HMAC_SHARED_SECRET:-|\$\{JWT_SECRET:-|change-me-in-production-use-random-64-char-string|change-me-jwt-secret/, 'compose does not default service secrets');

const missingSecret = spawnSync(process.execPath, ['-e', "require('./src/shared/config')"], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    HMAC_SHARED_SECRET: '',
    JWT_SECRET: '',
  },
  encoding: 'utf8',
});
if (missingSecret.status === 0) fail('config must fail closed when HMAC/JWT secrets are missing');
else pass('config fails closed when HMAC/JWT secrets are missing');

const weakProd = spawnSync(process.execPath, ['-e', "require('./src/shared/config')"], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    HMAC_SHARED_SECRET: 'change-me-in-production-use-random-64-char-string',
    JWT_SECRET: 'change-me-jwt-secret-change-me-jwt-secret',
    STORAGE_DRIVER: 'postgres',
    BANK_LIVE_MODE: 'true',
    CBS_ADAPTER_URL: 'https://bank.example/cbs',
    FX_FEED_PROVIDER: 'bank-tms',
    TMS_MARKET_DATA_URL: 'https://bank.example/tms',
    BCRYPT_ROUNDS: '12',
  },
  encoding: 'utf8',
});
if (weakProd.status === 0) fail('production config must reject placeholder-like secrets');
else pass('production config rejects placeholder-like secrets');

if (failures > 0) {
  console.error(`${failures} security smoke check(s) failed.`);
  process.exit(1);
}

console.log('Security smoke checks passed.');
