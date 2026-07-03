# 2. Infrastructure & Deployment (DevOps)

This document covers the infrastructure components, containerization strategy, environment configuration, and dependency management for the NRI Yield Advisory System.

## Container & Orchestration Strategy

The system is designed to be cloud-native and operates in a fully containerized ecosystem.

### Data Stores (docker-compose)
The project ships with a `docker-compose.yml` file to spin up necessary local data stores:
- **MySQL (`auth_db`):** Port `3306`. Used by `auth-service` to store user credentials and tokens.
- **PostgreSQL (`audit_db`):** Port `5432`. Used by `audit-service` to persist immutable calculation logs.
- **Redis (`redis_cache`):** Port `6379`. Used heavily by `gateway`, `auth-service`, `yield-engine`, and `audit-service` for:
  - Global Rate Limiting
  - Idempotency Checks (preventing double-processing of calculations)
  - Portfolio/CBS Response Caching

### Microservices Containerization
Each service directory contains a standardized `Dockerfile`.
- **Base Image:** `node:18-alpine` for minimal footprint and security.
- **Build Context:** Because microservices depend on the `src/shared` directory, Docker build contexts must typically be set at the monorepo root to allow inclusion of `shared/`.

*Example Production K8s Deployment Plan:* Deploy the 7 Node.js services as individual ReplicaSets behind an Ingress Controller, routing external traffic exclusively to the Frontend BFF and the API Gateway.

## Environment Variables & Secrets Guide

The system uses a single unified `.env` structure (defined in `.env.example`).

### Core & Non-Sensitive Variables
These dictate routing and standard behavior:
- `PORT_GATEWAY=3000`
- `PORT_AUTH=3001`
- `PORT_YIELD_ENGINE=3002`
- `PORT_AUDIT=3003`
- `PORT_ESB=3005`
- `PORT_BANK_INTEGRATION=3006`
- `PORT_FRONTEND=8080`
- `LOG_LEVEL=info` (Winston logger level)
- `REDIS_URL=redis://localhost:6379`

### Sensitive Secrets (Vault / AWS Secrets Manager)
These values **must** be injected securely via a secret manager in production and never hardcoded:
- `HMAC_SECRET`: 64-character hex string. Used for internal Machine-to-Machine request signing. If this leaks, an attacker can bypass the API gateway and directly invoke internal microservices.
- `JWT_SECRET`: Used to sign and verify user JWT Bearer tokens.
- `DB_USER` / `DB_PASSWORD`: For MySQL.
- `AUDIT_DB_USER` / `AUDIT_DB_PASSWORD`: For PostgreSQL.

## Dependency Manifests

This project functions as an npm workspace/monorepo. 
- **`package.json` (Root):** Contains standard `npm run start:*` scripts and `concurrently` for local development.
- **`package-lock.json`:** Tracks deterministic dependency versions.

**Critical Runtime Dependencies:**
- `express`: Core web framework.
- `ioredis`: Redis client. Configured specifically with `enableOfflineQueue: false` for strict fail-fast behavior.
- `mysql2` & `pg`: Database drivers.
- `pdfkit`: Used in `audit-service` for generating cryptographically signed PDFs.
- `jsonwebtoken` & `bcryptjs`: For auth handling.

*Maintenance Note:* The DevOps team should routinely run `npm audit` on the root `package.json` to monitor upstream CVEs in these critical packages.
