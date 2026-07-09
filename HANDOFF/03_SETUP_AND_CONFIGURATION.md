# Local Setup and Environment Configuration

This guide provides instructions for setting up the CSB Bank API project for local development. There are two primary ways to run the application: using `docker-compose` (recommended) or running each service manually with `npm`.

## Prerequisites

-   [Node.js](https://nodejs.org/) (v20.0.0 or higher)
-   [npm](https://www.npmjs.com/)
-   [Docker](https://www.docker.com/) and [Docker Compose](https://docs.docker.com/compose/)
-   [Git](https://git-scm.com/)

## 1. Clone the Repository

```bash
git clone <repository-url>
cd CSB_BANK_API_PROJECT-main
```

## 2. Environment Configuration

The project uses a `.env` file to manage environment variables. A `.env.example` file is provided with sensible defaults for local development.

1.  **Create a `.env` file:**

    ```bash
    cp .env.example .env
    ```

2.  **Review and update variables:**

    Open the `.env` file and fill in any missing values, especially secrets. For local development, you will need to provide values for:

    You will need to set a password for the `app_user` in your `.env` file.

    -   `HMAC_SHARED_SECRET`: A secret key for HMAC signature validation.
    -   `JWT_SECRET`: A secret key for signing and verifying JSON Web Tokens.
    -   `AUTH_DEMO_PASSWORD`: A password for the default demo users.
    -   `MYSQL_PASSWORD`: The password for the `app_user` database user.

    You can generate secure random strings for the secrets.

## 3. Database Setup

The application requires a MySQL database. The `docker-compose.yml` file includes a MySQL service, which is the recommended way to run the database locally.

1.  **Start the MySQL and Redis databases:**

    Ensure `MYSQL_PASSWORD` is set in your `.env` file before running this command.

    ```bash
    docker-compose up -d mysql redis
    ```

2.  **Initialize the database schema:**

    The `schema.sql` file contains the necessary SQL statements to create the database tables. You can execute this script against the `csb_bank` database created by the `docker-compose` service.

    You can use a MySQL client or the following `docker exec` command, which sources the password from your `.env` file:

    ```bash
    docker-compose exec -T mysql mysql -u app_user -p"$(grep MYSQL_PASSWORD .env | cut -d '=' -f2)" csb_bank < schema.sql
    ```
    *Note: The `docker-compose.yml` file configures the MySQL user as `app_user` and reads the password from the `MYSQL_PASSWORD` variable in your `.env` file.*

## 4. Running the Application

### Option A: Using Docker Compose (Recommended)

This is the simplest way to start all the services.

1.  **Build and start all services:**

    ```bash
    docker-compose up --build
    ```

    This command will build the Docker images for each service and start them in the correct order as defined by `depends_on`.

2.  **Accessing the application:**
    -   **Frontend:** `http://localhost:3000`
    -   **API Gateway:** `http://localhost:8080`

### Option B: Running Services Manually with npm

If you prefer not to use Docker for the application services, you can run them directly using `npm`. You will still need Docker for the MySQL and Redis databases.

1.  **Install dependencies:**

    ```bash
    npm install
    ```

2.  **Start all services concurrently:**

    The `package.json` file includes a script to start all services.

    ```bash
    npm run start:all
    ```

    This will run the `auth`, `bank`, `audit`, `esb`, `yield-engine`, `gateway`, and `frontend` services concurrently.

3.  **Running individual services:**

    You can also run services individually if you are working on a specific one:

    ```bash
    npm run start:gateway
    npm run start:yield-engine
    # and so on for other services...
    ```

## 5. Stopping the Application

-   **If using `docker-compose`**: Press `Ctrl+C` in the terminal where `docker-compose up` is running, then run `docker-compose down` to stop and remove the containers.
-   **If using `npm`**: Press `Ctrl+C` in the terminal where `npm run start:all` is running. Stop the databases with `docker-compose down`.
