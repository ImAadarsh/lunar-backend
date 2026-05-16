# Demo users (local / staging)

Run once after migrations:

```bash
cd backend
npm run seed:demo
```

These accounts are for **development only**. Change passwords before any production use.

| Email | Password | Role |
|-------|------------|------|
| `admin@lunarsecurity.demo` | `AdminDemo#2026` | admin |
| `supervisor@lunarsecurity.demo` | `SuperDemo#2026` | supervisor |
| `guard@lunarsecurity.demo` | `GuardDemo#2026` | **guard** (mobile app) |

The guard Flutter app should sign in with **`guard@lunarsecurity.demo`** / **`GuardDemo#2026`** by default.

## Import guards roster (Excel)

After migrations, import **Guards Data.xlsx** (114 staff rows):

```bash
npm run db:migrate
npm run seed:guards -- "/path/to/Guards Data.xlsx"
```

- Creates **`guard`** users with emails like `firstname.surname@guards.lunarsecurity.local`
- Stores HR/SIA fields in **`guard_profiles`** and an **`employee_documents`** SIA licence row
- Default password: **`GuardImport#2026`** (set `GUARD_IMPORT_DEFAULT_PASSWORD` to override)
- Re-running the import updates existing rows matched by email, phone, or full name
