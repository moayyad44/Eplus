import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../../lib/prisma';
import { ah } from '../../lib/http';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { requirePerm } from '../../middleware/auth';
import { pdfLines } from './pdfText';
import { matchToOrder, parseHeader, parseResults, shortName } from './labPdf';

/** Reads the referral lab's result PDF for an order and proposes the results. Nothing is saved: the screen fills the boxes for review. */
export const labFileRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

// Arabic names compared loosely: no diacritics, one form of alef / ya / ta marbuta, no spaces in "عبد ال…".
const norm = (s: string) => s.normalize('NFKC').replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

labFileRouter.post('/orders/:id/read-file', requirePerm('lab.process'), upload.single('file'), ah(async (req, res) => {
  if (!req.file) throw badRequest('اختر ملف النتائج');
  if (!/\.pdf$/i.test(req.file.originalname) && req.file.mimetype !== 'application/pdf') throw badRequest('الملف يجب أن يكون PDF من برنامج المختبر');
  const o = await prisma.labOrder.findUnique({ where: { id: req.params.id }, include: { patient: { select: { fullName: true } }, items: { include: { labTest: { select: { code: true, parameters: true } } } } } });
  if (!o) throw notFound();
  if (o.status === 'CANCELLED') throw badRequest('الطلب ملغى');
  let lines;
  try { lines = await pdfLines(req.file.buffer); } catch { throw badRequest('تعذّرت قراءة الملف. تأكد أنه PDF سليم'); }
  if (!lines.some((l) => /\d/.test(l.text))) throw badRequest('لا يوجد نص في الملف (قد يكون صورة ممسوحة ضوئياً). أدخل النتائج يدوياً');
  const header = parseHeader(lines);
  const results = parseResults(lines);
  if (!results.length) throw badRequest('لم يُعثر على نتائج في الملف. تأكد أنه تقرير نتائج من المختبر');
  const proposal = matchToOrder(results, o.items.map((it) => ({ id: it.id, testName: it.testName, code: it.labTest.code, parameters: (Array.isArray(it.labTest.parameters) ? it.labTest.parameters : []) as { name: string }[] })));
  // Is it this patient's report?
  let patientCheck: 'match' | 'mismatch' | 'unknown' = 'unknown';
  if (header.patientName) {
    const a = norm(header.patientName).split(' '), b = norm(o.patient.fullName);
    const hits = a.filter((w) => w.length > 1 && b.includes(w)).length;
    patientCheck = hits >= Math.min(2, a.length) ? 'match' : 'mismatch';
  }
  await audit(prisma, req.ctx, { action: 'lab_result.read_file', entityType: 'lab_order', entityId: o.id, summary: `قراءة ملف نتائج «${req.file.originalname}» لـ ${o.orderNumber}: ${results.length} نتيجة` });
  res.json({ header, patientCheck, orderPatient: o.patient.fullName, found: results.length, ...proposal, unassigned: proposal.unassigned.map((u) => ({ ...u, short: shortName(u.name) })) });
}));
