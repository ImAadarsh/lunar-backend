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
