import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config';
import { verifyJWT } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { assertNoDbError } from '../utils/db';
import { ok } from '../utils/respond';
import { HttpError } from '../middleware/errorHandler';
import { alSlotService } from '../services/alSlotService';
import { fifoService } from '../services/fifoService';
import { auditService, actorTypeFromRoles } from '../services/auditService';

const router = Router();

router.use(verifyJWT);

const listQuerySchema = z.object({
  shift_date: z.string().optional(),
  platoon: z.enum(['A', 'B', 'C']).optional(),
  status: z
    .enum(['PendingApproval', 'Granted', 'Active', 'Waitlist', 'Promoted', 'Cancelled', 'Deleted'])
    .optional(),
  employee_id: z.string().uuid().optional(),
});

const statusUpdateSchema = z.object({
  status: z.enum(['Granted', 'Cancelled', 'Deleted']),
  note: z.string().optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    let query = supabaseAdmin
      .from('leave_records')
      .select('*, employees!leave_records_employee_id_fkey!inner(platoon)');

    if (q.shift_date) query = query.eq('shift_date', q.shift_date);
    if (q.platoon) query = query.eq('employees.platoon', q.platoon);
    if (q.status) query = query.eq('status', q.status);
    if (q.employee_id) query = query.eq('employee_id', q.employee_id);

    const { data, error } = await query.order('submitted_at', { ascending: false });
    assertNoDbError(error, 'GET /leave-records');
    ok(res, data ?? []);
  })
);

router.get(
  '/slots/:platoon/:date',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('al_slot_ledger')
      .select('*')
      .eq('platoon', req.params.platoon)
      .eq('shift_date', req.params.date)
      .maybeSingle();
    assertNoDbError(error, 'GET /leave-records/slots/:platoon/:date');
    ok(res, data ?? { platoon: req.params.platoon, shift_date: req.params.date, peak_concurrent: 0, max_slots: 12 });
  })
);

router.patch(
  '/:id/status',
  asyncHandler(async (req, res, next) => {
    const body = statusUpdateSchema.parse(req.body);

    const { data: record, error: fetchError } = await supabaseAdmin
      .from('leave_records')
      .select('*, employees!leave_records_employee_id_fkey!inner(platoon)')
      .eq('id', req.params.id)
      .single();
    assertNoDbError(fetchError, 'PATCH /leave-records/:id/status fetch');
    if (!record) {
      throw new HttpError(404, 'LEAVE_RECORD_NOT_FOUND', 'Leave record not found');
    }

    const isOwner = record.employee_id === req.user!.employeeId;
    const isSupervisor = req.user!.roles.includes('supervisor') || req.user!.roles.includes('admin');

    if (!isSupervisor && !(isOwner && body.status === 'Deleted')) {
      return next(new HttpError(403, 'FORBIDDEN', 'Not permitted to change this record'));
    }

    const platoon = (record as any).employees.platoon;

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('leave_records')
      .update({ status: body.status })
      .eq('id', req.params.id)
      .select('*')
      .single();
    assertNoDbError(updateError, 'PATCH /leave-records/:id/status update');

    if (body.status === 'Cancelled' || body.status === 'Deleted') {
      await fifoService.checkAndPromoteWaitlist(platoon, record.shift_date);
    }
    if (body.status === 'Granted') {
      await alSlotService.rebuildSlotLedger(platoon, record.shift_date);
    }

    await auditService.write({
      actorType: actorTypeFromRoles(req.user!.roles),
      actorId: req.user!.employeeId ?? undefined,
      action: `leave.${body.status.toLowerCase()}`,
      entryId: record.entry_id,
      detail: body.note ?? `Status changed to ${body.status}`,
    });

    ok(res, updated);
  })
);

export default router;
