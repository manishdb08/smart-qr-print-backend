# Smart QR Print — Production Backend API

A production-grade, zero-trust backend service for the **Smart QR Print** network. Users scan a dynamic QR code on physical printer kiosks, upload documents securely, apply AI/deterministic transformations with user preview approval, pay via Razorpay (strict integer paise pricing), and dispatch jobs to authenticated local hardware printer agents without ever exposing local printers to the public internet.

---

## 🛠️ Tech Stack

- **Runtime & Language**: Node.js (v20+ / v24+), TypeScript 5.8
- **Web Framework**: Fastify 5.x (high performance, schema-validated, OpenAPI integration)
- **Database ORM**: PostgreSQL 16 + Prisma ORM (all 14 core domain models)
- **Background Workers**: Redis 7 + BullMQ
- **Payment Gateway**: Razorpay Node SDK (HMAC SHA-256 verification, idempotent webhooks)
- **AI & Document Processing**: Google Gemini API via Provider Adapter + deterministic `pdf-lib` & `sharp`
- **Authentication**: Supabase Auth (JWT validation) + RBAC (`customer`, `printer_operator`, `admin`, `print_agent`)
- **Containerization**: Docker Compose (PostgreSQL 16 Alpine + Redis 7 Alpine)
- **Documentation**: OpenAPI 3.0 via `@fastify/swagger` and Swagger UI (`/docs`)
- **Testing**: Vitest with in-process HTTP lifecycle testing via `fastify.inject`

---

## 🏛️ Architectural Guardrails

1. **Zero-Trust Client Data**: The API never trusts client-supplied price, payment status, printer status, page count, or AI-generated settings.
2. **Integer Paise Storage**: All currency is calculated and stored in integer paise (e.g., 200 paise = ₹2.00). Floating-point currency is strictly forbidden.
3. **Immutable Originals & Derivation Chains**: Uploaded original assets are immutable. Every crop, rotate, enhance, or AI edit creates an explicit `AssetVersion`.
4. **AI Boundary Isolation**: AI never makes payment, dispatch, authorization, or pricing decisions. Natural language instructions are translated to strict JSON and previewed for customer approval.
5. **Asynchronous Execution**: Heavy document processing and printer agent dispatch are offloaded to BullMQ worker queues.
6. **Cryptographic Signatures**: QR sessions and printer dispatch packages use short-lived HMAC-signed tokens.

---

## 📁 Clean Directory Structure

```
smart-qr-print-backend/
├── .github/
│   └── workflows/
│       ├── ci.yml              # GitHub Actions CI matrix (Node 20, 22), lint, tests & build
│       └── docker-publish.yml  # Automated multi-arch GHCR container release pipeline
├── Dockerfile                  # Multi-stage Alpine container (builder + non-root runner)
├── .dockerignore               # Security & build optimization exclusions
├── docker-compose.yml          # PostgreSQL 16 + Redis 7 + API + Worker topology
├── package.json                # Dependencies, scripts, and build configuration
├── tsconfig.json               # Modern strict TypeScript configuration
├── vitest.config.ts            # Vitest integration test configuration
├── .env.example                # Template of all required environment variables
├── prisma/
│   └── schema.prisma           # 14 core database models, enums, indexes, constraints
├── src/
│   ├── app.ts                  # Fastify application factory, plugins, CORS, Swagger, probes
│   ├── server.ts               # HTTP server entrypoint
│   ├── worker.ts               # BullMQ async transformation worker entrypoint
│   ├── config/
│   │   └── index.ts            # Zod-validated environment config & default pricing rules
│   ├── types/
│   │   └── index.ts            # Global TypeScript types, roles, Fastify augmentations
│   ├── db/
│   │   ├── client.ts           # Prisma client singleton and database health checks
│   │   └── seed.ts             # Seeder for library-a4-01, lab-mono-01, users, and agents
│   ├── auth/
│   │   ├── supabase.ts         # Supabase Auth token verification adapter
│   │   ├── rbac.ts             # Role-based access control hooks and ownership checks
│   │   └── agentAuth.ts        # Constant-time printer agent shared secret authentication
│   ├── middleware/
│   │   ├── errorHandler.ts     # Secure centralized error handler (RFC 7807 problem details)
│   │   └── audit.ts            # Asynchronous audit event recorder
│   └── modules/
│       ├── qr-sessions/        # POST /v1/qr-sessions with cryptographic signatures
│       │   ├── qrSession.types.ts
│       │   ├── qrSession.service.ts
│       │   └── qrSession.routes.ts
│       └── printers/           # GET /v1/printers, GET /v1/printers/:id, capabilities
│           ├── printer.types.ts
│           ├── printer.service.ts
│           └── printer.routes.ts
└── tests/
    ├── milestone1.test.ts      # Database, Auth, QR Sessions, Capabilities, RBAC
    ├── milestone2.test.ts      # Uploads, Magic Bytes, Malware Scanner, Asset Versioning
    ├── milestone3.test.ts      # BullMQ AI & Document Transformations, User Approval
    ├── milestone4.test.ts      # Pricing Engine, Razorpay Orders, HMAC Webhooks, Refunds
    └── milestone5.test.ts      # Hardware Printer Agent Claim, Isolation, Status Flow
```

---

## 🖨️ Seeded Printers & Default Pricing

### Seeded Hardware Kiosks:
1. `library-a4-01`:
   - Capabilities: Mono & Color, Duplex, Page Size: `["A4"]`, Max DPI: 1200
   - Location: Main Library 1st Floor - Kiosk Area
2. `lab-mono-01`:
   - Capabilities: Mono only, Duplex, Page Size: `["A4"]`, Max DPI: 600
   - Location: CS Building Room 204

### Default Pricing Rules (`v1.0.0`):
- **Mono**: 200 paise / page (₹2.00)
- **Color**: 800 paise / page (₹8.00)
- **Duplex Discount**: 10%
- **Minimum Order**: 200 paise (₹2.00)

---

## 🚀 Getting Started

### 1. Prerequisites
- Node.js v20.x or v24.x
- Docker and Docker Compose (for local PostgreSQL & Redis)

### 2. Configure Environment
```bash
cp .env.example .env
```
Ensure required secrets are configured in `.env`.

### 3. Start Local PostgreSQL and Redis
```bash
docker compose up -d
```

### 4. Generate Prisma Client & Migrate
```bash
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
```

### 5. Start the Development Server
```bash
npm run dev
```
The server will boot at `http://localhost:4000`:
- **OpenAPI / Swagger UI**: `http://localhost:4000/docs`
- **OpenAPI JSON Spec**: `http://localhost:4000/docs/json`
- **Health Check**: `http://localhost:4000/health`
- **Readiness Check**: `http://localhost:4000/ready`

---

## 🐳 Docker & Container Deployment

The backend provides a production-hardened multi-stage `Dockerfile` (`node:22-alpine`) that achieves minimal attack surface, runs under an unprivileged user (`USER node`), and implements automatic container health checks.

### 1. Full Stack Deployment (API + Worker + DB + Redis)
Start the complete production topology with one command:
```bash
docker compose up --build -d
```
This spins up:
- **`postgres`**: PostgreSQL 16 Alpine with healthcheck and persistent volume
- **`redis`**: Redis 7 Alpine with password protection and append-only persistence
- **`api`**: Fastify REST API (`http://localhost:5000`) with automatic `/health` checks
- **`worker`**: BullMQ async worker daemon for AI & document processing

### 2. Standalone Docker Image Build & Run
To build and run just the application container:
```bash
# Build multi-stage image
docker build -t smart-qr-print-backend:latest .

# Run container with environment configuration
docker run -d \
  --name smart-qr-api \
  -p 5000:5000 \
  -e DATABASE_URL="postgresql://user:pass@host:5432/smart_qr_print" \
  -e REDIS_URL="redis://:pass@host:6379" \
  -e JWT_SECRET="your-32-character-jwt-secret-string" \
  -e AGENT_SHARED_SECRET="your-agent-shared-secret-key" \
  smart-qr-print-backend:latest
```

### 3. Scaling Background Workers
To scale asynchronous transformation workers independently to handle high PDF/OCR loads:
```bash
docker compose up --scale worker=4 -d
```

---

## 🔄 CI/CD Automation (GitHub Actions)

Continuous Integration and Continuous Deployment workflows are configured under `.github/workflows/`:

1. **`ci.yml` (Automated CI Pipeline)**:
   - **Triggers**: On every `push` or `pull_request` targeting `main` or `master`.
   - **Matrix Verification**: Tests against both **Node.js 20.x** and **Node.js 22.x**.
   - **Quality Checks**: Executes `npm ci`, `npx prisma generate`, strict TypeScript checking (`npm run typecheck`), and the Vitest test suite (`npm test`).
   - **Build Verification**: Compiles production bundles (`npm run build`).
   - **Docker Validation**: Builds the multi-stage Docker container via Buildx with GitHub Actions caching to guarantee deployment readiness.

2. **`docker-publish.yml` (Automated GHCR Deployment)**:
   - **Triggers**: On Git release tags (`v*`) or manual `workflow_dispatch`.
   - **Multi-Architecture**: Cross-compiles images for `linux/amd64` and `linux/arm64` via QEMU and Docker Buildx.
   - **Registry**: Automatically publishes to GitHub Container Registry (`ghcr.io/<owner>/smart-qr-print-backend`) with semantic versioning (`v1.0.0`, `v1.0`, `sha-*`, `latest`).

---

The test suite runs using Vitest and tests the full HTTP request/response cycle, schema validation, HMAC cryptographic signing, printer capabilities, and RBAC rules without external side-effects:

```bash
npm test
```

### Test Suite Coverage (75 Automated Integration Tests):
- **Milestone 1**: Database, Auth, Probes, Seeded Printers, Hardware Capabilities, Short-lived HMAC QR Sessions, RBAC.
- **Milestone 2**: Presigned Uploads, Magic Bytes Validation, SHA-256 Checksum, Page Count Extraction, Malware Quarantine, Asset Versioning & Derivation.
- **Milestone 3**: AI Processing Queue, Gemini Document Understanding, OCR, Translation, Natural Language to Strict JSON, Prompt-Injection Protection, Deterministic PDF/Image Operations, Preview & Approval/Rejection Workflow.
- **Milestone 4**: Server-side Pricing Engine, Price Tampering Prevention, Integer Paise Enforcement, Razorpay Order Generation, HMAC Payment Signature Verification, Raw Body Webhook Verification, Webhook Replay Idempotency, Refund Handling, Payment Reconciliation.
- **Milestone 5**: Hardware Printer Agent Polling & Claiming, Only Paid/Approved Job Dispatch, Short-lived Signed Print Package URLs, Hardware Status Reporting Progression, Hardware Failure Tracking & Retry Policy, Cross-Printer Isolation, Offline Printer Detection.

---

## 🧭 Milestone Roadmap

- [x] **Milestone 1**: Database & Auth Foundation (Prisma 14 models, Roles, Seed, Fastify, OpenAPI, QR sessions, RBAC, Agent Auth).
- [x] **Milestone 2**: Presigned Uploads, Magic Bytes Validation, Checksum, Asset Versioning & Derivations, Malware Scanner Interface.
- [x] **Milestone 3**: BullMQ Async AI & Document Processing (Gemini Adapter, PDF/Image transformations, User Approval/Rejection).
- [x] **Milestone 4**: Razorpay Integration (Order generation, Server-side quote, HMAC signature verification, Idempotent webhook, Payment reconciliation).
- [x] **Milestone 5**: Local Printer Agent Dispatch (Job claim polling, Signed download packages, Status reporting, Offline detection).

---

## 💳 Razorpay Test Mode & Webhook Setup

### 1. Razorpay Test Mode Setup
1. Log in to your [Razorpay Dashboard](https://dashboard.razorpay.com/) and toggle to **Test Mode**.
2. Navigate to **Settings > API Keys** and generate a Key ID and Key Secret.
3. Add these credentials to your `.env` file:
   ```env
   RAZORPAY_KEY_ID=rzp_test_...
   RAZORPAY_KEY_SECRET=...
   ```
4. Client checkouts use `RAZORPAY_KEY_ID`, while order creation and server-side HMAC verification use `RAZORPAY_KEY_SECRET`.

### 2. Razorpay Webhook Configuration
1. In Razorpay Dashboard, go to **Settings > Webhooks > Add New Webhook**.
2. Webhook URL:
   - For local development: Use `ngrok` or `localtunnel` (`https://<subdomain>.ngrok-free.app/v1/webhooks/razorpay`).
   - For production: `https://api.yourdomain.com/v1/webhooks/razorpay`.
3. Secret: Enter a strong random string and configure it in `.env`:
   ```env
   RAZORPAY_WEBHOOK_SECRET=your_webhook_secret_here
   ```
4. Active Events to select:
   - `order.paid`
   - `payment.captured`
   - `payment.failed`
5. The backend validates the signature using constant-time comparison on the raw request body and deduplicates event deliveries via unique `PaymentEvent.eventId` tracking.

---

## 📋 Production Readiness Checklist

Before deploying this backend to production:
- [ ] **Strict Secrets Management**: Inject all `.env` values through AWS Secrets Manager, GCP Secret Manager, or Doppler. Never commit `.env` or hardcode secrets in source code.
- [ ] **Database Connection Pooling**: Ensure `DATABASE_URL` connects through PgBouncer or Supabase connection pooler in transaction mode for high concurrency.
- [ ] **Redis Persistence**: Enable Redis AOF / RDB snapshots for BullMQ persistent queue processing.
- [ ] **Object Storage Policies**: Ensure Supabase Storage bucket `smart-qr-print-documents` is private with signed-URL-only read/write access.
- [ ] **CORS Restriction**: Set `CORS_ORIGIN` to exact allowed frontend kiosk and client domains (e.g. `https://kiosk.smartqrprint.com`).
- [ ] **Malware Engine**: Connect `MalwareScanner` to live ClamAV daemon or AWS GuardDuty for production scanning.
- [ ] **Hardware Printer Daemon**: Ensure local printer agents run as persistent systemd or Windows services with isolated `X-Agent-Secret` credentials.
- [ ] **Scheduled Jobs**: Run payment reconciliation (`reconcilePendingPayments`) and offline printer detection (`detectOfflinePrinters`) on a 5-minute cron.
