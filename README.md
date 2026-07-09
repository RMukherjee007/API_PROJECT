# NRI Yield Tool

An enterprise-grade, microservices-based advisory platform designed for CSB Bank's Relationship Managers (RMs). This platform provides intelligent, multi-currency yield optimization recommendations for NRI (Non-Resident Indian) clients, cross-referencing Core Banking System (CBS) portfolio data with live Treasury/FX rates.

## Architecture Overview

The NRI Yield Advisory Tool is built on a distributed microservices architecture using Node.js, Express, Redis, MySQL. It bridges the gap between client banking profiles (fetched from Core Banking Systems) and real-time Treasury/Market rates to advise Relationship Managers (RMs) and NRI clients on optimal money placement.

The system is built as a suite of highly decoupled Node.js microservices:

- **Frontend (SPA):** Static single-page application served with a lightweight Express proxy. RMs interface with this portal.
- **Gateway:** Central API gateway routing traffic, handling JWT authentication, request validation, and distributed rate limiting.
- **Yield Engine:** The core mathematical engine that evaluates NRE/FCNR products against the client's CBS portfolio, applying ALM (Asset Liability Management) policies.
- **ESB (Enterprise Service Bus Proxy):** A caching proxy and translation layer simulating the bank's internal message bus.
- **Bank Integration Service:** Narrow adapter that connects to the Core Banking System (CBS) to retrieve customer asset/liability views securely.
- **Auth Service:** Issues JWTs and handles authentication (currently mocking bank IAM integration).
- **Audit Service:** Immutable ledger for compliance. It records every recommendation generated and provides bulk PDF reporting for auditors.

*All inter-service communication is secured via HMAC-SHA256 request signing.*

## Prerequisites

- **Docker** and **Docker Compose**
- **Node.js v20+** (if running services locally outside of containers)
- **Kubernetes (kubectl/minikube)** (for production deployment)

## Local Development (Docker Compose)

The easiest way to run the entire stack locally is using Docker Compose. It will automatically build the images, provision a MySQL database, and set up a Redis cache.

1. **Clone the repository.**
2. **Start the stack:**
   ```bash
   docker-compose up --build -d
   ```
3. **Access the application:**
   - **Frontend UI:** `http://localhost:3000`
   - **API Gateway:** `http://localhost:8080`
4. **Stop the stack:**
   ```bash
   docker-compose down
   ```

## Local Development (Node.js)

1. **Configure Environment Variables**
   Copy the `.env.example` to `.env` and fill in any required development overrides.
   ```bash
   cp .env.example .env
   ```

2. **Run the Ecosystem**
   Use the `start:all` script to boot all microservices concurrently using `concurrently`.
   ```bash
   npm run start:all
   ```
   Alternatively, you can run individual services (ports may vary based on `.env` config):
   - API Gateway: `npm run start:gateway`
   - Auth Service: `npm run start:auth`
   - Yield Engine: `npm run start:yield-engine`
   - Audit Service: `npm run start:audit`
   - ESB Stub: `npm run start:esb`
   - Bank Integration: `npm run start:bank`
   - Frontend BFF: `npm run start:frontend`

## Accessing the UI

Once running, the primary access points are:
- **Frontend UI:** `http://localhost:3000`
- **API Gateway:** `http://localhost:8080`

**Authentication:**
- Authentication is currently bypassed with a placeholder SSO user. 
- Bank IAM/SSO integration should be configured in `auth-service` for production.

*(Note: Market Rates and Manual Overrides are hidden/restricted for standard RM roles.)*

## Production Deployment (Kubernetes)

The `k8s/` directory contains all necessary manifests to deploy the platform to a production Kubernetes cluster. The platform has been rigorously hardened (running as non-root, read-only filesystems).

1. **Create the Namespace:**
   ```bash
   kubectl apply -f k8s/namespace.yaml
   ```
2. **Configure Secrets:**
   *Important:* Do not use `secret.example.yaml` in production. Provision high-entropy keys for `HMAC_SHARED_SECRET` and `JWT_SECRET` via your Cloud Provider's Secret Manager or Vault.
3. **Deploy Configuration & Network Policies:**
   ```bash
   kubectl apply -f k8s/configmap.yaml
   kubectl apply -f k8s/network-policy.yaml
   ```

4. **Deploy Services:**
   ```bash
   kubectl apply -f k8s/redis-deployment.yaml
   kubectl apply -f k8s/esb-deployment.yaml
   kubectl apply -f k8s/yield-engine-deployment.yaml
   kubectl apply -f k8s/gateway-deployment.yaml
   kubectl apply -f k8s/frontend-deployment.yaml
   ```
5. **Apply Ingress:**
   ```bash
   kubectl apply -f k8s/ingress.yaml
   ```

## Security & Compliance

This platform has undergone rigorous security audits to comply with enterprise banking standards:
- **Zero Trust Network:** All service-to-service calls are explicitly authenticated using short-lived HMAC signatures.
- **Container Hardening:** Containers drop privileges, running as `UID 1000` (Node user) with `readOnlyRootFilesystem: true`.
- **Authorization:** Strict Role-Based Access Control (RBAC). RMs can only view their own audit logs, while Auditors have global visibility (mitigating IDOR vulnerabilities).
- **Data Protection:** `HttpOnly` cookies are utilized on the frontend to protect JWTs from XSS exfiltration.
- **Fail-fast Resilience:** Redis failures smoothly transition to in-memory fallbacks or return standard `503 Service Unavailable` errors without causing connection hangs or infinite loops.

## Running Tests

Unit and integration tests are available inside the respective microservice directories or at the root. To run unit and security tests:
```bash
npm run test:unit
npm run test:security
```
