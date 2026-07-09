# Technology Stack

This document outlines the technology stack used in the CSB Bank API project.

## Backend

- **Language:** Node.js (v20.0.0 or higher)
- **Framework:** Express.js
- **Database:**
    - **Primary:** MySQL (using `mysql2` driver) for persistent data storage.
    - **In-Memory:** Redis (using `ioredis`) for caching, session management, and rate limiting.
- **Authentication:**
    - **Password Hashing:** `bcryptjs`
    - **Token-based Authentication:** JSON Web Tokens (JWT) using `jsonwebtoken`.
- **API Security:**
    - **HTTP Header Security:** `helmet`
    - **Rate Limiting:** `express-rate-limit` with `rate-limit-redis` for distributed rate limiting.
- **Logging:** `winston` with `winston-daily-rotate-file` for daily log rotation.
- **Metrics:** `prom-client` for exposing application metrics in Prometheus format.
- **Microservices Communication:** The system is designed as a set of microservices that communicate over HTTP. An ESB (Enterprise Service Bus) is used for routing messages between services.

## Frontend

- **Framework:** The frontend is a simple HTML/CSS/JavaScript application. It communicates with the backend via the API gateway.

## Testing

- **Unit Testing:** Jest (`jest`) is used for unit testing components, particularly within the `yield-engine`.
- **API Testing:** Custom scripts (`test-api.js`) are available for integration and API endpoint testing.
- **Security Testing:** A smoke test for security (`scripts/security-smoke.js`) is included.

## Deployment

- **Containerization:** Docker is used for containerizing each microservice. `Dockerfile`s are provided for each service. `docker-compose.yml` is used for local development orchestration.
- **Orchestration:** Kubernetes is the target deployment platform. The `k8s` directory contains the necessary manifest files for deploying the application to a Kubernetes cluster.

## Development

- **Dependency Management:** `npm`
- **Environment Configuration:** `dotenv` is used to manage environment variables.
- **Concurrent Task Runner:** `concurrently` is used to run multiple microservices simultaneously in the development environment.
