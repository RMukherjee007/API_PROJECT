# 1. Architecture & Design Documentation

This document outlines the high-level architecture, data flows, and API specifications for the NRI Yield Advisory System.

## System Architecture Diagram

The system employs a decentralized microservice architecture with an API Gateway acting as the central entry point and authenticator.

```mermaid
graph TD
    Client[Web Browser / User UI] -->|HTTPS| Frontend[Frontend BFF Server]
    Frontend -->|HTTPS| Gateway[API Gateway :3000]
    
    subgraph Core Services
        Gateway -->|HMAC Signed + JWT| Auth[Auth Service :3001]
        Gateway -->|HMAC Signed| YieldEngine[Yield Engine :3002]
        Gateway -->|HMAC Signed| Audit[Audit Service :3003]
    end
    
    subgraph Data Stores
        Auth -->|MySQL| AuthDB[(MySQL - Users/Tokens)]
        YieldEngine -->|Redis| YieldCache[(Redis - Rates/Idempotency)]
        Audit -->|PostgreSQL| AuditDB[(PostgreSQL - Logs)]
        Gateway -->|Redis| GatewayCache[(Redis - Rate Limiting/Caching)]
    end
    
    subgraph External Integrations
        Gateway -->|HMAC Signed| BankAPI[Bank Integration Service :3006]
        BankAPI -->|HTTP| ESB[ESB Service :3005]
        ESB -.->|Mocked for Dev| CBS[(Core Banking System)]
    end

    classDef service fill:#0f4f78,stroke:#fff,stroke-width:2px,color:#fff;
    classDef db fill:#17694f,stroke:#fff,stroke-width:2px,color:#fff;
    class Gateway,Auth,YieldEngine,Audit,Frontend,BankAPI,ESB service;
    class AuthDB,YieldCache,AuditDB,GatewayCache,CBS db;
```

## Data Flow Diagram: Recommendation Request

When an RM requests a yield optimization (`POST /optimize`), data flows through multiple layers, integrating real-time user inputs, cached portfolios, and financial models.

```mermaid
sequenceDiagram
    participant User
    participant Frontend
    participant Gateway
    participant Redis as Redis Cache
    participant BankAPI as Bank Integration
    participant YieldEngine as Yield Engine
    participant Audit as Audit Service

    User->>Frontend: Fill form & Click 'Calculate'
    Frontend->>Gateway: POST /optimize (Customer ID + Manual Inputs + JWT)
    
    Gateway->>Gateway: Validate JWT & Idempotency Key
    Gateway->>Redis: Check CBS Portfolio Cache
    alt Cache Miss
        Gateway->>BankAPI: Fetch Portfolio from CBS (via ESB)
        BankAPI-->>Gateway: Return Customer Assets & Liabilities
        Gateway->>Redis: Set Portfolio Cache
    end
    
    Gateway->>YieldEngine: POST /optimize (Fat Payload: Inputs + Portfolio)
    YieldEngine->>YieldEngine: Calculate FCNR & NRE Yields (ALM + FX Rates)
    YieldEngine-->>Gateway: Recommendation Payload
    
    Gateway->>Audit: POST /api/v1/audit/events (Async Audit Logging)
    Gateway-->>Frontend: 200 OK (Yields + Recommendation + Trace)
    Frontend-->>User: Render Dashboard
```

> [!WARNING]
> **Data Privacy Checkpoint:** Customer IDs and Portfolio balances (PII/Financial Data) are processed by the Gateway, Yield Engine, and Bank Integration. They are stored temporarily in Redis (Cache) and permanently in PostgreSQL (Audit Logs). All inter-service traffic carrying this data must be protected by HMAC-SHA256 signatures.

## API Specifications

### `POST /api/v1/auth/login`
- **Description:** Authenticates user and issues access/refresh tokens.
- **Request Body:**
  ```json
  {
    "email": "rm.test@csb.co.in",
    "password": "password123"
  }
  ```
- **Response:** `200 OK`
  ```json
  {
    "access_token": "eyJhbGci...",
    "refresh_token": "8a7b6c...",
    "user": {
      "employee_id": "EMP001",
      "name": "Test RM",
      "email": "rm.test@csb.co.in",
      "role": "RM",
      "branch_code": "GIFT-001"
    }
  }
  ```

### `POST /optimize`
- **Description:** Generates yield optimization advice based on user inputs and CBS portfolio.
- **Headers:** 
  - `Authorization: Bearer <token>`
  - `Idempotency-Key: <uuid>`
- **Request Body:**
  ```json
  {
    "customer_id": "CUST123",
    "base_currency": "USD",
    "principal_amount": "50000.00",
    "tenure_months": 12,
    "assets": [],
    "liabilities": []
  }
  ```
- **Response:** `200 OK`
  ```json
  {
    "metadata": { "recommendation_id": "uuid", "computed_at": "ISO8601" },
    "advisory": {
      "recommended_product": "FCNR",
      "projection": { ... }
    },
    "decision_trace": { ... }
  }
  ```

### `GET /history`
- **Description:** Retrieves recent optimization requests.
- **Query Params:** `limit=50`
- **Behavior:** Only ADMIN and AUDITOR roles can view history globally (by passing `employee_id` query param). Standard RMs can only view their own history.

### `GET /reports/:recommendationId`
- **Description:** Generates a PDF report for a specific recommendation.
- **Authentication:** Can use `Authorization: Bearer` header or `?token=<jwt>` query parameter.
