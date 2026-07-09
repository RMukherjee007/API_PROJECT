# Production Handoff Documentation

This directory contains all the necessary documentation for the CSB Bank API project, prepared for a safe and effective handoff to the production operations and development teams.

The documents are structured to provide a comprehensive understanding of the system, from high-level architecture to detailed operational procedures.

## Table of Contents

1.  [**01_API_CONTRACT_AND_DESIGN.md**](./01_API_CONTRACT_AND_DESIGN.md)
    -   Describes the public-facing API endpoints, request/response formats, and high-level system design.

2.  [**02_TECHNOLOGY_STACK.md**](./02_TECHNOLOGY_STACK.md)
    -   Lists all the technologies, frameworks, and libraries used in the project.

3.  [**03_SETUP_AND_CONFIGURATION.md**](./03_SETUP_AND_CONFIGURATION.md)
    -   Provides detailed instructions for setting up a local development environment, including environment variables and database initialization.

4.  [**04_ROUTING_AND_BUSINESS_LOGIC.md**](./04_ROUTING_AND_BUSINESS_LOGIC.md)
    -   Explains the microservices architecture, the responsibilities of each service, and the request flow for key business processes.

5.  [**05_AUTHENTICATION_AND_AUTHORIZATION.md**](./05_AUTHENTICATION_AND_AUTHORIZATION.md)
    -   Details the security model, including service-to-service HMAC authentication, end-user JWT authentication, and Role-Based Access Control (RBAC).

6.  [**06_TESTING.md**](./06_TESTING.md)
    -   Outlines the project's testing strategy, including how to run unit tests, integration tests, and security smoke tests.

7.  [**07_DEPLOYMENT.md**](./07_DEPLOYMENT.md)
    -   A step-by-step guide for deploying the application to a Kubernetes cluster, including building images, managing secrets, and applying manifests.

8.  [**08_MONITORING_AND_MAINTENANCE.md**](./08_MONITORING_AND_MAINTENANCE.md)
    -   Covers the operational aspects of the application, including structured logging, Prometheus metrics for monitoring, and health check endpoints for ensuring high availability.

Please read these documents in order for a complete understanding of the system.
