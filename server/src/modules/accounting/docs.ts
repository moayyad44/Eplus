import type { Db } from '../../lib/prisma';
import { D } from '../../lib/money';
import { dateOnlyStr } from '../../lib/dates';
import { L, nonZero, type DocKind, type Mapping, type Plan } from './link';
import type { LineInput } from './journal';

/** What each accounting document looks like in the books (rebuilt from its current state). */
export async function planDoc(db: Db, kind: DocKind, id: string, m: Mapping): Promise<Plan> {
  const tAcc = async (treasuryId: string | null | undefined) => {
    if (!treasuryId) throw new Error('اختر الصندوق أو الحساب البنكي');
    const t = await db.treasury.findUnique({ where: { id: treasuryId } });
    if (!t) throw new Error('الصندوق أو الحساب البنكي غير موجود');
    return t.accountId;
  };
  switch (kind) {
    case 'voucher': {
      const v = await db.voucher.findUnique({ where: { id } });
      if (!v || v.status === 'CANCELLED') return { do: 'undo', why: 'سند ملغى' };
      const party = { partyType: v.partyType, partyId: v.partyId, partyName: v.partyName };
      const money = v.method === 'VISA' ? m.role('VISA_CLEARING')
        : v.method === 'CHEQUE' ? m.role(v.kind === 'RECEIPT' ? 'CHEQUES_ON_HAND' : 'CHEQUES_ISSUED')
        : await tAcc(v.treasuryId);
      const lines = v.kind === 'RECEIPT'
        ? [L(money, v.amount, 0, { description: v.purpose }), L(v.counterAccountId, 0, v.amount, { ...party, description: v.purpose })]
        : [L(v.counterAccountId, v.amount, 0, { ...party, description: v.purpose }), L(money, 0, v.amount, { description: v.purpose })];
      return { do: 'post', date: dateOnlyStr(v.date), type: v.kind === 'RECEIPT' ? 'RECEIPT' : 'PAYMENT', description: `${v.kind === 'RECEIPT' ? 'سند قبض' : 'سند صرف'} ${v.number} — ${v.partyName}: ${v.purpose}`, reference: v.number, lines };
    }
    case 'transfer': {
      const t = await db.treasuryTransfer.findUnique({ where: { id } });
      if (!t || t.status === 'CANCELLED') return { do: 'undo', why: 'تحويل ملغى' };
      const [from, to] = await Promise.all([tAcc(t.fromId), tAcc(t.toId)]);
      return {
        do: 'post', date: dateOnlyStr(t.date), type: 'GENERAL', description: `تحويل ${t.number}${t.notes ? ` — ${t.notes}` : ''}`, reference: t.reference ?? t.number,
        lines: nonZero([L(to, t.amount, 0), L(m.role('BANK_CHARGES'), t.fee, 0, { description: 'عمولة التحويل' }), L(from, 0, D(t.amount).add(t.fee))]),
      };
    }
    case 'cash-count': {
      const c = await db.cashCount.findUnique({ where: { id } });
      if (!c || c.status !== 'APPROVED' || D(c.difference).eq(0)) return { do: 'skip', note: 'لا فرق معتمد' };
      const cash = await tAcc(c.treasuryId);
      const diff = D(c.difference);
      const lines = diff.gt(0) ? [L(cash, diff, 0), L(m.role('COUNT_DIFFERENCES'), 0, diff, { description: 'زيادة صندوق' })] : [L(m.role('COUNT_DIFFERENCES'), diff.abs(), 0, { description: 'عجز صندوق' }), L(cash, 0, diff.abs())];
      return { do: 'post', date: dateOnlyStr(c.date), type: 'ADJUSTMENT', description: `تسوية جرد الصندوق ${c.number}: ${c.reason ?? ''}`, reference: c.number, lines };
    }
    case 'visa-settlement': {
      const s = await db.visaSettlement.findUnique({ where: { id } });
      if (!s || s.status === 'CANCELLED') return { do: 'undo', why: 'تسوية ملغاة' };
      return {
        do: 'post', date: dateOnlyStr(s.date), type: 'BANK_RECONCILIATION', description: `تسوية فيزا ${s.number}: إجمالي ${D(s.gross).toFixed(3)} − عمولة ${D(s.fee).toFixed(3)}`, reference: s.reference ?? s.number,
        lines: nonZero([L(await tAcc(s.treasuryId), s.net, 0), L(m.role('VISA_FEES'), s.fee, 0, { description: 'عمولة الفيزا' }), L(m.role('VISA_CLEARING'), 0, s.gross)]),
      };
    }
    case 'cheque-event': {
      const ev = await db.chequeEvent.findUnique({ where: { id }, include: { cheque: true } });
      if (!ev) return { do: 'undo', why: 'حركة غير موجودة' };
      const c = ev.cheque;
      const from = ev.fromStatus, to = ev.toStatus;
      const party = { partyName: c.counterparty };
      const amt = c.amount;
      const date = dateOnlyStr(ev.date);
      const desc = (s: string) => `شيك ${c.direction === 'IN' ? 'وارد' : 'صادر'} ${c.number} (${c.bankName}) — ${s}`;
      let lines: LineInput[] = [];
      let title = '';
      if (c.direction === 'IN') {
        const where = from === 'UNDER_COLLECTION' || from === 'DEPOSITED' ? m.role('CHEQUES_UNDER_COLLECTION') : from === 'COLLECTED' ? await tAcc(c.treasuryId) : m.role('CHEQUES_ON_HAND');
        if (to === 'UNDER_COLLECTION' || to === 'DEPOSITED') { if (from === 'UNDER_COLLECTION' || from === 'DEPOSITED') return { do: 'skip', note: 'لا أثر' }; title = 'إيداع للتحصيل'; lines = [L(m.role('CHEQUES_UNDER_COLLECTION'), amt, 0), L(m.role('CHEQUES_ON_HAND'), 0, amt)]; }
        else if (to === 'COLLECTED') { title = 'تحصيل'; lines = [L(await tAcc(ev.treasuryId ?? c.treasuryId), amt, 0), L(where, 0, amt)]; }
        else if (to === 'BOUNCED') { title = 'ارتجاع'; lines = [L(m.role('AR_OTHER'), amt, 0, party), L(where, 0, amt)]; if (D(ev.fee).gt(0)) lines.push(L(m.role('BANK_CHARGES'), ev.fee, 0, { description: 'رسوم شيك مرتجع' }), L(await tAcc(ev.treasuryId ?? c.treasuryId), 0, ev.fee)); }
        else if (['CANCELLED', 'RETURNED_TO_OWNER', 'REPLACED'].includes(to)) {
          if (from === 'BOUNCED') return { do: 'skip', note: 'الذمة مثبتة عند الارتجاع' };
          title = to === 'REPLACED' ? 'استبدال' : to === 'CANCELLED' ? 'إلغاء' : 'إرجاع لصاحبه';
          lines = [L(to === 'REPLACED' ? m.role('AR_OTHER') : c.counterAccountId, amt, 0, party), L(where, 0, amt)];
        } else return { do: 'skip', note: 'تغيير حالة بلا أثر مالي' };
      } else {
        if (to === 'CLEARED') { title = 'صرف من البنك'; lines = [L(m.role('CHEQUES_ISSUED'), amt, 0), L(await tAcc(c.treasuryId), 0, amt)]; }
        else if (['CANCELLED', 'STOPPED', 'BOUNCED', 'REPLACED'].includes(to)) { title = to === 'STOPPED' ? 'إيقاف' : to === 'REPLACED' ? 'استبدال' : 'إلغاء'; lines = [L(m.role('CHEQUES_ISSUED'), amt, 0), L(c.counterAccountId, 0, amt, party)]; }
        else return { do: 'skip', note: 'تغيير حالة بلا أثر مالي' };
      }
      return { do: 'post', date, type: 'CHEQUE', description: desc(title), reference: c.ref, lines };
    }
    case 'advance': {
      const a = await db.employeeAdvance.findUnique({ where: { id } });
      if (!a || a.status === 'CANCELLED') return { do: 'undo', why: 'سلفة ملغاة' };
      const u = await db.user.findUnique({ where: { id: a.userId }, select: { fullName: true } });
      const party = { partyType: 'EMPLOYEE', partyId: a.userId, partyName: u?.fullName ?? null };
      return { do: 'post', date: dateOnlyStr(a.date), type: 'PAYROLL', description: `سلفة ${a.number} — ${u?.fullName ?? ''}`, reference: a.number, lines: [L(m.role('EMPLOYEE_ADVANCES'), a.amount, 0, party), L(await tAcc(a.treasuryId), 0, a.amount)] };
    }
    case 'payroll': {
      const r = await db.payrollRun.findUnique({ where: { id }, include: { slips: true } });
      if (!r || r.status === 'DRAFT') return { do: 'undo', why: 'كشف رواتب غير معتمد' };
      const sum = (k: 'basic' | 'allowances' | 'commission' | 'bonus' | 'overtime' | 'absenceDeduction' | 'deductions' | 'advance' | 'net') => r.slips.reduce((t, s) => t.add(s[k]), D(0));
      const expense = sum('basic').add(sum('allowances')).add(sum('commission')).add(sum('bonus')).add(sum('overtime')).sub(sum('absenceDeduction')).sub(sum('deductions'));
      return {
        do: 'post', date: r.dueDate ? dateOnlyStr(r.dueDate) : `${r.month}-28`, type: 'PAYROLL', description: `رواتب شهر ${r.month}`, reference: `PAY-${r.month}`,
        lines: nonZero([L(m.role('SALARIES'), expense, 0), L(m.role('SALARIES_PAYABLE'), 0, sum('net')), L(m.role('EMPLOYEE_ADVANCES'), 0, sum('advance'), { description: 'استرداد سلف' })]),
      };
    }
    case 'payroll-pay': {
      const r = await db.payrollRun.findUnique({ where: { id }, include: { slips: true } });
      if (!r || r.status !== 'PAID' || !r.paidDate) return { do: 'undo', why: 'الرواتب غير مدفوعة' };
      const net = r.slips.reduce((t, s) => t.add(s.net), D(0));
      return { do: 'post', date: dateOnlyStr(r.paidDate), type: 'PAYROLL', description: `صرف رواتب شهر ${r.month}`, reference: `PAY-${r.month}`, lines: nonZero([L(m.role('SALARIES_PAYABLE'), net, 0), L(await tAcc(r.treasuryId), 0, net)]) };
    }
    case 'asset': {
      const a = await db.fixedAsset.findUnique({ where: { id } });
      if (!a) return { do: 'undo', why: 'أصل غير موجود' };
      return { do: 'post', date: dateOnlyStr(a.purchaseDate), type: 'PURCHASE', description: `شراء أصل ${a.code} — ${a.name}`, reference: a.code, lines: [L(a.accountId, a.cost, 0), L(a.fundingAccountId, 0, a.cost)] };
    }
    case 'depreciation': {
      const rows = await db.assetDepreciation.findMany({ where: { month: id } });
      const total = rows.reduce((t, r) => t.add(r.amount), D(0));
      if (total.eq(0)) return { do: 'undo', why: 'لا إهلاك' };
      const [y, mo] = id.split('-').map(Number);
      const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
      return { do: 'post', date: last, type: 'DEPRECIATION', description: `إهلاك الأصول الثابتة لشهر ${id} (${rows.length} أصل)`, reference: `DEP-${id}`, lines: [L(m.role('DEPRECIATION'), total, 0), L(m.role('ACCUM_DEPRECIATION'), 0, total)] };
    }
    case 'asset-disposal': {
      const a = await db.fixedAsset.findUnique({ where: { id }, include: { depreciations: true } });
      if (!a || a.status === 'ACTIVE' || !a.disposedAt) return { do: 'undo', why: 'الأصل غير مستبعد' };
      const acc = a.depreciations.reduce((t, r) => t.add(r.amount), D(0));
      const proceeds = D(a.proceeds);
      const result = proceeds.add(acc).sub(a.cost); // > 0 gain, < 0 loss
      return {
        do: 'post', date: dateOnlyStr(a.disposedAt), type: 'ADJUSTMENT', description: `${a.status === 'SOLD' ? 'بيع' : 'استبعاد'} الأصل ${a.code} — ${a.name}`, reference: a.code,
        lines: nonZero([
          L(m.role('ACCUM_DEPRECIATION'), acc, 0), L(a.proceedsAccountId ?? m.role('CASH_MAIN'), proceeds, 0),
          L(m.role('LOSS_ON_DISPOSAL'), result.lt(0) ? result.abs() : 0, 0, { description: 'خسارة استبعاد أصل' }),
          L(a.accountId, 0, a.cost), L(m.role('GAIN_ON_DISPOSAL'), 0, result.gt(0) ? result : 0, { description: 'ربح بيع أصل' }),
        ]),
      };
    }
    case 'year-close': {
      const y = await db.fiscalYear.findUnique({ where: { id } });
      if (!y || y.status !== 'CLOSED') return { do: 'undo', why: 'السنة غير مقفلة' };
      const rows = await db.$queryRaw<{ accountId: string; net: unknown }[]>`
        SELECT l."accountId", SUM(l.debit - l.credit) AS net FROM acc_journal_lines l JOIN acc_journal_entries e ON e.id = l."entryId" JOIN acc_accounts a ON a.id = l."accountId"
        WHERE e.status = 'POSTED' AND e.date BETWEEN ${y.startDate} AND ${y.endDate} AND a.type IN ('REVENUE','EXPENSE') AND COALESCE(e."sourceKey", '') <> ${`year-close:${id}`}
        GROUP BY l."accountId" HAVING SUM(l.debit - l.credit) <> 0`;
      const lines: LineInput[] = rows.map((r) => { const n = D(r.net as never); return n.gt(0) ? L(r.accountId, 0, n) : L(r.accountId, n.abs(), 0); });
      const result = rows.reduce((t, r) => t.add(D(r.net as never)), D(0)); // debit-positive: > 0 = loss
      lines.push(result.gt(0) ? L(m.role('RETAINED_EARNINGS'), result, 0, { description: 'خسارة السنة' }) : L(m.role('RETAINED_EARNINGS'), 0, result.abs(), { description: 'ربح السنة' }));
      const real = nonZero(lines);
      if (real.length < 2) return { do: 'skip', note: 'لا إيرادات ولا مصروفات للإقفال' };
      return { do: 'post', date: dateOnlyStr(y.endDate), type: 'CLOSING', description: `قيد إقفال ${y.name}: ترحيل نتيجة السنة للأرباح المحتجزة`, reference: y.name, lines: real };
    }
  }
}
