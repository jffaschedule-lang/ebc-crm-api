# EBC/JPFD Workforce CRM — API

Express + TypeScript backend for the EBC/JPFD Workforce CRM. All business
logic (leave slot capacity, FIFO waitlist promotion, payroll, timesheets,
PDF generation, email notifications) lives here. The frontend
(`ebc-crm-web`) never computes these answers itself — it calls this API and
renders what comes back.

## Architecture

- **Express + TypeScript**, strict mode.
- **Supabase** (PostgreSQL 15) for storage, Auth, Realtime, and file storage.
  The backend uses `SUPABASE_SERVICE_ROLE_KEY` and bypasses RLS; RLS exists
  to protect the frontend's direct Supabase Auth calls, not general data
  access (see `supabase/rls_policies.sql`).
- **Puppeteer + @sparticuz/chromium** for server-side PDF generation
  (timesheets, payroll packets), uploaded to Supabase Storage with signed URLs.
- **Resend** for outbound email via an outbox pattern
  (`notifications_outbox` — see `emailService.ts`).
- **Railway** for hosting the API and the daily shift-packet cron job.

## Local setup

```bash
cp .env.example .env
# fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
# SUPABASE_JWT_SECRET, and (optionally) RESEND_API_KEY
npm install
npm run dev
```

The server starts on `http://localhost:3001`. Confirm it's up:

```bash
curl http://localhost:3001/api/health
```

Run `npm run check-env` at any time to see which required/optional
environment variables are set.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | no (default 3001) | Port the Express server listens on |
| `NODE_ENV` | no (default development) | `development` \| `production` \| `test` |
| `SUPABASE_URL` | yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server-only key, bypasses RLS — never expose to the frontend |
| `SUPABASE_ANON_KEY` | yes | Used server-side only to verify incoming user JWTs |
| `SUPABASE_JWT_SECRET` | yes | From Supabase Dashboard → Settings → API |
| `FRONTEND_URL` | no (default localhost:5173) | Allowed CORS origin |
| `RESEND_API_KEY` | no | From resend.com — email sends are skipped (logged) if unset |
| `FROM_EMAIL` | no | Verified sender address |
| `CRON_SECRET` | no | Shared secret required in `X-Cron-Secret` for the shift-packet job |
| `LOG_LEVEL` | no (default info) | winston log level |

## Database setup

Run these in the Supabase SQL Editor, in order:

1. `supabase/schema.sql`
2. `supabase/triggers.sql`
3. `supabase/rls_policies.sql`

See `MIGRATION.md` for the full Supabase project setup and Google Sheets
data migration guide.

## Running tests

```bash
npm test
```

`tests/integration/leaveFlow.test.ts` exercises the leave submission →
waitlist → FIFO promotion flow end-to-end against a Supabase project. Set
`SUPABASE_URL_TEST`, `TEST_USER_JWT`, and `TEST_EMPLOYEE_ID` in `.env.test`
before running against a real (test) database. `emailService` is mocked so
no real emails send during tests.

## Deploying to Railway

1. Connect this repository to a new Railway service.
2. Set all environment variables from the table above (Railway → Variables).
3. Railway builds with Nixpacks and runs `npm run build` then
   `node dist/index.js` (see `railway.json`).
4. Add a Railway uptime check on `GET /api/health`.
5. Add a second Railway service for the shift-packet cron job — see
   `railway.json`'s `shift-packet-cron` service. Its `cronSchedule` is UTC:
   `15 14 * * *` = 14:15 UTC = 08:15 America/Chicago during CST. Adjust to
   `15 13 * * *` (13:15 UTC) during CDT (Railway cron does not follow DST
   automatically).

## API endpoint reference

All responses use the envelope:
`{ success: true, data, meta? }` or `{ success: false, error: { code, message } }`.

| Method | Path | Description | Auth |
|---|---|---|---|
| GET | `/api/health` | Liveness check | none |
| GET | `/api/employees` | List employees (filter: platoon, rank, station, search, page, limit) | JWT |
| GET | `/api/employees/:id` | Get one employee | JWT |
| POST | `/api/employees` | Create employee | supervisor |
| PATCH | `/api/employees/:id` | Update employee | supervisor |
| GET | `/api/rotation/date/:date` | Rotation info for a shift date | JWT |
| GET | `/api/rotation/period/:pp_end` | All 14 days for a pay period | JWT |
| GET | `/api/duty-ledger/date/:date` | Duty ledger rows for a date | JWT |
| POST | `/api/duty-ledger/generate` | Generate duty ledger rows for a date | supervisor |
| PATCH | `/api/duty-ledger/:id` | Update acting note / duty status | supervisor |
| POST | `/api/leave` | Submit a leave request | JWT |
| GET | `/api/leave/slots/:platoon/:date` | AL slot ledger for platoon+date | JWT |
| GET | `/api/leave-records` | List leave records (filters) | JWT |
| PATCH | `/api/leave-records/:id/status` | Grant / Cancel / Delete a leave record | JWT (see RLS) |
| GET | `/api/timesheet/:employee_id?pp_end=` | Build/read a timesheet | JWT |
| POST | `/api/timesheet/:employee_id/export?pp_end=` | Export timesheet PDF | JWT |
| GET | `/api/payroll/date/:date` | Payroll rows for a date | JWT |
| POST | `/api/payroll/date/:date/generate` | Generate payroll rows | supervisor |
| POST | `/api/payroll/date/:date/export/:district` | Export payroll PDF | JWT |
| GET | `/api/workforce/date/:date` | Seat-check / shortage report | JWT |
| GET | `/api/overtime/tier/:rank_group` | OT tier board | JWT |
| POST | `/api/overtime/availability` | Add OT availability | JWT |
| DELETE | `/api/overtime/availability/:id` | Remove own OT availability | JWT |
| GET | `/api/overtime/requests` | List OT requests | JWT |
| GET | `/api/shift-close/date/:date/station/:station` | Check shift close status | JWT |
| POST | `/api/shift-close` | Close a shift, email packet | supervisor |
| GET | `/api/audit` | Paginated audit log | supervisor |
| GET | `/api/settings` | All settings | JWT |
| PATCH | `/api/settings/:key` | Update a setting | admin |
