# 3. Security & Compliance

This document details the security constraints, threat models, and compliance boundaries established for the NRI Yield Advisory System.

## Authentication & Authorization Flows

The system implements a rigid **Zero Trust** two-tier security model.

### 1. External Authentication (User → Gateway)
All API Gateway endpoints prefixed with `/api/` mandate a valid JSON Web Token (JWT).
- **Mechanism:** JWT Bearer token issued by `auth-service` upon successful `POST /api/v1/auth/login`.
- **Validation:** `authenticateJwt` middleware validates the signature (HS256) and parses the user payload.
- **Support for Query Tokens:** For file downloads (like PDFs) where standard browser `GET` requests cannot easily pass headers, the Gateway successfully extracts `?token=<jwt>` from the URL.

### 2. Internal Authorization (Gateway → Internal Microservices)
Internal microservices do **NOT** trust direct HTTP connections, even if they contain a JWT. 
- **Mechanism:** The API Gateway constructs an HMAC-SHA256 signature using a shared `HMAC_SECRET`.
- **Payload:** The signature string comprises: `${timestamp}|${METHOD}|${path}|${sha256Hex(body)}`.
- **Timestamp Skew:** To prevent replay attacks, the middleware strictly validates the `X-Gateway-Timestamp` to ensure it falls within a configurable tight window.

### Role-Based Access Control (RBAC)
The decoded JWT dictates the user's role:
- **RM:** Standard Relationship Manager. Can view own history, can request calculations. Cannot view the "Market Rates" UI tab and cannot manually override rates.
- **SENIOR_RM / TREASURY:** Can manually override FX and Market Rates in calculations.
- **ADMIN:** Complete platform oversight. Can override rates and view history for ALL users.
- **AUDITOR:** Can view history globally but cannot execute overriding calculations.

> [!CAUTION]
> The HMAC shared secret (`config.security.hmacSecret`) acts as the root of trust for internal cluster communication. Under no circumstances should this secret be exposed to the Frontend, nor should internal services be publicly accessible via the load balancer.

## Data Classification & Compliance Mapping

| Data Type | Example | Storage Location | Compliance/Security Note |
|---|---|---|---|
| **Authentication Data** | Passwords, Tokens | MySQL | Passwords bcrypt-hashed. Refresh tokens strictly tracked. |
| **PII & Financial** | Customer ID, Asset Values | PostgreSQL, Redis | Customer balances fetched from CBS are temporarily cached in Redis (with TTL) and permanently archived in PostgreSQL via the Audit Service. |
| **Telemetry** | Trace IDs, Response Times | Stdout / Kibana | No PII in raw access logs. Structured JSON logging used universally. |

**Insecure Direct Object Reference (IDOR) Protections:**
- The `GET /history` endpoint explicitly forces the `employee_id` filter to match the requesting user's ID, *unless* their role is `ADMIN` or `AUDITOR`.

## Security Configuration & Threat Models

### 1. Cache Stampede & Stale Data
- **Threat:** If the backend ESB slows down, thousands of duplicate requests for the same Customer ID's portfolio could flood the system.
- **Mitigation:** The system actively masks network failures as standard 503s to avoid returning `null` or stale balances, minimizing the bank's financial liability.

### 2. Idempotency & Replay Attacks
- **Threat:** A user double-clicking "Calculate" could trigger duplicate intensive backend logic or redundant CBS fetches.
- **Mitigation:** The Gateway requires an `Idempotency-Key` (UUID) for `POST /optimize`. Redis tracks this key (set with `NX`), rejecting duplicates immediately with HTTP `409 Conflict`.

### 3. Application-Level DDoS
- **Threat:** High volume of requests overwhelming internal services.
- **Mitigation:** A centralized `rateLimiter` middleware sits on the Gateway using a sliding-window Redis pattern.
- **Fail-Fast Configuration:** The `ioredis` client is explicitly configured with `enableOfflineQueue: false`. If Redis crashes, the rate limiter instantly falls back to an in-memory limit instead of queueing infinitely and causing `EADDRINUSE` port exhaustion.
