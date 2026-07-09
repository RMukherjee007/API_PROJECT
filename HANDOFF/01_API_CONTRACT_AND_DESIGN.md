# API Contract and Design

This document outlines the design and public API contract for the CSB Bank API. The API is designed following RESTful principles and uses JSON for request and response bodies.

## High-Level Design

The system is built on a microservices architecture. A central **API Gateway** acts as the single entry point for all external clients. The gateway is responsible for:

-   Request routing to the appropriate backend service.
-   Authentication and authorization.
-   Rate limiting.
-   Request/response logging and correlation.

The primary backend services include:

-   **Auth Service:** Manages user authentication and token issuance.
-   **Yield Engine:** Contains the core business logic for calculating and optimizing investment yields.
-   **Audit Service:** Stores and retrieves audit trails of all advisory activities.
-   **Bank Integration Service:** Connects to the core banking system (CBS) to fetch customer portfolio data.
-   **ESB (Enterprise Service Bus):** A lightweight router for specific internal communication paths.

---

## API Endpoints (via API Gateway)

All endpoints are prefixed with the base URL of the API gateway.

### Authentication Endpoints

These endpoints are proxied to the authentication service and are used for managing user sessions. They follow standard OAuth2 patterns.

-   **`POST /auth/login`**: Authenticates a user with email and password, returning JWT access and refresh tokens.
-   **`POST /auth/refresh`**: Uses a valid refresh token to obtain a new, short-lived access token.
-   **`POST /auth/logout`**: Invalidates the user's session and refresh token.
-   **`POST /auth/introspect`**: An internal endpoint for validating an access token.
-   **`GET /auth/me`**: Retrieves the profile of the currently authenticated user.

---

### **`POST /optimize`**

-   **Description:** The core endpoint. It takes customer and investment details and returns a recommendation for the optimal investment product (FCNR vs. NRE deposit). The response may also include an `X-Portfolio-Source` header, indicating how the customer's portfolio was obtained (e.g., `CACHE_HIT`, `CBS_FETCH`, `CLIENT_INPUT`).
-   **Requires:** Bearer Token.

-   **Request Body Schema:** A JSON object that must conform to the following JSON Schema.

    ```json
    {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "customer_id",
        "risk_profile",
        "principal_amount",
        "base_currency",
        "value_date",
        "tenure_months",
        "channel"
      ],
      "properties": {
        "customer_id": { "type": "string", "pattern": "^[A-Za-z0-9_-]+$", "minLength": 1, "maxLength": 64 },
        "risk_profile": { "type": "string", "enum": ["CONSERVATIVE", "MODERATE", "AGGRESSIVE"] },
        "principal_amount": { "type": "string", "pattern": "^\\d+\\.\\d{2}$" },
        "base_currency": { "type": "string", "enum": ["USD", "GBP", "EUR", "CAD", "AUD", "SGD", "JPY", "CHF", "HKD", "AED", "SAR", "QAR", "OMR", "BHD", "KWD", "INR"] },
        "value_date": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
        "tenure_months": { "type": "integer", "minimum": 12, "maximum": 60 },
        "channel": { "type": "string", "enum": ["BRANCH", "INTERNET_BANKING", "MOBILE_APP", "RM_PORTAL"] },
        "branch_code": { "type": "string", "pattern": "^[A-Za-z0-9-]+$" },
        "india_inflation_rate": { "type": "string", "pattern": "^-?\\d+\\.\\d{2,4}$" },
        "foreign_inflation_rate": { "type": "string", "pattern": "^-?\\d+\\.\\d{2,4}$" },
        "is_manual_override": { "type": "boolean" },
        "override_reason": { "type": "string", "minLength": 1, "maxLength": 1000 },
        "approved_by": { "type": "string", "pattern": "^[A-Za-z0-9-]+$" },
        "approval_timestamp": { "type": "string" },
        "override_ticket_id": { "type": "string", "pattern": "^[A-Za-z0-9-]+$" },
        "assets": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["currency", "asset_type", "market_value"],
            "properties": {
              "currency": { "type": "string", "enum": ["USD", "GBP", "EUR", "CAD", "AUD", "SGD", "JPY", "CHF", "HKD", "AED", "SAR", "QAR", "OMR", "BHD", "KWD", "INR"] },
              "asset_type": { "type": "string", "enum": ["FIXED_DEPOSIT", "NRE_ACCOUNT", "FCNR_ACCOUNT", "SAVINGS_ACCOUNT", "MUTUAL_FUND", "EQUITY", "OTHER"] },
              "market_value": { "type": "string", "pattern": "^\\d+\\.\\d{2}$" },
              "source": { "type": "string" },
              "valuation_date": { "type": "string" }
            }
          }
        },
        "liabilities": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["currency", "liability_type", "outstanding_principal"],
            "properties": {
              "currency": { "type": "string", "enum": ["USD", "GBP", "EUR", "CAD", "AUD", "SGD", "JPY", "CHF", "HKD", "AED", "SAR", "QAR", "OMR", "BHD", "KWD", "INR"] },
              "liability_type": { "type": "string", "enum": ["HOME_LOAN", "LOAN_AGAINST_PROPERTY", "CAR_LOAN", "PERSONAL_LOAN", "CREDIT_CARD_OUTSTANDING", "OTHER"] },
              "outstanding_principal": { "type": "string", "pattern": "^\\d+\\.\\d{2}$" },
              "source": { "type": "string" },
              "valuation_date": { "type": "string" }
            }
          }
        },
        "fx_rate_overrides": {
          "type": "object",
          "properties": {
            "product_spot_rate": { "type": "string", "pattern": "^\\d+\\.\\d{2,6}$" },
            "forward_rates": {
              "type": "object",
              "additionalProperties": { "type": "string", "pattern": "^\\d+\\.\\d{2,6}$" }
            },
            "portfolio_cross_rates": {
              "type": "object",
              "additionalProperties": { "type": "string", "pattern": "^\\d+\\.\\d{2,6}$" }
            }
          },
          "additionalProperties": true
        },
        "market_rates_override": {
          "type": "object",
          "properties": {
            "fcnr_rate_pct": { "type": "string", "pattern": "^-?\\d+\\.\\d{2,4}$" },
            "nre_rate_pct": { "type": "string", "pattern": "^-?\\d+\\.\\d{2,4}$" },
            "override_reason": { "type": "string", "minLength": 1, "maxLength": 1000 }
          },
          "additionalProperties": true
        }
      }
    }
    ```

-   **Success Response (`200 OK`) Schema:**
    ```json
    {
      "advisory": {
        "recommended_product": "NRE",
        "compliance_warnings": [],
        "fx_risk_flag": false,
        "projection": {
          // ... detailed projection data
        }
      },
      "compliance": {
        "premature_withdrawal_note": "...",
        "tax_treatment": "...",
        "tds_applicable": false
      },
      "decision_trace": {
        "calculation_method": "REAL_PPP_ADJUSTED",
        "alm_penalty_applied": true,
        "fcnr_effective_yield_pct": "4.91",
        "nre_effective_yield_pct": "6.19",
        // ... detailed calculation trace
      },
      "metadata": {
        "recommendation_id": "uuid-...",
        "computed_at": "2026-07-09T10:00:00.000Z",
        // ... other metadata
      }
    }
    ```

-   **Error Responses:** Errors are returned in a standard "Problem JSON" format.
    ```json
    {
      "error_code": "ERROR_CODE_HERE",
      "detail": "A human-readable error message.",
      "invalidFields": { "field_name": "validation message" } // Optional
    }
    ```
    -   **`400 Bad Request`**: The request is malformed.
        -   `MISSING_REQUIRED_FIELD`: A required field is missing.
        -   `INVALID_FORMAT`: A field has an invalid format.
    -   **`401 Unauthorized`**: Authentication failure.
        -   `UNAUTHENTICATED`: The bearer token is missing, invalid, or expired.
        -   `SIGNATURE_MISMATCH`: The internal HMAC signature is invalid (for service-to-service calls).
        -   `TIMESTAMP_SKEW`: The request timestamp is outside the allowed window.
    -   **`403 Forbidden`**: Authorization failure.
        -   `INSUFFICIENT_ROLE`: The user's role is not permitted to perform this action (e.g., an RM attempting a rate override).
    -   **`409 Conflict`**:
        -   `IDEMPOTENCY_CONFLICT`: A request with the same `Idempotency-Key` but a different payload was already processed.
    -   **`422 Unprocessable Entity`**: The request is well-formed but semantically incorrect.
        -   `TENURE_OUT_OF_RANGE`: `tenure_months` is outside the allowed min/max.
        -   `VALUE_DATE_IN_PAST`: `value_date` is in the past.
        -   `PRINCIPAL_BELOW_MINIMUM`: The `principal_amount` is below the required minimum for FCNR deposits.
        -   `INVALID_CURRENCY`: The `base_currency` is not supported.
        -   `RATE_OVERRIDE_LIMIT_EXCEEDED`: An override value deviates too far from the policy rate.
        -   `GCC_REQUIRES_IFSC_BRANCH`: A GCC currency deposit is attempted without a GIFT city branch code.
    -   **`503 Service Unavailable`**:
        -   `RATE_FEED_UNAVAILABLE`: A required downstream service (like the market rate feed) is unavailable.

---
### Business Logic and Data Endpoints

The following endpoints provide the core business functionality of the application.

---

### **`GET /rates`**

-   **Description:** Retrieves the current snapshot of market and policy interest rates used by the Yield Engine.
-   **Requires:** Bearer Token.
-   **Query Parameters:** None.
-   **Success Response (`200 OK`) Schema:**
    ```json
    {
      "policy_version": "string",
      "rates_as_of": "string (ISO 8601 timestamp)",
      "provider": "string",
      "feed_status": "string (e.g., 'live', 'fallback')",
      "feed_error": "string or null",
      "nre_rates": [
        {
          "tenure_months": "integer",
          "annual_rate_pct": "number",
          "effective_from": "string (date)"
        }
      ],
      "fcnr_rates": [
        {
          "currency": "string",
          "tenures": [
            {
              "tenure_months": "integer",
              "annual_rate_pct": "number",
              "effective_from": "string (date)"
            }
          ]
        }
      ],
      "fx_spot_rates": {
        "USDINR": "number",
        "GBPINR": "number"
      },
      "fx_forward_rates": {
        "USDINR": {
          "1M": "number",
          "3M": "number"
        }
      },
      "history_size": "integer"
    }
    ```

---

### **`GET /recent-suggestions`**

-   **Description:** Fetches a list of the 25 most recent advisory suggestions for the authenticated user.
-   **Requires:** Bearer Token.
-   **Query Parameters:** None.
-   **Success Response (`200 OK`) Schema:** An array of objects, where each object has the following structure:
    ```json
    [
      {
        "recommendation_id": "string",
        "computed_at": "string (ISO 8601 timestamp)",
        "customer_id": "string",
        "product": "string (e.g., 'NRE', 'FCNR')",
        "principal": {
          "amount": "string",
          "currency": "string"
        },
        "tenure": "integer",
        "yield": "string"
      }
    ]
    ```

---

### **`GET /recommendations/:recommendation_id`**

-   **Description:** Retrieves a specific, detailed recommendation by its unique ID.
-   **Requires:** Bearer Token.
-   **URL Parameters:**
    -   `recommendation_id` (string, required): The UUID of the recommendation to fetch.
-   **Success Response (`200 OK`) Schema:** The response body is identical to the success response of the `POST /optimize` endpoint.
-   **Error Responses:**
    -   `404 Not Found`: If no recommendation with the given ID exists.

---

### **`GET /reports/:recommendation_id`**

-   **Description:** Generates and returns a downloadable PDF report for a specific recommendation.
-   **Requires:** Bearer Token.
-   **URL Parameters:**
    -   `recommendation_id` (string, required): The UUID of the recommendation.
-   **Success Response (`200 OK`):**
    -   **Content-Type:** `application/pdf`
    -   **Body:** The binary PDF file data.
-   **Error Responses:**
    -   `404 Not Found`: If no recommendation with the given ID exists.

---

### **`GET /logs`**

-   **Description:** Queries the immutable audit log of all recommendation events. Supports pagination and filtering. RMs can only see their own logs; Auditors and Admins can see all logs.
-   **Requires:** Bearer Token.
-   **Query Parameters:**
    -   `page` (integer, optional, default: 1): The page number to retrieve.
    -   `limit` (integer, optional, default: 50, max: 200): The number of records per page.
    -   `customer_id` (string, optional): Filter by customer ID.
    -   `product` (string, optional): Filter by recommended product (e.g., 'NRE', 'FCNR').
    -   `from_date` (string, optional, format: YYYY-MM-DD): Start of date range filter.
    -   `to_date` (string, optional, format: YYYY-MM-DD): End of date range filter.
    -   `employee_id` (string, optional, Admin/Auditor only): Filter by Relationship Manager ID.
-   **Success Response (`200 OK`) Schema:**
    ```json
    {
      "total": "integer",
      "page": "integer",
      "limit": "integer",
      "pages": "integer",
      "source": "string (e.g., 'audit-service')",
      "logs": [
        {
          "recommendation_id": "string",
          "customer_id": "string",
          "employee_id": "string",
          "user_role": "string",
          "created_at": "string (ISO 8601 timestamp)",
          "computed_at": "string (ISO 8601 timestamp)",
          "execution_time_ms": "integer",
          "recommended_product": "string",
          "fcnr_yield": "string",
          "nre_yield": "string",
          "principal_amount": "string",
          "base_currency": "string",
          "tenure_months": "integer",
          "risk_profile": "string"
        }
      ]
    }
    ```

---

### **`GET /logs/pdf`**

-   **Description:** Generates and returns a downloadable bulk PDF report of audit logs based on the provided filter criteria.
-   **Requires:** Bearer Token.
-   **Query Parameters:** Same as `GET /logs`.
-   **Success Response (`200 OK`):**
    -   **Content-Type:** `application/pdf`
    -   **Body:** The binary PDF file data.

---
### Operational Endpoints

These endpoints provide information about the health and status of the services. They are not typically called by end-users but are essential for monitoring and infrastructure management.

-   **`GET /metrics`**: Exposes application and request metrics in a format that can be scraped by Prometheus.
-   **`GET /version`**: Returns the version and build time of the service.
-   **`GET /health/live`**: A simple liveness probe to indicate the service is running.
-   **`GET /health/startup`**: Indicates the service has started.
-   **`GET /health/ready`**: A readiness probe that checks connectivity to downstream dependencies (like databases and other services). Returns a `200 OK` if all critical dependencies are reachable, otherwise `503 Service Unavailable`.