import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

process.env.SUPABASE_URL = process.env.SUPABASE_URL_TEST ?? process.env.SUPABASE_URL;

let app: import('express').Express;
let authToken: string;

/**
 * Regression coverage for the PostgREST "more than one relationship was
 * found for 'leave_records' and 'employees'" ambiguous-embed error.
 *
 * leave_records has two foreign keys to employees (employee_id and
 * supervisor_id), so every `.select('*, employees(...)')` embed on that
 * table must disambiguate with the actual FK constraint name
 * (leave_records_employee_id_fkey) or PostgREST 500s. Run against a real
 * Supabase/PostgREST project — set SUPABASE_URL_TEST,
 * SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, and TEST_USER_JWT before
 * `npm test` (see tests/integration/leaveFlow.test.ts for the same
 * requirement). This is a PostgREST-layer error, not a raw-SQL one, so it
 * cannot be reproduced against Postgres alone.
 */
describe('leave_records ambiguous-embed regression', () => {
  beforeAll(async () => {
    app = (await import('../../src/index')).default;
    authToken = process.env.TEST_USER_JWT ?? '';
  });

  it('GET /api/leave-records returns 200, not the PostgREST ambiguous-embed 500', async () => {
    const res = await request(app)
      .get('/api/leave-records')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).not.toBe(500);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /api/leave-records?platoon=A resolves the embedded employees.platoon filter', async () => {
    // Exercises .eq('employees.platoon', 'A') against the disambiguated
    // embed — if the FK hint broke the `employees` alias, this filter
    // (not just the plain list) is what would fail.
    const res = await request(app)
      .get('/api/leave-records')
      .query({ platoon: 'A' })
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).not.toBe(500);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('GET /api/leave/slots/A/2026-07-21 (alSlotService) does not 500', async () => {
    // al_slot_ledger itself has no employees embed, but rebuildSlotLedger's
    // ambiguous embed (fixed in alSlotService.ts) runs whenever a leave
    // record transitions to Granted — this at least confirms the read side
    // is healthy. The write-triggered path is covered by leaveFlow.test.ts's
    // "PATCH /:id/status Cancelled promotes ... via FIFO" test, which
    // exercises fifoService.checkAndPromoteWaitlist -> alSlotService
    // .checkSlotFit / .rebuildSlotLedger end to end.
    const res = await request(app)
      .get('/api/leave/slots/A/2026-07-21')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).not.toBe(500);
    expect(res.status).toBe(200);
  });
});
