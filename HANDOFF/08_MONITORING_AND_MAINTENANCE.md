# Monitoring and Maintenance

This document provides an overview of the monitoring and maintenance features built into the CSB Bank API application.

## 1. Logging

The application uses a structured logging approach, which is crucial for monitoring and troubleshooting in a distributed microservices environment.

-   **Library:** [Winston](https://github.com/winstonjs/winston)
-   **Format:** In production, logs are written as structured JSON to `stdout`, following the 12-factor app methodology. This allows for easy collection and parsing by log aggregation platforms like ELK Stack (Elasticsearch, Logstash, Kibana), Splunk, or cloud-native solutions like Google Cloud Logging or AWS CloudWatch Logs.
-   **Log Content:** Each log entry includes important contextual information:
    -   `timestamp`: The time the log event occurred.
    -   `level`: The log level (e.g., `info`, `warn`, `error`).
    -   `service`: The name of the microservice that generated the log.
    -   `correlationId`: A unique ID that traces a single request as it travels through multiple services. This is essential for debugging.
    -   `message`: The log message.
    -   Additional metadata relevant to the log event.
-   **File Logging:** The application can also be configured to write logs to daily rotating files stored in the `./logs` directory on the server. This can be useful as a backup or for environments without a centralized logging system.

## 2. Metrics (Prometheus)

The application exposes a wide range of metrics in the [Prometheus](https://prometheus.io/) format. These metrics provide insights into the performance and health of the services.

-   **Library:** [prom-client](https://github.com/siimon/prom-client)
-   **Endpoint:** Each service exposes its metrics at the `/metrics` endpoint. This endpoint is intended to be scraped by a Prometheus server.

### Key Metrics

-   **Default Metrics:** Includes standard Node.js metrics like CPU usage, memory usage, and event loop lag.
-   **HTTP Metrics:**
    -   `http_request_duration_seconds`: A histogram of HTTP request latency, labeled by service, method, path, and status code.
    -   `http_requests_total`: A counter of total HTTP requests.
-   **Business-Specific Metrics:**
    -   `optimize_requests_total`: A counter for advisory engine requests, labeled by the recommended product, user role, and whether a rate override was used.
    -   `optimize_duration_seconds`: A histogram of the time taken for the core optimization calculation.
    -   `fx_feed_up`: A gauge indicating the health of the live foreign exchange rate feed.
    -   `audit_logs_total`: A gauge showing the total number of audit logs persisted.

These metrics can be used to build dashboards (e.g., in Grafana) and set up alerts to proactively identify issues.

## 3. Health Checks

The application provides standard health check endpoints that are used by container orchestrators like Kubernetes to manage the application's lifecycle.

-   **Liveness Probe:** `GET /health/live`
    -   **Purpose:** This endpoint is used by Kubernetes to determine if a container is still running. If this probe fails, Kubernetes will restart the container. It should return a `200 OK` status if the service's process is running.

-   **Readiness Probe:** `GET /health/ready`
    -   **Purpose:** This endpoint is used by Kubernetes to determine if a container is ready to start accepting traffic. If this probe fails, Kubernetes will not send traffic to the container, even if it is running. A service is "ready" when it has successfully connected to its dependencies (like databases and other services) and can serve requests.

These probes are essential for ensuring zero-downtime deployments and the overall resilience of the application in a production environment.
