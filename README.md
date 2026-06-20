# 🏦 NRI Yield Advisory API — v1.6.1

![Version](https://img.shields.io/badge/version-1.6.1-blue.svg)
![Status](https://img.shields.io/badge/status-Production_Ready-success.svg)
![Compliance](https://img.shields.io/badge/compliance-RBI_Guidelines-critical.svg)
![Latency](https://img.shields.io/badge/p95_latency-%3C250ms-brightgreen.svg)

**A highly decoupled, stateless, and RBI-compliant quantitative microservice that automates complex cross-border deposit routing choices (FCNR vs. NRE) for Non-Resident Indian (NRI) customers.**

---

## 📑 Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [What's New in v1.6.1](#2-whats-new-in-v161)
3. [System Architecture & Data Flow](#3-system-architecture--data-flow)
4. [The 4-Phase Quantitative Engine](#4-the-4-phase-quantitative-engine)
5. [Domain Rules & Regulatory Compliance](#5-domain-rules--regulatory-compliance)
6. [Security, RBAC & Guardrails](#6-security-rbac--guardrails)
7. [API Endpoints Reference](#7-api-endpoints-reference)
8. [Error Handling & RFC 7807](#8-error-handling--rfc-7807)
9. [Idempotency](#9-idempotency)
10. [Observability](#10-observability)
11. [Local Development & Configuration](#11-local-development--configuration)
12. [Future Scope](#12-future-scope)
13. [Appendix — Schema Reference](#13-appendix--schema-reference)

---

## 1. Executive Summary

In global wealth management, NRI clients frequently hold significant foreign currency reserves and must decide whether to deposit them into foreign-denominated **FCNR(B)** accounts or INR-denominated **NRE** fixed deposits.

This API replaces brittle Relationship Manager (RM) spreadsheets with a sub-250ms mathematical engine. By evaluating base interest rates, live Treasury Management System (TMS) forward curves, optional inflation expectations, and global asset/liability positions (ALM), it returns a defensible, mathematically rigorous, and fully auditable routing recommendation.

### What the RM gets back

- A recommendation: `FCNR`, `NRE`, or `EQUAL_YIELD` (15 bps decision buffer)
- `advisory.fx_risk_flag` — set whenever FCNR is recommended to a `CONSERVATIVE` customer
- All compliance notices pre-generated: withdrawal rules, tax treatment, TDS flag

---

## 2. What's New in v1.6.1

This release marks an architectural shift from a simple yield calculator to a hardened treasury engine:

- **Real Yield Math** — added the exact Fisher equation to calculate inflation-adjusted real yields when an RM supplies `expected_inflation_rate`.
- **Cross-Currency Support** — enabled global portfolio conversion into a common INR base using live TMS cross-rates, across any FCNR-eligible currency.
- **ALM Penalty in Basis Points** — the structural penalty that reduces FCNR yields when INR liabilities exceed assets is now exposed precisely as `alm_penalty_bps`, not just a boolean.
- **Gateway + ESB Enrichment Pattern** — the legacy CBS integration is now fully delegated to a Lightweight ESB, keeping the core computation microservice completely stateless and isolated from legacy systems.
- **Decoupled ESB Architecture** — the Lightweight ESB is its own distinct layer with strict Circuit Breaker fallback logic, invisible to both the Gateway and the microservice's own health surface.
- **Audit Transparency** — `decision_trace` now exposes every intermediate math variable (effective yields, penalty bps, the exact FX matrix used) so any auditor can replicate the engine's math by hand.
- **RBAC Guardrails on Two Override Surfaces** — `fx_rate_overrides` (FX rates, ±10% cap) and `market_rates_override` (interest rates, ±200 bps cap) are both restricted to `SENIOR_RM` and `TREASURY`.
- **Regulatory Ring-Fencing for GCC Currencies** — AED, SAR, QAR, OMR, BHD, and KWD are natively supported, but RBI guidelines restrict them exclusively to IFSC (GIFT City) branch routing.
- **15 bps Decision Buffer** — added to recommend `EQUAL_YIELD` for marginal differences, eliminating recommendation churn on noise-level rate movements.

---

## 3. System Architecture & Data Flow

To maintain extreme throughput, this service **never connects directly to legacy data stores**.

### The Gateway + ESB Enrichment Pattern

If the microservice had to fetch a customer's portfolio itself, it would become I/O-bound waiting on older Core Banking Systems (CBS). Instead, the **Gateway Enrichment Pattern** does this work upstream. The RM frontend sends a "thin" payload. The API Gateway intercepts it, resolves the customer's balance sheet via Redis or the **Lightweight ESB**, and injects the asset/liability arrays into the request. The microservice receives a "fat," fully resolved payload, letting it act as a pure, stateless mathematical pipe.

The Lightweight ESB exists specifically to absorb legacy-system pain: protocol translation, connection handshakes, timeout management, and CBS-down fallback all live inside the ESB. Neither the Gateway nor the microservice need to know anything about how the legacy CBS actually works.

### Architectural Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              RM's Browser / App                             │
│      (enters: CIF, risk profile, amount, currency, optional inflation       │
│                          & FX/rate overrides)                               │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ Thin Payload
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              API Gateway                                    │
│  1. Validates HMAC, RBAC roles, and Idempotency keys                        │
│  2. Checks Redis for cbs_portfolio:{customer_id}                            │
│     ├─ HIT  → injects cached assets + liabilities                           │
│     └─ MISS → delegates fetch to Lightweight ESB ──┐                        │
│                                                    │                        │
│  3. Caches ESB response (120s TTL) <───────────────┘                        │
│  4. Forwards 'fat' payload to microservice                                  │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │                      ▲
                  Enriched Payload │                      │ (ESB Handshake)
                                   │                      ▼
                                   │   ┌────────────────────────────────────┐
                                   │   │         Lightweight ESB            │
                                   │   │ 1. Translates legacy protocols     │
                                   │   │ 2. Circuit Breaker pattern         │
                                   │   │    ├─ CLOSED: Fetches from CBS     │
                                   │   │    └─ OPEN: Fast-fail fallback     │
                                   │   └────────────────┬───────────────────┘
                                   │                    ▼
                                   │            Legacy CBS (Core Banking)
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       NRI Yield Advisory Microservice                       │
│                                                                             │
│  ┌─────────────────┐   ┌────────────────────┐                              │
│  │  TMS Feed       │   │  Policy Config       │                            │
│  │  (Spot/Forward) │   │  Store (rates, ALM)  │                            │
│  └────────┬────────┘   └──────────┬───────────┘                            │
│           └──────────────┬────────┘                                        │
│                          ▼                                                  │
│                Computation Engine                                           │
│                - Fetches TMS curves & applies overrides                     │
│                - Executes 4-Phase Yield Math (ALM + Fisher Equation)        │
│                          │                                                  │
│                          ▼                                                  │
│                Audit Store (Async write, non-blocking, 90-day retention)    │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ OptimizeResponse
                                   ▼
                              RM's Screen
```

### Design Principles

**Stateless hot-path.** Every POST /optimize call is fully self-contained. P95 SLO: 250 ms end-to-end including gateway and ESB round-trip on a cache miss.

**Complete legacy isolation.** This microservice never connects to CBS, Redis, or the ESB. Portfolio data arrives pre-injected. A stub Gateway is sufficient for all microservice-level testing.

**Graceful degradation.** If the ESB reports CBS is unreachable, `X-Portfolio-Source: NOT_AVAILABLE` is set. The service runs a pure yield comparison (zero ALM penalty) and adds a compliance warning rather than failing the request.

**Async audit writes.** The recommendation is written to the audit store (PostgreSQL, 90-day retention) after the HTTP response is sent — the write never blocks the RM's response.

---

## 4. The 4-Phase Quantitative Engine

The engine must equalize differing currencies, account for the bank's balance sheet risk, and optionally strip away inflation to provide an accurate recommendation.

### Phase 1 — FX-Adjusted Nominal NRE Yield

To compare an NRE rate against a foreign-currency FCNR rate, the NRE yield is projected back into the base foreign currency using live TMS spot and forward rates.

Let R_nre be the nominal NRE rate, S the spot rate (base currency to INR), F the forward rate at maturity, and T the tenure in years:

```
Y_nre = [ (1 + R_nre)^T × (S / F) ]^(1/T) − 1
```

When `base_currency` is INR, this phase is skipped entirely — the evaluation is NRE-only, and `product_spot_rate_used` / `product_forward_rate_used` are explicitly `null` in the decision trace.

### Phase 2 — The ALM Penalty Adjustment

If a customer holds INR liabilities (e.g. an Indian mortgage) while depositing foreign currency, the bank absorbs a currency mismatch risk.

1. All global portfolio positions (assets and liabilities, in any FCNR-eligible currency including GCC currencies) are converted to INR using the live TMS cross-rate matrix.
2. If total INR liabilities exceed total INR assets, an ALM penalty (`alm_penalty_bps`) is triggered.
3. This penalty is deducted from the nominal FCNR rate:

```
Y_fcnr_adjusted = R_fcnr − P_alm
```

No duration weighting is applied — `liability_type` is recorded in the request for audit purposes only and does not change the penalty magnitude. `decision_trace.total_assets_inr`, `total_liabilities_inr`, `alm_penalty_applied`, and `alm_penalty_bps` together give a full audit record of this phase.

### Phase 3 — Macroeconomic Cleansing (The Fisher Equation)

If the RM provides an optional `expected_inflation_rate` (π), the engine strips out the erosion of purchasing power to produce real yields:

```
Real Yield = (1 + Nominal Yield) / (1 + π) − 1
```

`decision_trace.calculation_method` is set to `REAL_INFLATION_ADJUSTED` and `fcnr_real_yield_pct` / `nre_real_yield_pct` are populated. When `expected_inflation_rate` is omitted, `calculation_method` is `NOMINAL` and the comparison uses `fcnr_effective_yield_pct` / `nre_effective_yield_pct` directly.

### Phase 4 — The Decision Matrix

The engine compares the final computed yields (real if inflation was supplied, otherwise nominal) using a 15 basis point (0.15%) buffer to prevent algorithmic churning:

- If `Yield_fcnr > Yield_nre + 0.0015` → recommend **FCNR**
- If `Yield_nre > Yield_fcnr + 0.0015` → recommend **NRE**
- Otherwise → recommend **EQUAL_YIELD**

---

## 5. Domain Rules & Regulatory Compliance

### FCNR(B) vs NRE FD

**FCNR(B)** — the deposit stays in the foreign currency throughout. Interest is tax-free. Cannot be prematurely withdrawn within the first 12 months (RBI Master Direction). Tenure: 12–60 months.

**NRE FD** — the foreign currency is converted to INR at spot rate. Earns interest at Indian FD rates. At maturity, the INR value converts back at the forward rate. Tax-exempt under Section 10(4) of the Income Tax Act, 1961. Freely repatriable. RBI mandates quarterly compounding.

### Eligible Currencies

```
FCNR(B): USD | GBP | EUR | CAD | AUD | SGD | JPY | CHF | HKD | AED | SAR | QAR | OMR | BHD | KWD
Deposit base_currency: above + INR (INR triggers an NRE-only evaluation)
Positions (assets/liabilities): same set as FCNR(B), all convertible via the TMS cross-rate matrix
```

### GCC Currencies & IFSC Routing

The API natively supports AED, SAR, QAR, OMR, BHD, and KWD. However, under strict RBI guidelines, GCC currencies are heavily managed or pegged and do not qualify for domestic-branch FCNR booking. **Any GCC currency deposit must originate with a `branch_code` belonging to the bank's IFSC (GIFT City) unit.** Submitting a GCC `base_currency` with a non-IFSC `branch_code` returns `422 GCC_REQUIRES_IFSC_BRANCH`.

### Transparent Auditability

The API is not a black box. `decision_trace` explicitly logs intermediate variables — `alm_penalty_bps`, `fcnr_effective_yield_pct`, `nre_effective_yield_pct`, and the exact `portfolio_fx_matrix_used` — so any auditor can replicate the engine's math independently.

### Compliance Notices

Every response includes a `compliance` block with automated Section 10(4) tax exemption language and the 12-month lock-in premature withdrawal notice for FCNR:

```json
"compliance": {
  "premature_withdrawal_note": "FCNR(B) deposits cannot be prematurely withdrawn within the first 12 months per RBI Master Direction.",
  "tax_treatment": "Interest on both NRE and FCNR(B) accounts is exempt from Indian Income Tax under Section 10(4) of the Income Tax Act, 1961, for qualifying NRIs.",
  "tds_applicable": false
}
```

### `fx_risk_flag`

When `recommended_product` is `FCNR` and the customer's `risk_profile` is `CONSERVATIVE`, `advisory.fx_risk_flag` is set to `true` — a hard prompt for the RM to discuss currency risk before the deposit is placed.

---

## 6. Security, RBAC & Guardrails

### Core Gateway Defenses

- **`X-Internal-Signature`** — HMAC-SHA256 signature calculated over `X-Gateway-Timestamp | HTTP_Method | Request_Path | SHA256(Body_String)` to prevent in-flight payload tampering.
- **`X-Gateway-Timestamp`** — millisecond Unix timestamp; skew beyond ±30 seconds is rejected (`401 TIMESTAMP_SKEW`).
- **`Idempotency-Key`** — 24-hour UUID caching to safely absorb frontend network retries without double-triggering audit logs.

### Role-Based Access Control

| Role | Can call /optimize | Can use fx_rate_overrides | Can use market_rates_override | Can approve manual overrides |
|---|---|---|---|---|
| `RM` | ✅ | ❌ (403) | ❌ (403) | ❌ |
| `SENIOR_RM` | ✅ | ✅ | ✅ | ✅ |
| `TREASURY` | ✅ | ✅ | ✅ | ✅ |

### Override Limits

**`fx_rate_overrides`** — negotiated treasury FX rates for HNWI customers. Strictly gated to `SENIOR_RM` and `TREASURY`. Enforces a hardcoded **±10% maximum deviation** from the live TMS market rates. Breaches return `422 RATE_OVERRIDE_LIMIT_EXCEEDED`.

**`market_rates_override`** — negotiated FCNR/NRE interest rates. Same role gating. Enforces a **±200 bps maximum deviation** from the live policy-store rates. Both override objects require an `override_reason` and set `is_override_computation: true` in the response metadata.

### Manual Override Approval

Manual overrides trigger conditional JSON Schema requirements (`allOf` / `if`/`then`): setting `is_manual_override: true` forces the RM to supply `override_reason`, `approved_by`, `approval_timestamp`, and an `override_ticket_id`. Future-dated approval timestamps return `422 FUTURE_APPROVAL_TIMESTAMP`.

---

## 7. API Endpoints Reference

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/optimize` | The main quantitative engine. Accepts client parameters, runs the 4-phase math, and returns the FCNR vs NRE routing recommendation. |
| `GET` | `/recommendations/{recommendation_id}` | Retrieves a frozen, historical `OptimizeResponse` from the audit store (90-day retention window). |
| `GET` | `/rates` | Returns the live `policy_version`, nominal interest rate matrices, and the full TMS spot/forward FX curves. |
| `GET` | `/health/ready` | Kubernetes operational probe. Reports whether the service is healthy and the current circuit breaker states of the TMS feed and ESB layer. |

### `POST /optimize` — Headers

| Header | Set By | Purpose |
|---|---|---|
| `traceparent` | Client | W3C Trace Context — links this call across all services |
| `Idempotency-Key` | Client | 24-hour deduplication key |
| `X-Employee-ID` | Gateway | RM's employee ID from session |
| `X-User-Role` | Gateway | Role from session (`RM` / `SENIOR_RM` / `TREASURY`) |
| `X-Gateway-Timestamp` | Gateway | Millisecond Unix timestamp for replay protection |
| `X-Portfolio-Source` | Gateway | `CACHE_HIT` / `ESB_FETCH` / `NOT_AVAILABLE` |
| `X-Portfolio-Cache-Age-Seconds` | Gateway | Age of Redis entry (CACHE_HIT only) |

Four request examples exist in the spec: `FrontendThinRequest` (GCC currency, IFSC branch), `RMCustomRatesRequest` (Senior RM cross-rate override with inflation), `GatewayEnrichedRequest` (fully resolved microservice payload), and `ManualOverrideRequest`.

---

## 8. Error Handling & RFC 7807

This API strictly adheres to **RFC 7807 Problem Details for HTTP APIs** (`Content-Type: application/problem+json`) for every fault response.

```json
{
  "type": "https://api.bank.com/errors/unprocessable-entity",
  "title": "Unprocessable Entity",
  "status": 422,
  "detail": "GCC currency deposits require an IFSC (GIFT City) branch code.",
  "instance": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  "error_code": "GCC_REQUIRES_IFSC_BRANCH",
  "invalid_fields": {
    "branch_code": "must belong to an IFSC unit when base_currency is a GCC currency"
  }
}
```

`instance` echoes the W3C `traceparent` — paste it into any APM tool to find the server-side trace immediately.

### Operational & Business Logic Error Matrix

| HTTP Status | Error Code | Trigger Condition |
|---|---|---|
| 400 | `MISSING_REQUIRED_FIELD` | A mandatory schema field is omitted. |
| 400 | `INVALID_FORMAT` | A field fails regex pattern validation or type constraints. |
| 401 | `SIGNATURE_MISMATCH` | `X-Internal-Signature` HMAC validation failed. |
| 401 | `TIMESTAMP_SKEW` | `X-Gateway-Timestamp` deviates > ±30 seconds from server time. |
| 403 | `INSUFFICIENT_ROLE` | An RM attempted to use `fx_rate_overrides` or `market_rates_override`. |
| 404 | `RECOMMENDATION_NOT_FOUND` | UUID not found in the audit store. |
| 404 | `RECOMMENDATION_EXPIRED` | Record requested falls outside the 90-day retention window. |
| 409 | `IDEMPOTENCY_CONFLICT` | `Idempotency-Key` is reused with a different request body. |
| 422 | `INVALID_CURRENCY` | Currency provided is not supported in the defined enums. |
| 422 | `UNSUPPORTED_CURRENCY_PAIR` | Attempted conversion involving a currency not tracked by the TMS. |
| 422 | `TENURE_OUT_OF_RANGE` | `tenure_months` is outside the required 12–60 range. |
| 422 | `PRINCIPAL_BELOW_MINIMUM` | Principal amount fails to meet the bank's FCNR regulatory minimum equivalent. |
| 422 | `VALUE_DATE_IN_PAST` | The provided funding date (`value_date`) is before the current date. |
| 422 | `GCC_REQUIRES_IFSC_BRANCH` | A GCC `base_currency` was submitted without an IFSC `branch_code`. |
| 422 | `RATE_OVERRIDE_LIMIT_EXCEEDED` | RM rate overrides exceed the system-defined deviation limits from the live TMS/policy feeds. |
| 422 | `FUTURE_APPROVAL_TIMESTAMP` | `approval_timestamp` for an override is set in the future. |
| 429 | — | Rate limit exceeded for this employee ID or IP. `Retry-After` header included. |
| 503 | `CIRCUIT_BREAKER_OPEN` | The Lightweight ESB tripped due to legacy CBS instability, or the TMS feed circuit is open. |
| 503 | `DEPENDENCY_TIMEOUT` | A critical internal downstream dependency timed out. |
| 503 | `FX_FEED_UNAVAILABLE` | The live TMS feed cannot be reached or resolved. |

---

## 9. Idempotency

`POST /optimize` is idempotent with a 24-hour TTL, keyed on `Idempotency-Key + SHA-256(body)`.

| Scenario | Response |
|---|---|
| First request | `200` — fresh computation, stored |
| Same key + same body | `200` — served from cache, `X-Idempotency-Replay: true` |
| Same key + different body | `409 IDEMPOTENCY_CONFLICT` — generate a new key |

---

## 10. Observability

### Distributed tracing

The service uses **W3C Trace Context `traceparent`** — supported natively by OpenTelemetry, Jaeger, Zipkin, and Datadog without custom parsing. Required on all inbound requests, echoed in `metadata.traceparent`, and used as the `instance` field in all RFC 7807 errors.

### Key metrics to instrument

| Metric | Type | Labels |
|---|---|---|
| `nri_yield_optimize_latency_ms` | Histogram | `channel`, `recommendation`, `portfolio_source` |
| `nri_yield_alm_penalty_bps` | Histogram | `rates_source` |
| `nri_yield_calculation_method_total` | Counter | `method` (NOMINAL / REAL_INFLATION_ADJUSTED) |
| `nri_yield_override_total` | Counter | `override_type` (fx_rate / market_rate), `approved_by_role` |
| `nri_yield_gcc_ifsc_rejections_total` | Counter | `currency` |
| `nri_yield_portfolio_source_total` | Counter | `source` (CACHE_HIT / ESB_FETCH / NOT_AVAILABLE) |
| `nri_yield_circuit_breaker_state` | Gauge | `dependency` (tms_feed / esb_layer), `state` |

### Health Probe Detail

`GET /health/ready` reports the circuit breaker state of the ESB and TMS feed dependencies it can observe:

```json
{
  "status": "ok",
  "dependencies": {
    "tms_feed":            { "status": "ok", "is_critical": true,  "circuit_state": "CLOSED", "latency_ms": 14 },
    "policy_config_store": { "status": "ok", "is_critical": true,  "circuit_state": "CLOSED", "latency_ms": 4  },
    "idempotency_cache":   { "status": "ok", "is_critical": true,  "circuit_state": "CLOSED", "latency_ms": 1  },
    "audit_store":         { "status": "ok", "is_critical": false, "circuit_state": "CLOSED", "latency_ms": 18 },
    "esb_layer":           { "status": "ok", "is_critical": false, "circuit_state": "CLOSED", "latency_ms": 32 }
  }
}
```

Redis and the legacy CBS itself are Gateway dependencies and are not part of this microservice's own dependency set.

---

## 11. Local Development & Configuration

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | Microservice HTTP listener port. | `8080` |
| `TMS_API_URL` | Base URL for the internal Treasury Management System. | `https://tms.internal/v1` |
| `POLICY_STORE_URL` | Base URL for the central nominal rate policy store. | `https://policy.internal/v1` |
| `AUDIT_DB_DSN` | Connection string for the 90-day Postgres retention database. | `postgres://user:pass@db:5432/audit` |
| `MAX_FX_DEVIATION_PCT` | Hardcoded maximum limit for RM manual FX rate overrides. | `10.0` |
| `MAX_RATE_DEVIATION_BPS` | Hardcoded maximum limit for RM manual interest rate overrides. | `200` |

### Quick Start

```bash
# 1. Spin up mock Redis (Gateway Cache) and Postgres (Audit Store)
docker-compose up -d

# 2. Run the application
make run

# 3. Run the quantitative test suite
make test-math
```

### Environments

| URL | Purpose |
|---|---|
| `https://api.bank.com/v1/nri-yield` | Production |
| `https://api.uat.bank.com/v1/nri-yield` | UAT / integration testing |

---

## 12. Future Scope

**Tenor-matched FX forward curve.** The current implementation uses a single forward rate at maturity. A richer version would apply tenor-matched rates at each compounding period from the full TMS forward curve.

**NRO account comparison.** Currently FCNR vs NRE only. Adding NRO would require a different tax treatment model (TDS applies, repatriation limits apply) and a `Recommendation` enum extension.

**Multi-tranche optimisation.** A common real-world scenario is splitting (e.g. 60% FCNR / 40% NRE). A `multi_tranche` flag could return the optimal split ratio alongside the single-product recommendation.

**AGGRESSIVE risk profile yield adjustment.** Currently `AGGRESSIVE` is informational only. A future version could apply a small positive FX-carry credit to FCNR for currencies with historically favourable carry against INR.

**Liveness probe.** This version intentionally ships with `/health/ready` only. A `/health/live` liveness probe (no dependency checks, used purely for pod-restart decisions) is a natural low-risk addition.

**Audit store query API.** Current retrieval is by `recommendation_id` only. A `GET /recommendations?customer_id=...&from=...&to=...` endpoint, `TREASURY`-role gated, would allow bulk audit review.

**Streaming rates via WebSocket.** `GET /rates` is a polling endpoint. A WebSocket subscription on `/rates/stream` would push TMS curve updates in real time.

---

## 13. Appendix — Schema Reference

### Request schemas

| Schema | Description |
|---|---|
| `OptimizeRequest` | Main request body for `POST /optimize` |
| `AssetPosition` | A customer asset (FD, savings, equity, etc.) — gateway-injected |
| `LiabilityPosition` | A customer liability (loan, credit card, etc.) — gateway-injected |
| `FXRateOverrides` | Privileged FX rate overrides — SENIOR_RM / TREASURY only, ±10% cap |
| `MarketRatesOverride` | Privileged interest rate overrides — SENIOR_RM / TREASURY only, ±200 bps cap |

### Response schemas

| Schema | Description |
|---|---|
| `OptimizeResponse` | Full recommendation response |
| `Advisory` | Recommendation, FX risk flag, compliance warnings |
| `DecisionTrace` | Frozen computation inputs and intermediate math for RBI audit |
| `ComplianceInfo` | Pre-generated withdrawal rules, tax treatment, TDS flag |
| `ResponseMetadata` | Request echo, timestamps, portfolio enrichment details |
| `PortfolioEnrichment` | How the Gateway/ESB resolved the customer portfolio |
| `RatesResponse` | Current rate matrix and TMS FX curves from `GET /rates` |
| `TenureRateEntry` | Single rate for a specific tenure |
| `FCNRCurrencyRates` | FCNR rates for a currency across tenures |

### Health schemas

| Schema | Description |
|---|---|
| `HealthReadyResponse` | Named dependencies and overall status |
| `DependencyStatus` | Individual dependency health and circuit breaker state |

### Enum reference

| Enum | Values |
|---|---|
| `CustomerRiskProfile` | `CONSERVATIVE MODERATE AGGRESSIVE` |
| `FCNREligibleCurrency` | `USD GBP EUR CAD AUD SGD JPY CHF HKD AED SAR QAR OMR BHD KWD` |
| `DepositBaseCurrency` | Above + `INR` |
| `PositionCurrency` | Same set as `FCNREligibleCurrency` + `INR` |
| `AssetType` | `FIXED_DEPOSIT NRE_ACCOUNT FCNR_ACCOUNT SAVINGS_ACCOUNT MUTUAL_FUND EQUITY OTHER` |
| `LiabilityType` | `HOME_LOAN LOAN_AGAINST_PROPERTY CAR_LOAN PERSONAL_LOAN CREDIT_CARD_OUTSTANDING OTHER` |
| `Channel` | `BRANCH INTERNET_BANKING MOBILE_APP RM_PORTAL` |
| `RatesSource` | `TMS_FEED POLICY_STORE RM_INPUT RM_OVERRIDE` |
| `CalculationMethod` | `NOMINAL REAL_INFLATION_ADJUSTED` |
| `Recommendation` | `FCNR NRE EQUAL_YIELD` |

---

*Maintained by Treasury Tech · treasury-tech@bank.example.com*
*OpenAPI spec: `nri-yield-advisory-api-v1.6.1.yaml` (full) and `api-spec.yaml` (identical contract) · Version 1.6.1*
