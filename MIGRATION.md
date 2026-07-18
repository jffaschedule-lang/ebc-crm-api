# Migration Guide — EBC/JPFD Workforce CRM

This guide covers standing up the Supabase project, migrating data out of
the legacy Google Sheets workbook, the cutover sequence, the rotation
verification script, and post-launch monitoring.

## Section 1 — Supabase project setup

1. Create a project at [supabase.com](https://supabase.com).
2. Open the SQL Editor and run, **in order**:
   1. `supabase/schema.sql`
   2. `supabase/triggers.sql`
   3. `supabase/rls_policies.sql`
3. Enable Realtime: **Dashboard → Database → Replication** → add
   `duty_ledger`, `leave_records`, and `al_slot_ledger` to the publication.
4. Create a Storage bucket named `pdfs`, set it to **private**. The backend
   writes here and returns short-lived signed URLs — the bucket must never
   be public.
5. Copy these four values into `ebc-crm-api/.env` (and the matching two
   into `ebc-crm-web/.env`):
   - Project URL → `SUPABASE_URL` / `VITE_SUPABASE_URL`
   - `anon` public key → `SUPABASE_ANON_KEY` / `VITE_SUPABASE_ANON_KEY`
   - `service_role` secret key → `SUPABASE_SERVICE_ROLE_KEY` (backend only —
     never put this in `ebc-crm-web`)
   - JWT secret (Settings → API → JWT Settings) → `SUPABASE_JWT_SECRET`

## Section 2 — Google Sheets data migration

### Column mapping

**Employees Master Sheet → `employees` table**

| Sheet column | Target column | Notes |
|---|---|---|
| Col A (Platoon) | `platoon` | |
| Col B (Location) | `station` (as-is) / `station_override` | Set `station_override` only when Col B differs from the company→station map in `companies.station` |
| Col C (Machine) | `company_code` | |
| Col D (Employee No) | `emp_number` | Cast to `INTEGER`, strip leading zeros |
| Col E (Name) | `last_name`, `first_name` | Split on `', '` |
| Col F (Rank) | `rank` | |
| Col G (Status) | `status` | `'Un Active'` → `'Inactive'`, everything else → `'Active'` |
| Col H+ (extra) | remaining fields, or ignore | |

**Database sheet → `duty_ledger` table**

| Sheet column | Target column |
|---|---|
| Col A (Platoon) | `platoon` |
| Col B (Location) | `station` |
| Col C (Machine) | `company_code` |
| Col D (Emp No) | `employee_id` (look up via `employees.emp_number`) |
| Col H (Date) | `shift_date` |
| Cols I–K | combined into `acting_note` |

**Leave Records sheet → `leave_records` table**

| Sheet column | Target column |
|---|---|
| Col C (Emp No) | `employee_id` (lookup via `emp_number`) |
| Col H (Status) | `leave_type` |
| Col I (Date) | `shift_date` |
| Col J (End Date) | used to confirm the span stays within the shift window |
| Col K (Start) | `span_start` |
| Col L (End) | `span_end` |
| Col P (Status) | `status` |

### Normalization rules

- `'Un Active'` → `status = 'Inactive'`.
- `station_override`: set only when the employee's Col B value does not
  match `companies.station` for their `company_code`.
- All times normalized to `HH:MM` 24-hour format.
- Employee numbers: strip leading zeros, cast to `INTEGER`.

### Import method — two options

**Option A: Supabase CSV importer.** Dashboard → Table Editor → Import CSV.
Export each sheet as CSV and upload **in dependency order**:
`companies` → `employees` → `rotation_schedule` → `duty_ledger` →
`leave_records`.

**Option B: One-time Node.js migration script.**
`scripts/migrate.ts` in this repo:

1. Reads each CSV from `./data/` (one file per sheet, matching the mapping
   above).
2. Transforms columns per the mapping and normalization rules.
3. Inserts in batches of 500 via `supabaseAdmin`, in dependency order.
4. Logs a row count per table and any row-level errors.

Run it with:

```bash
npm run build
node dist/scripts/migrate.js
```

(Requires `.env` populated with `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`, and the CSV exports placed in `ebc-crm-api/data/`.)

## Section 3 — Cutover sequence

No step may be skipped.

1. Deploy `ebc-crm-api` to a Railway staging service.
2. Deploy `ebc-crm-web` to a Vercel preview URL, pointed at the staging API.
3. Import all data (Section 2). Verify row counts match the Google Sheets
   source exactly, table by table.
4. Run the rotation verification script (Section 4). It must exit 0.
5. Parallel run for exactly one 14-day pay period — both the legacy sheet
   and the new system must produce **identical** payroll figures for that
   period.
6. Get supervisor sign-off on the parallel-run outputs in writing.
7. Switch DNS / share the Vercel production URL as the new primary system.
8. **Cutover must complete before 12/30/2026** — the legacy lookup formulas
   expire on that date.
9. Decommission: delete the Google Apps Script triggers, archive the sheets
   (do not delete — keep as an audit reference).

## Section 4 — Rotation verification script

`scripts/verifyRotation.ts` checks every date from 2026-01-01 through
2026-12-30 against the official 15-day platoon cycle documented in
`data/Jefferson_Parish_Fire_Corrected_Master_Schedule_1990-2075.md`: each
platoon is on duty on cycle days 1, 3, 5, 7, 9 (five 24-hour shifts) and off
on cycle days 10-15, with anchors `2025-01-03` (A), `2025-01-08` (B), and
`2025-01-13` (C). Prints `PASS`/`FAIL` per date and exits with code 1 if any
date fails.

```bash
npm run build
node dist/scripts/verifyRotation.js
```

## Section 5 — Post-launch monitoring

- **Railway**: memory < 512 MB, p95 response time < 500 ms, error rate < 1%.
  Add a Railway uptime check on `GET /api/health`.
- **Supabase**: DB size (free tier limit 500 MB), connection pool < 90%,
  watch the slow-query log.
- **Vercel**: Core Web Vitals — LCP < 2.5s, CLS < 0.1, FID < 100ms.

## Section 6 — "Deployed, but every metric shows 0"

This means the schema exists but the operational data hasn't been
generated yet — not that the roster is fake. Work through these in order;
each one is a genuinely separate cause, so check all of them rather than
stopping at the first fix.

1. **Confirm the real roster is actually in the live database.** `schema.sql`
   and `supabase/migrations/2026-07-16_seed_real_roster.sql` both already
   seed the real JPFD roster (A/B/C platoons, emp_number 3001+) — but only
   if one of those was actually run against *this* Supabase project. If the
   project was bootstrapped from an older copy of `schema.sql` before the
   real roster was folded in, `employees` may still hold only the original
   12-row placeholder seed (`emp_number` 1001-1012). Check in the Supabase
   SQL Editor:
   ```sql
   select count(*) from employees where emp_number between 1001 and 1012;
   select count(*) from employees where emp_number >= 3001;
   ```
   If the first query returns rows and the second doesn't, run
   `2026-07-16_seed_real_roster.sql` (it's additive/idempotent — safe to run
   even if partially applied). Do **not** delete the 1001-1012 rows until
   you've confirmed no `duty_ledger` / `payroll_rows` / `timesheet_segments`
   / `shift_close` history references them — the commented-out block at the
   bottom of that migration has the exact deactivate/delete statements once
   that's confirmed; it's left commented deliberately.

2. **Generate the duty ledger.** `duty_ledger` is never populated
   automatically unless `auto_generate_duty_ledger` is set to `'true'` in
   `settings` *and* the `POST /api/jobs/generate-duty-ledger` cron endpoint
   is actually scheduled against this deployment (Railway cron, or
   equivalent, hitting it daily with `X-Cron-Secret`). Otherwise it only
   ever runs on demand:
   - UI: Settings → Duty Board Config → "Generate Ledger for Date", or the
     "Generate Duty Ledger" banner on Duty Board / Workforce Report when
     on-duty shows 0 (supervisor/admin only).
   - API: `POST /api/duty-ledger/generate` with `{ "date": "YYYY-MM-DD" }`.
   Only dates covered by `rotation_schedule` will work (currently seeded
   2026-07-01 through 2026-12-31 — check `Settings → Duty Board Config →
   Rotation data range` for the live range). Generate each date you need
   individually; it only creates rows for the platoon actually on duty that
   day, which is why "generate for A platoon on date X" only makes sense
   for dates where A is really on duty per the 15-day cycle.

3. **Generate payroll.** Payroll is derived from the duty ledger, so it must
   come after step 2 for the same date: `POST /api/payroll/date/YYYY-MM-DD/generate`.

4. **Assign roles.** A brand-new deployment has zero rows in `roles`, so
   nobody can reach supervisor/admin-gated screens (including the ones
   needed for steps 2-3 above). The first login with no role assigned is
   redirected to `/setup`, where "I am the Admin — Set Up My Account" calls
   `POST /api/admin/setup-first-admin` and grants that account admin +
   supervisor. From there, use Settings → User Roles to assign roles to
   everyone else.
