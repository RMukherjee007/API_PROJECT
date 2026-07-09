# Authentication and Authorization

This document describes the authentication and authorization mechanisms used in the CSB Bank API project. The system employs a two-layered approach to secure the API: one for machine-to-machine (M2M) communication between services and another for end-user authentication.

## 1. Service-to-Service Authentication (M2M)

Internal communication between microservices is secured using a Hash-based Message Authentication Code (HMAC) signature. This ensures that only trusted services within the platform can communicate with each other.

-   **Mechanism:** HMAC-SHA256
-   **Header:** `X-Internal-Signature`

### How it Works

1.  The calling service constructs a signing string using the following components:
    `{timestamp}|{HTTP_METHOD}|{request_path}|{sha256_hex_of_request_body}`

2.  The service signs this string using a pre-shared `HMAC_SHARED_SECRET`.

3.  The resulting signature is sent in the `X-Internal-Signature` header of the request.

4.  The receiving service reconstructs the same signing string and computes its own signature.

5.  It then performs a constant-time comparison between the received signature and its calculated signature. If they match, the request is considered authentic.

### Timestamp and Replay Attacks

To prevent replay attacks, the request must also include an `X-Gateway-Timestamp` header containing a Unix timestamp (in milliseconds). The server validates that this timestamp is within a configurable time skew (e.g., ±30 seconds) of its own clock.

## 2. End-User Authentication

End-user authentication is handled using JSON Web Tokens (JWT). This is the standard mechanism for authenticating users who are interacting with the system via the frontend application.

-   **Mechanism:** JSON Web Token (JWT)
-   **Header:** `Authorization: Bearer <token>`

### How it Works

1.  A user logs in with their credentials (e.g., username and password).
2.  The `auth-service` validates the credentials and, if successful, issues a signed JWT.
3.  This JWT is sent to the frontend application, which stores it securely.
4.  For all subsequent requests to protected API endpoints, the frontend includes the JWT in the `Authorization` header as a `Bearer` token.
5.  The API Gateway and other services use middleware to verify the JWT's signature and expiration time. If the token is valid, the user is considered authenticated.

The JWT payload contains information about the user, including their `employeeId` and `role`.

## 3. Authorization (Role-Based Access Control)

Authorization is implemented using Role-Based Access Control (RBAC). A user's role determines what actions they are permitted to perform.

### Roles

The system defines the following roles:

-   `RM`: Relationship Manager
-   `SENIOR_RM`: Senior Relationship Manager
-   `TREASURY`: Treasury Department User
-   `ADMIN`: System Administrator
-   `AUDITOR`: Auditor
-   `SERVICE`: A role for internal system processes.

### How it Works

-   When a user is authenticated via JWT, their role is extracted from the token.
-   For service-to-service communication, the role can be passed in the `X-User-Role` header.
-   API endpoints are protected by middleware that checks if the user's role is in the list of roles authorized to access that endpoint.
-   For certain sensitive operations, such as overriding foreign exchange rates, specific roles (`SENIOR_RM`, `TREASURY`, `ADMIN`) are required.

This combination of HMAC and JWT authentication, along with RBAC, provides a robust security model for the entire platform.
