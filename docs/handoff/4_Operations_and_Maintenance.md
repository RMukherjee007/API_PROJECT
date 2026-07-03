# 4. Operations, Maintenance & Support

This document details the observability practices, runbooks for common incidents, and deployment pipelines.

## Observability & Monitoring Playbook

### Logging Strategy
- **Library:** `winston`
- **Format:** Structured JSON (`winston.format.json()`). Ensures seamless ingestion into ELK (Elasticsearch, Logstash, Kibana) or Datadog.
- **Correlation:** Every incoming request receives a unique `x-correlation-id` at the API Gateway. This ID is passed downstream to all internal microservices via the `correlationMiddleware`.
- **W3C Trace Context:** The system fully supports `traceparent` headers for distributed tracing, allowing exact visualization of request latency across the Gateway, Auth, Yield Engine, and Bank API.

### Key Metrics (Prometheus)
A global `metricsMiddleware` exposes `GET /metrics` on every microservice port.
- `http_requests_total`: To track traffic spikes.
- `http_request_duration_seconds`: Histogram to track 95th and 99th percentile latencies (SLO target: P95 < 200ms).
- `redis_connections_active`: To ensure no connection leaks.

## Runbook for Common Incidents

### Incident 1: "Gateway is Unreachable" / EADDRINUSE
**Symptom:** UI displays "Gateway is unreachable". Logs show `ECONNREFUSED` or `EADDRINUSE`.
**Root Cause Analysis (RCA):** If Redis crashes or undergoes maintenance, older configurations of `ioredis` would queue requests infinitely in memory, refusing to fail, which eventually exhausted all available network sockets (`EADDRINUSE`).
**Resolution:** This was resolved by setting `enableOfflineQueue: false` in the Redis configuration. 
**Immediate Action:** If this occurs again, check if Redis is actively OOM-crashing. Restart the Node.js API Gateway process to release any hung sockets.

### Incident 2: "One or more fields failed format validation"
**Symptom:** RMs cannot generate calculations.
**Root Cause Analysis (RCA):** The Yield Engine strictly expects `principal_amount` and other numerical values to be formatted as strings with exactly two decimal places (e.g., `"50000.00"`). The frontend was previously sending integers or floating-point numbers.
**Resolution:** This was fixed in `app.js` by explicitly coercing values with `.toFixed(2)`.
**Immediate Action:** Verify if the client browser has aggressively cached the old `app.js`. Ask the user to hard refresh (`Cmd + Shift + R`). 

### Incident 3: Missing History / "No suggestions yet"
**Symptom:** RMs do not see their past calculations in the Suggestion History tab.
**Root Cause Analysis (RCA):** The API response schema from the Yield Engine `/history` endpoint wraps the payload in `{ logs: [...] }`, but older frontend versions expected `{ items: [...] }`.
**Resolution:** Fixed in the frontend to gracefully handle both `logs` and `items`.
**Immediate Action:** Hard refresh the browser.

## CI/CD Pipeline Recommendations

For the target DevOps team taking ownership of this repository:

1. **Build Phase:**
   - Execute `npm install` on a pristine `node:18` runner.
   - Run unit tests: `npm run test` (e.g., validating `engine.test.js` and `almPolicyEngine.test.js`).
   - Run dependency audit: `npm audit --audit-level=high`.

2. **Bake Phase:**
   - Build individual Docker images for each service (using the root directory as context).
   - Tag with the short Git commit hash and push to a private Elastic Container Registry (ECR/GCR).

3. **Deploy Phase (Staging → Prod):**
   - Use Helm or Kustomize to update the container image tags in the Kubernetes deployment manifests.
   - Execute a Rolling Update. Ensure readiness probes are pointed to `GET /health` on each microservice before draining old pods.
