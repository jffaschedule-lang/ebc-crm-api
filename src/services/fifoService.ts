import { v4 as uuidv4 } from 'uuid';
import { supabaseAdmin } from '../config';
import { assertNoDbError } from '../utils/db';
import { alSlotService } from './alSlotService';
import { auditService } from './auditService';
import { LeaveRecord } from '../types';

export const fifoService = {
  /**
   * Promotes at most one waitlisted AL record per call, in strict
   * submitted_at ASC, id ASC order — never array index or row order.
   */
  async checkAndPromoteWaitlist(platoon: string, shiftDate: string): Promise<void> {
    const { data, error } = await supabaseAdmin
      .from('leave_records')
      .select('*, employees!leave_records_employee_id_fkey!inner(platoon)')
      .eq('shift_date', shiftDate)
      .eq('status', 'Waitlist')
      .eq('employees.platoon', platoon)
      .order('submitted_at', { ascending: true })
      .order('id', { ascending: true });

    assertNoDbError(error, 'checkAndPromoteWaitlist fetch waitlist');

    const waitlisted = (data ?? []) as LeaveRecord[];

    for (const record of waitlisted) {
      const fit = await alSlotService.checkSlotFit({
        platoon,
        shiftDate,
        newStart: record.span_start,
        newEnd: record.span_end,
        excludeId: record.id,
      });

      if (fit.fits) {
        const newEntryId = `LV${Date.now()}-${uuidv4().slice(0, 6)}`;

        const { error: markError } = await supabaseAdmin
          .from('leave_records')
          .update({ status: 'Promoted' })
          .eq('id', record.id);
        assertNoDbError(markError, 'checkAndPromoteWaitlist mark promoted');

        const { error: insertError } = await supabaseAdmin.from('leave_records').insert({
          entry_id: newEntryId,
          employee_id: record.employee_id,
          leave_type: record.leave_type,
          shift_date: record.shift_date,
          span_start: record.span_start,
          span_end: record.span_end,
          reason: record.reason,
          status: 'Granted',
          parent_id: record.id,
          supervisor_id: record.supervisor_id,
        });
        assertNoDbError(insertError, 'checkAndPromoteWaitlist insert granted');

        await alSlotService.rebuildSlotLedger(platoon, shiftDate);

        await auditService.write({
          actorType: 'system',
          action: 'leave.promote',
          entryId: newEntryId,
          detail: `Promoted from waitlist (was ${record.entry_id}) · ${record.leave_type} · ${shiftDate}`,
        });

        // Only promote one at a time per trigger.
        return;
      }
    }
  },
};
