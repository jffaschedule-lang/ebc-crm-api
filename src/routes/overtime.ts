import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config';
import { verifyJWT } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { assertNoDbError } from '../utils/db';
import { ok } from '../utils/respond';
import { HttpError } from '../middleware/errorHandler';
import { otTierService } from '../services/otTierService';
import { auditService, actorTypeFromRoles } from '../services/auditService';

const router = Router();

router.use(verifyJWT);

const availabilitySchema = z.object({
  employee_id: z.string().uuid(),
  available_from: z.string(),
  available_through: z.string(),
  target_platoon: z.enum(['A', 'B', 'C']).optional(),
  ot_type: z.string().default('General'),
  excluded_dates: z.array(z.string()).optional(),
});

router.get(
  '/tier/:rank_group',
  asyncHandler(async (req, res) => {
    const data = await otTierService.getTierBoard(req.params.rank_group);
    ok(res, data);
  })
);

router.post(
  '/availability',
  asyncHandler(async (req, res) => {
    const body = availabilitySchema.parse(req.body);

    // Mirrors the ownership check on DELETE /availability/:id below. Without
    // this, any authenticated user could submit an employee_id that isn't
    // their own (the frontend form is expected to only ever send the
    // caller's own id, but the API must not rely on that).
    const isSupervisor = req.user!.roles.includes('supervisor') || req.user!.roles.includes('admin');
    if (!isSupervisor && body.employee_id !== req.user!.employeeId) {
      throw new HttpError(403, 'FORBIDDEN', 'Can only add your own OT availability');
    }

    const { data, error } = await supabaseAdmin
      .from('ot_availability')
      .insert({
        employee_id: body.employee_id,
        available_from: body.available_from,
        available_through: body.available_through,
        target_platoon: body.target_platoon ?? null,
        ot_type: body.ot_type,
        excluded_dates: body.excluded_dates ?? [],
      })
      .select('*')
      .single();
    assertNoDbError(error, 'POST /overtime/availability');

    await auditService.write({
      actorType: actorTypeFromRoles(req.user!.roles),
      actorId: req.user!.employeeId ?? undefined,
      action: 'ot.availability.create',
      entryId: data.id,
      detail: `Availability ${body.available_from} → ${body.available_through}`,
    });

    ok(res, data, undefined, 201);
  })
);

router.delete(
  '/availability/:id',
  asyncHandler(async (req, res) => {
    const { data: existing, error: fetchError } = await supabaseAdmin
      .from('ot_availability')
      .select('employee_id')
      .eq('id', req.params.id)
      .single();
    assertNoDbError(fetchError, 'DELETE /overtime/availability fetch');

    if (existing?.employee_id !== req.user!.employeeId) {
      throw new HttpError(403, 'FORBIDDEN', 'Can only delete your own availability record');
    }

    const { error } = await supabaseAdmin.from('ot_availability').delete().eq('id', req.params.id);
    assertNoDbError(error, 'DELETE /overtime/availability');

    await auditService.write({
      actorType: actorTypeFromRoles(req.user!.roles),
      actorId: req.user!.employeeId ?? undefined,
      action: 'ot.availability.delete',
      entryId: req.params.id,
      detail: 'Removed OT availability record',
    });

    ok(res, { id: req.params.id });
  })
);

router.get(
  '/requests',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('ot_requests')
      .select('*')
      .order('shift_date', { ascending: false });
    assertNoDbError(error, 'GET /overtime/requests');
    ok(res, data ?? []);
  })
);

export default router;
