# Testing Strategy

This document outlines the testing strategy for the CSB Bank API project. The project employs a multi-layered testing approach to ensure the quality, reliability, and security of the application.

## 1. Unit Testing

-   **Framework:** [Jest](https://jestjs.io/)
-   **Location:** Unit tests are co-located with the source code in files ending with `.test.js`.
-   **Purpose:** Unit tests are used to verify the correctness of individual functions and modules in isolation. They are particularly important for the core business logic within the `yield-engine`, such as financial calculations and validation rules.

### How to Run Unit Tests

To execute all unit tests in the project, run the following command:

```bash
npm run test:unit
```

This command will discover and run all files matching the `*.test.js` pattern.

## 2. Integration & API Testing

-   **Framework:** A custom test script using `node-fetch`.
-   **Location:** `test-api.js`
-   **Purpose:** These tests verify the integration between different microservices and the overall functionality of the API as a whole. They are run against a live (local or development) instance of the application.

The integration tests cover a wide range of scenarios, including:

-   Happy path API requests to the `/optimize` endpoint.
-   Authentication and authorization, including invalid signatures, stale timestamps, and role-based access control.
-   Business logic validation, such as tenure limits, minimum principal amounts, and rate override rules.
-   Idempotency key handling.
-   Correctness of financial calculations and ALM penalty application.
-   Retrieval of historical recommendations and reports.

### How to Run Integration Tests

1.  Ensure the application is running (either via `docker-compose up` or `npm run start:all`).
2.  Make sure your `.env` file is correctly configured with the necessary secrets.
3.  Run the following command:

    ```bash
    npm test
    ```
    or
    ```bash
    npm run test
    ```

## 3. Security Smoke Testing

-   **Framework:** A custom Node.js script.
-   **Location:** `scripts/security-smoke.js`
-   **Purpose:** This is a static analysis script that scans the codebase for potential security vulnerabilities and misconfigurations without running the application.

The security smoke tests check for:

-   Exposure of secrets or internal URLs in the frontend code.
-   Presence of obsolete or insecure API endpoints.
-   Use of default or weak secrets in configuration.
-   Correct "fail-closed" behavior when critical secrets are missing.

### How to Run Security Smoke Tests

```bash
npm run test:security
```

This comprehensive testing strategy ensures that the application is not only functionally correct but also secure and robust. It is recommended to run all three types of tests as part of the CI/CD pipeline before any deployment to production.
