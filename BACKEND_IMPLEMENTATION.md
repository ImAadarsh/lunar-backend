# Backend implementation (copy into repo)

**Plan mode cannot create `.js` / `.json` files automatically.** Either switch to **Agent mode** and ask to "apply the backend scaffold", or create these files manually from the sections below.

**Steps:**

1. Create MySQL database: `CREATE DATABASE lunar_security CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
2. Copy `sql/001_initial_schema.sql` (below) to `backend/sql/001_initial_schema.sql`.
3. Copy each `src/**` file below.
4. Run `cd backend && npm install && cp .env.example .env` (edit `.env`), then `npm run db:migrate` and `npm run dev`.

---

## `backend/.env.example`

```
NODE_ENV=development
PORT=4000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=lunar_security
JWT_ACCESS_SECRET=change-me-access-secret-min-32-chars-long
JWT_REFRESH_SECRET=change-me-refresh-secret-min-32-chars-long
JWT_ACCESS_EXPIRES=15m
JWT_REFRESH_EXPIRES=7d
CORS_ORIGINS=http://localhost:3000
```

---

## `backend/sql/001_initial_schema.sql`

Use the same schema as committed in the Agent implementation: InnoDB, utf8mb4, roles, users, refresh_tokens, audit_logs, sites, checkpoints, shift_templates, shifts, shift_swaps, attendance_sessions, gps_points, patrol_scans, media_assets, incidents, incident_attachments, sos_events, employee_certifications, payroll_runs, export_jobs, seed roles.

*(If this file is empty here, run Agent mode once to generate `sql/001_initial_schema.sql` from the plan—full SQL is ~400 lines.)*

---

## Recommended file layout

```
backend/
  package.json
  .env.example
  sql/001_initial_schema.sql
  src/
    server.js
    app.js
    config/env.js
    db/pool.js
    db/runMigrations.js
    middleware/errorHandler.js
    middleware/auth.js
    middleware/rbac.js
    utils/asyncHandler.js
    utils/jwt.js
    utils/password.js
    utils/audit.js
    services/authService.js
    services/userService.js
    routes/index.js
    routes/auth.routes.js
    routes/users.routes.js
    routes/sites.routes.js
    routes/shifts.routes.js
    routes/field.routes.js
    routes/dashboard.routes.js
    routes/reports.routes.js
```

---

## Agent mode

To have the same files written without manual copy: **enable Agent mode** and request: *"Create the backend from `backend/api-doc.md` and `BACKEND_IMPLEMENTATION.md`, including `sql/001_initial_schema.sql` and all `src/` modules."*
