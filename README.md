# RetailQ — Retail Quality Engineering Automation Platform

Independent grocery e-commerce quality engineering portfolio. **Not affiliated with H-E-B.** Uses synthetic records, simulated payments, and configurable test-only sales tax.

## Requirements

Windows 11, Node.js 22+, npm, Docker Desktop (Linux containers), and Git. Optional: k6.

## Run locally (PowerShell)

```powershell
npm install
$env:JWT_SECRET = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
docker compose up -d db
npm run dev
```

Open http://localhost:5173. The database initializes with sample products and schema migrations on its first container creation. API health: http://localhost:4000/api/health. Create an account with an 8+ character password, sign in, add products, enter `SAVE10`, and place an order. Signed-in baskets persist in PostgreSQL; guest baskets persist in the current browser. Payments are simulated and no card details are collected.

If a database already has the original schema and a persistent volume, apply the new cart/defect migration once:

```powershell
docker compose exec -T db psql -U retailq -d retailq -f /docker-entrypoint-initdb.d/002_customer_cart.sql
```

## Test and quality checks

```powershell
New-Item -ItemType Directory -Force artifacts
npm run typecheck
npm run lint
npm test
npm run test:api-contract
npm run test:coverage
npx playwright install chromium firefox
npm run test:e2e
npm run build
k6 run tests/performance/load.js
```

API tests and coverage do not need a database for the default local run. To run the concurrent checkout integration tests against a migrated PostgreSQL database:

```powershell
$env:DATABASE_URL = 'postgres://retailq:retailq@localhost:5432/retailq'
$env:RUN_DB_INTEGRATION = '1'
npm run test:coverage
```

The black-box API contract runner is based on the API Sentinel approach in the supplied quality-engineering suite. It uses isolated test credentials and performs registration, login, persisted-cart, checkout, idempotency, and order-history checks against a real running API. Use a disposable test database because the suite writes a customer, basket, and order:

```powershell
$env:BASE_URL = 'http://127.0.0.1:4000/api/'
$env:SENTINEL_EMAIL = "contract-$([guid]::NewGuid().ToString('N'))@example.test"
$env:SENTINEL_PASSWORD = "Contract-$([guid]::NewGuid().ToString('N'))"
$env:SENTINEL_IDEMPOTENCY_KEY = "contract-$([guid]::NewGuid().ToString('N'))"
npm run test:api-contract
```

It writes JSON, JUnit XML, and HTML reports under `artifacts/api-contract/`. Playwright starts the API and web server automatically, but requires a running database. Its browser tests use a page-object fixture adapted from the AutoTest Pro pattern and unique synthetic accounts. CI migrates PostgreSQL, runs unit and concurrent integration tests, lint/type checks, browser tests, API contract checks, coverage reporting, and uploads the reports as GitHub Actions artifacts. CI ingests both Vitest and API contract results into the quality dashboard. The supplied CodeVerity runner was not copied because its lint, type-check, dependency-tree, and audit checks overlap the existing project gates; the existing CI keeps those checks attached directly to RetailQ's own configs and lockfile. Generated portfolio/report bundles from the archive were also excluded.

The Playwright matrix covers desktop Chromium, Firefox, WebKit, and Pixel 7 mobile emulation. Failure traces, screenshots, and videos are retained under `artifacts/test-results/`; HTML, JSON, and JUnit reports are written under `artifacts/`. In CI, focused tests are rejected and failed tests are retried once for diagnostics; local runs do not retry.

Coverage output is written to `artifacts/coverage/`. API test JSON is written to `artifacts/api-results.json`. To ingest a report manually, set `RETAILQ_ADMIN_TOKEN` to a valid admin bearer token and run:

```powershell
$env:RETAILQ_ADMIN_TOKEN = '<admin JWT>'
npm run quality:ingest -- artifacts/api-results.json
```

## Admin and security configuration

Registration only creates customer accounts. Promote an existing account from a trusted machine connected to the database:

```powershell
$env:DATABASE_URL = 'postgres://retailq:retailq@localhost:5432/retailq'
node scripts/promote-admin.mjs admin@example.com
```

The user must sign in again after promotion to receive an admin token. Admins can create and update defect records and ingest test runs. Production mode rejects missing or short `JWT_SECRET` values. Configure browser origins with comma-separated `ALLOWED_ORIGINS`; the default allows local Vite development origins. Authentication routes are rate limited, payloads are validated, and API responses include baseline security headers.

## Architecture

```mermaid
flowchart LR
 B[Browser / Playwright] --> W[React + Vite]
 W --> A[Express REST API]
 T[Supertest / Vitest] --> A
 K[k6] --> A
 A --> P[(PostgreSQL)]
 G[GitHub Actions] --> T
 G --> B
```

## Pricing and transactional rules

Prices use integer cents. `SAVE10` subtracts floor(10% of subtotal); tax is rounded to the nearest cent after discounts, default 825 basis points (8.25%), configurable via `TEST_TAX_BPS`. Row locks protect inventory against overselling. Transaction-scoped advisory locks serialize duplicate idempotency keys. Checkout is simulated and does not collect card details.

## Quality dashboard

The Quality tab reads persisted `test_runs` and `defects` rows. Fresh environments correctly show zero executions. Vitest reports can be ingested through the authenticated admin-only `/api/quality/runs` endpoint; the CI workflow performs this ingestion automatically. The defect register supports admin-only creation and status/description updates. Do not describe an empty dashboard as a passing run.

Coverage is summarized in the CI run summary and its detailed HTML/JSON reports are uploaded as artifacts. HTTP routes are tested with Supertest/Vitest and browser behavior with Playwright. A Newman dependency is intentionally not bundled: its current dependency tree introduced multiple high/critical audit findings, so the repository keeps the audited test toolchain clean rather than adding a vulnerable dev dependency.

## Scope and limitations

Implemented: auth, catalog/search/category, persistent signed-in carts, inventory-safe idempotent checkout, promo/tax, order history, quality-run ingestion, admin defect management, responsive UI, HTTP/concurrency tests, browser smoke tests, k6 script, lint/type checks, coverage reports, and GitHub Actions quality gates. Product images use third-party public URLs and need network access. This is a demonstration application, not a production-ready retail platform; a full deployment security review and operational readiness work remain necessary.
