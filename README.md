NRI Yield Advisory Tool

A microservice ecosystem for calculating and recommending optimal deposit products (FCNR vs. NRE) for NRI customers, based on real-time market rates and existing portfolio assets/liabilities.

## Overview

The NRI Yield Advisory Tool is built on a distributed microservices architecture using Node.js, Express, Redis, MySQL, and PostgreSQL. It bridges the gap between client banking profiles (fetched from Core Banking Systems) and real-time Treasury/Market rates to advise Relationship Managers (RMs) and NRI clients on optimal money placement.

### Key Capabilities
- **Real-time Yield Calculation:** Automatically compares FCNR (Foreign Currency Non-Resident) and NRE (Non-Resident External) yields, factoring in forward premiums and internal ALM penalties.
- **Portfolio Integration:** Dynamically fetches existing customer assets and liabilities from the bank's CBS via an Enterprise Service Bus (ESB) integration.
- **Strict Role-Based Access Control (RBAC):** Tiered permissions enforcing that only Senior RMs, Treasury, or Admins can manually override market/FX rates.
- **Immutable Audit Trails:** Dedicated audit service recording all recommendations, capable of generating cryptographically verifable PDF reports in bulk.
- **Robust Rate Limiting & Idempotency:** Redis-backed rate limiting with graceful in-memory fallbacks, and strict idempotency checks to prevent duplicate execution of financial calculations.

## Documentation Handoff Package

A comprehensive documentation package has been generated for a smooth operational and security handoff. Please refer to the files in the `docs/handoff/` directory:

1. **[Architecture & Design](./docs/handoff/1_Architecture_and_Design.md):** System diagrams, data flows, and API specifications.
2. **[Infrastructure & Deployment](./docs/handoff/2_Infrastructure_and_Deployment.md):** Docker orchestration, environment variables, and dependency management.
3. **[Security & Compliance](./docs/handoff/3_Security_and_Compliance.md):** Auth mechanisms, data classification, and threat models.
4. **[Operations, Maintenance & Support](./docs/handoff/4_Operations_and_Maintenance.md):** Observability, runbooks, and CI/CD considerations.
5. **[Final Handoff & Sign-Off](./docs/handoff/5_Final_Handoff_and_SignOff.md):** Security audit reports and the transition checklist.

## Quick Start

### Prerequisites
- Node.js (v18+)
- Docker & Docker Compose (for spinning up data stores)
- NPM

### 1. Start Infrastructure Dependencies
Spin up Redis (Caching/Limiting), MySQL (Auth), and PostgreSQL (Audit logs).
```bash
docker-compose up -d
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment Variables
Copy the `.env.example` to `.env` and fill in any required development overrides.
```bash
cp .env.example .env
```

### 4. Run the Ecosystem (Development)
Use the `start:all` script to boot all microservices concurrently using `concurrently`.
```bash
npm run start:all
```
Alternatively, you can run individual services:
- API Gateway: `npm run start:gateway` (Port 3000)
- Auth Service: `npm run start:auth` (Port 3001)
- Yield Engine: `npm run start:yield-engine` (Port 3002)
- Audit Service: `npm run start:audit` (Port 3003)
- ESB Stub: `npm run start:esb` (Port 3005)
- Bank Integration: `npm run start:bank` (Port 3006)
- Frontend BFF: `npm run start:frontend` (Port 8080)

## Accessing the UI
Once running, the UI is available at `http://localhost:8080/`.

**Test Accounts:**
- **RM User:** `rm.test@csb.co.in` / `password123`
- **Senior RM User:** `senior.rm.test@csb.co.in` / `password123`
- **Treasury User:** `treasury.test@csb.co.in` / `password123`
- **Admin User:** `raghav.mukherjee@csb.co.in` / `HelloWorld@1729`

*(Note: Market Rates and Manual Overrides are hidden/restricted for standard RM roles.)*

## Architecture Highlights
- **API Gateway:** Central entry point handling public routing, token validation, rate-limiting, and signing internal requests.
- **HMAC Signatures:** Machine-to-machine communication is secured via strict HMAC-SHA256 signatures injected by the Gateway, preventing lateral spoofing.
- **Fail-fast Resilience:** Redis failures smoothly transition to in-memory fallbacks or return standard `503 Service Unavailable` errors without causing connection hangs or infinite loops.

---
