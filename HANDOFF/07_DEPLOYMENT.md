# Deployment Guide (Kubernetes)

This document provides instructions for deploying the CSB Bank API application to a Kubernetes cluster. The `k8s` directory in the root of the project contains the necessary Kubernetes manifest files.

## Prerequisites

-   A running Kubernetes cluster.
-   `kubectl` configured to connect to your cluster.
-   A container registry (like Docker Hub, GCR, or a private registry) where the Docker images for the services will be stored.
-   An Ingress controller (like NGINX Ingress Controller) installed in your cluster to handle external traffic.

## 1. Build and Push Docker Images

Before deploying, you need to build the Docker images for each microservice and push them to your container registry.

The `docker-compose.yml` file can be used as a reference for which services to build. You will need to build images for: `esb`, `auth`, `audit`, `yield-engine`, `bank`, `gateway`, and `frontend`.

For each service, navigate to the project root and run:

```bash
# Example for the gateway service
docker build -f src/gateway/Dockerfile -t <your-registry>/gateway:latest .
docker push <your-registry>/gateway:latest
```

You will need to repeat this for all services. Remember to update the `image` field in the Kubernetes `Deployment` files to point to your registry.

**Note:** The provided Kubernetes manifests in the `k8s` directory do not include deployment files for `auth-service`, `audit-service`, and `bank-integration-service`. These will need to be created, likely by using the existing deployment files as templates.

## 2. Create the Namespace

A dedicated namespace `nri-yield` is used to isolate the application resources.

```bash
kubectl apply -f k8s/namespace.yaml
```

## 3. Create Secrets

The application requires secrets to be stored in the cluster. An example secret file is provided at `k8s/secret.example.yaml`.

1.  **Create a `secret.yaml` file:**
    Copy `k8s/secret.example.yaml` to a new file (e.g., `k8s/secret.prod.yaml`). **Do not commit this file to version control.**

2.  **Encode your secrets:**
    The values in the `data` section of a Kubernetes Secret must be base64-encoded.

    ```bash
    # Example for generating a base64 encoded HMAC secret
    echo -n "your-super-secret-hmac-key" | base64
    ```

    Update the `secret.prod.yaml` file with your base64-encoded secrets, including `HMAC_SHARED_SECRET`, `JWT_SECRET`, and any other sensitive values.

3.  **Apply the secret:**
    ```bash
    kubectl apply -f k8s/secret.prod.yaml
    ```

## 4. Apply Configuration

The application's non-sensitive configuration is stored in a `ConfigMap`.

```bash
kubectl apply -f k8s/configmap.yaml
```

## 5. Deploy Application Services

Deploy all the application components, including Redis and the microservices.

```bash
# Deploy Redis
kubectl apply -f k8s/redis-deployment.yaml

# Deploy microservices
kubectl apply -f k8s/esb-deployment.yaml
kubectl apply -f k8s/yield-engine-deployment.yaml
kubectl apply -f k8s/gateway-deployment.yaml
kubectl apply -f k8s/frontend-deployment.yaml

# Remember to create and apply deployments for auth, audit, and bank services as well.
```

This will create the `Deployments` and `Services` for each microservice.

## 6. Apply Network Policies

For enhanced security, network policies are defined to restrict traffic between pods. These policies ensure that services can only communicate with other services they are supposed to.

```bash
kubectl apply -f k8s/network-policy.yaml
```

## 7. Expose the Application with an Ingress

The `ingress.yaml` file defines rules to route external traffic to the `frontend` and `gateway` services.

Before applying, you may need to edit `ingress.yaml` to specify your hostname and configure TLS.

```bash
kubectl apply -f k8s/ingress.yaml
```

Once the Ingress is created, you should be able to access the application at the host you configured.

## 8. Verifying the Deployment

You can check the status of your deployed resources:

```bash
# Check pods in the nri-yield namespace
kubectl get pods -n nri-yield

# Check services
kubectl get services -n nri-yield

# Check ingress
kubectl get ingress -n nri-yield
```

You can also view the logs of a specific pod to troubleshoot any issues:

```bash
kubectl logs -f <pod-name> -n nri-yield
```
