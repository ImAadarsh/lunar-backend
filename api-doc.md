# Lunar Security API

Base URL: `http://localhost:4000/api/v1` (configurable via `PORT`).

**Implementation:** Express + MySQL. Run `npm run db:migrate` for schema (including `003_payroll_export_enhancements`: payroll lines, export `params`, user `pay_rate_pence_hour`). Authenticated routes expect `Authorization: Bearer <accessToken>` from `POST /api/v1/auth/login` (and `POST /api/v1/auth/login/2fa` when 2FA is enabled) or `/auth/register`.

**Payroll:** `payroll/runs` are processed by `npm run worker`: hours come from closed `attendance_sessions` in the period; gross uses `users.pay_rate_pence_hour` or **£12.00/hr** default; PAYE + NI are **illustrative UK-style** prorates — verify against HMRC or a payroll provider before production.

**Exports:** `POST /reports/exports` stores optional `params`. The worker writes a CSV under `EXPORT_FILES_DIR` (default `./exports`) and sets `file_url`. Download the file with `GET /reports/exports/:id/file` (same auth as job status).

All JSON bodies use `Content-Type: application/json`. Responses use `{ "data": ... }` on success or `{ "error": { "code", "message", "details" } }` on failure.

## Authentication

- **Bearer JWT** on protected routes: `Authorization: Bearer <access_token>`
- **Roles**: `admin` (full), `supervisor` (operations), `guard` (field app)
- **2FA (TOTP):** Optional per user. After password login, if enabled, the API returns `requiresTwoFactor: true` and a `preAuthToken` (short-lived JWT). Complete login with `POST /auth/login/2fa`. Pre-auth tokens cannot be used as normal API bearer tokens.

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/auth/login` | POST | Public | Email + password; may return `requiresTwoFactor` + `preAuthToken` |
| `/auth/login/2fa` | POST | Public | Body: `preAuthToken`, `token` (TOTP) → access + refresh |
| `/auth/refresh` | POST | Public | Refresh token body; new access + refresh |
| `/auth/logout` | POST | Bearer | Revokes refresh token |
| `/auth/register` | POST | Admin | Create user (bootstrap / admin) |
| `/auth/2fa/setup` | POST | Bearer | Returns `secret` + `otpauthUrl` (store secret pending enable) |
| `/auth/2fa/enable` | POST | Bearer | Body: `token` — confirms TOTP and enables 2FA |
| `/auth/2fa/disable` | POST | Bearer | Body: `password`, `token` — disables 2FA |

### POST `/auth/login`

Body: `{ "email": string, "password": string }`

Success (no 2FA): `{ "data": { "accessToken", "refreshToken", "expiresIn", "user" } }`

Success (2FA required): `{ "data": { "requiresTwoFactor": true, "preAuthToken", "user" } }` — no refresh token until `/auth/login/2fa`.

### POST `/auth/login/2fa`

Body: `{ "preAuthToken": string, "token": string }` (6-digit authenticator code)

### POST `/auth/register`

Body: `{ "email", "password", "role": "admin"|"supervisor"|"guard", "phone"? }`

---

## Users & HR

| Endpoint | Method | Roles | Description |
|----------|--------|-------|-------------|
| `/users` | GET | admin, supervisor | List users (query: `role`, `status`, `page`, `limit`) |
| `/users/:id` | GET | admin, supervisor, self | Get user (`payRatePenceHour` only for admin or self) |
| `/users` | POST | admin | Create user |
| `/users/:id` | PATCH | admin, self (limited) | Update profile; **admin:** `payRatePenceHour` (pence/hr, nullable) |
| `/users/:id` | DELETE | admin | Soft-disable |
| `/users/:id/site-access` | GET | admin | Supervisor site allow-list (migration `002`) |
| `/users/:id/site-access` | PUT | admin | Body `{ "siteIds": number[] }` — supervisors only |

---

## Sites & checkpoints

| Endpoint | Method | Roles | Description |
|----------|--------|-------|-------------|
| `/sites` | GET | admin, supervisor | List sites |
| `/sites` | POST | admin, supervisor | Create site + geofence |
| `/sites/:id` | GET | admin, supervisor, guard | Site detail |
| `/sites/:id` | PATCH | admin, supervisor | Update site |
| `/sites/:id` | DELETE | admin | Deactivate site |
| `/sites/:siteId/checkpoints` | GET | admin, supervisor, guard | List checkpoints |
| `/sites/:siteId/checkpoints` | POST | admin, supervisor | Create checkpoint + QR code |
| `/checkpoints/:id` | PATCH | admin, supervisor | Update checkpoint |
| `/checkpoints/:id` | DELETE | admin, supervisor | Remove checkpoint |

---

## Shifts & swaps

| Endpoint | Method | Roles | Description |
|----------|--------|-------|-------------|
| `/shift-templates` | GET | admin, supervisor | List templates |
| `/shift-templates` | POST | admin, supervisor | Create template |
| `/shift-templates/:id` | PATCH | admin, supervisor | Update |
| `/shift-templates/:id` | DELETE | admin, supervisor | Delete |
| `/shifts` | GET | admin, supervisor, guard | List shifts (filters: `userId`, `siteId`, `from`, `to`, `status`) |
| `/shifts` | POST | admin, supervisor | Schedule shift |
| `/shifts/:id` | PATCH | admin, supervisor | Update / cancel |
| `/shift-swaps` | POST | guard, supervisor | Request swap |
| `/shift-swaps/:id` | PATCH | admin, supervisor | Approve / reject |

---

## Field operations (guard app)

| Endpoint | Method | Roles | Description |
|----------|--------|-------|-------------|
| `/attendance/check-in` | POST | guard | Body: `shiftId`, `lat`, `lng` — validates geofence |
| `/attendance/check-out` | POST | guard | Body: `sessionId`, `lat`, `lng` |
| `/attendance/sessions` | GET | guard, supervisor | Sessions |
| `/telemetry/gps` | POST | guard | Batch GPS points |
| `/patrols/scans` | POST | guard | Patrol scan + idempotency |
| `/patrols/scans` | GET | guard, supervisor | Patrol scan history (`siteId?`, `userId?`, `limit?`) |
| `/incidents` | POST | guard | Create incident |
| `/incidents` | GET | guard, supervisor | List (filters) |
| `/incidents/:id` | GET | guard, supervisor | Detail + attachments |
| `/incidents/:id` | PATCH | supervisor, admin | Status |
| `/incidents/:id/attachments` | POST | guard | `{ "mediaId" }` |
| `/sos` | POST | guard | Panic |
| `/sos` | GET | supervisor, admin | List |
| `/sos/:id` | PATCH | supervisor, admin | Acknowledge / resolve |
| `/media` | POST | guard, supervisor | Register upload metadata |
| `/media/upload` | POST | guard, supervisor | Multipart upload (`file`, optional `kind`) and metadata registration |
| `/guard/summary` | GET | guard | Dashboard summary (active session, next shift, counts) |

---

## Dashboard & reporting

| Endpoint | Method | Roles | Description |
|----------|--------|-------|-------------|
| `/dashboard/kpis` | GET | admin, supervisor | On-duty, incidents, SOS |
| `/audit-logs` | GET | admin | Audit trail |
| `/reports/exports` | POST | admin, supervisor | Queue job `{ "type", "params"? }` — see export types below |
| `/reports/exports/:id` | GET | admin, supervisor | Job status, `params`, `downloadUrl`, `errorMessage` |
| `/reports/exports/:id/file` | GET | admin, supervisor | **Download** generated CSV |
| `/payroll/runs` | GET | admin | List payroll runs |
| `/payroll/runs` | POST | admin | Create draft run `{ "periodStart", "periodEnd" }` — worker processes |
| `/payroll/runs/:runId` | GET | admin | Run detail + `lines[]` + `resultJson` totals |

### Export job `type` values (CSV)

| `type` | `params` | Content |
|--------|----------|---------|
| `users` | — | User directory |
| `audit_logs` | `limit?` | Recent audit rows |
| `attendance` | `from`, `to` (YYYY-MM-DD) | Attendance sessions overlapping range |
| `incidents` | — | Incidents |
| `sites` | — | Sites |
| `bacs_stub` | — | Placeholder BACS-style text (not bank-valid) |

---

## Compliance

| Endpoint | Method | Roles | Description |
|----------|--------|-------|-------------|
| `/certifications` | GET | admin, supervisor | List (filter `userId`, `expiringBefore`) |
| `/certifications` | POST | admin | Assign certification |
| `/certifications/:id` | PATCH | admin | Update / renew |
| `/certifications/:id` | DELETE | admin | Remove |

---

## Health

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Liveness (`/` on app root) |
| `/ready` | GET | DB connectivity check |

---

## Error codes (examples)

| HTTP | `code` | Meaning |
|------|--------|---------|
| 400 | `VALIDATION_ERROR` | Zod / input validation |
| 401 | `UNAUTHORIZED` | Missing or invalid token |
| 403 | `FORBIDDEN` | RBAC denied |
| 404 | `NOT_FOUND` | Resource missing |
| 409 | `CONFLICT` | Duplicate email, duplicate client id, etc. |
| 500 | `INTERNAL` | Server error |

---

## Versioning

Current version prefix: **`/api/v1`**. Breaking changes will bump to `/api/v2`.
