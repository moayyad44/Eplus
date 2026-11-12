/**
 * Clinic stock & price list (from the clinic's «كشف المخزون» sheet, 2026-10).
 * price: the patient price in JD; 0 = consumable not billed on its own (stock only);
 * null = billed but the price was not given (service created with an editable price).
 */
export type StockRow = [sku: string, name: string, price: number | null, category: string, unit: string];

export const INV_CATEGORIES = {
  meds: 'أدوية حقن',
  fluids: 'محاليل وريدية',
  sutures: 'خيوط جراحية',
  dressings: 'ضمادات وعناية بالجروح',
  casts: 'جبائر وتجبير',
  syringes: 'حقن وإبر',
  iv: 'مستلزمات وريدية وقسطرة',
  resp: 'مستلزمات تنفس',
  ppe: 'مستلزمات وقاية',
  exam: 'أدوات فحص وجراحة صغرى',
} as const;
const C = INV_CATEGORIES;

export const STOCK_ITEMS: StockRow[] = [
  // Injectable medications
  ['INV-001', 'Lincomycin', 5, C.meds, 'أمبولة'],
  ['INV-002', 'LASIX 20 mg', 5, C.meds, 'أمبولة'],
  ['INV-003', 'Onda 8mg', 5, C.meds, 'أمبولة'],
  ['INV-004', 'Nexium 40 mg', 5, C.meds, 'أمبولة'],
  ['INV-005', 'Feromax', null, C.meds, 'أمبولة'],
  ['INV-006', 'B12', 5, C.meds, 'أمبولة'],
  ['INV-007', 'A.T.S', null, C.meds, 'أمبولة'],
  ['INV-008', 'Diprofos', null, C.meds, 'أمبولة'],
  ['INV-009', 'Ferinject', null, C.meds, 'أمبولة'],
  // IV fluids
  ['INV-010', 'N/S 0.9 500ML', null, C.fluids, 'كيس'],
  ['INV-011', 'D5 Glucose', null, C.fluids, 'كيس'],
  ['INV-012', 'Ringer lactate', null, C.fluids, 'كيس'],
  // Sutures
  ['INV-013', 'Proline 0-1', 0, C.sutures, 'قطعة'],
  ['INV-014', 'Proline 0-2', 0, C.sutures, 'قطعة'],
  ['INV-015', 'Proline 0-3', 0, C.sutures, 'قطعة'],
  ['INV-016', 'Proline 0-4', 0, C.sutures, 'قطعة'],
  ['INV-017', 'Proline 0-5', 0, C.sutures, 'قطعة'],
  ['INV-018', 'Proline 0-6', 0, C.sutures, 'قطعة'],
  ['INV-019', 'Vicryl 0-1', 0, C.sutures, 'قطعة'],
  ['INV-020', 'Vicryl 0-2', 0, C.sutures, 'قطعة'],
  ['INV-021', 'Vicryl 0-3', 0, C.sutures, 'قطعة'],
  ['INV-022', 'Vicryl 0-4', 0, C.sutures, 'قطعة'],
  ['INV-023', 'Vicryl 0-5', 0, C.sutures, 'قطعة'],
  ['INV-024', 'Vicryl 0-6', 0, C.sutures, 'قطعة'],
  // Dressings & wound care
  ['INV-025', 'Steri-Strip', null, C.dressings, 'قطعة'],
  ['INV-026', 'Gauze 4*4', 1, C.dressings, 'قطعة'],
  ['INV-027', 'Gauze 2*2', 1, C.dressings, 'قطعة'],
  ['INV-028', 'Mefix 5x10', 1, C.dressings, 'رول'],
  ['INV-029', 'Gauze bandage', 1, C.dressings, 'قطعة'],
  ['INV-030', 'Crep bandage 3', 1, C.dressings, 'قطعة'],
  ['INV-031', 'Crep bandage 4', 0, C.dressings, 'قطعة'],
  ['INV-032', 'Crep bandage 6', 0, C.dressings, 'قطعة'],
  ['INV-033', 'Band aid', 1, C.dressings, 'قطعة'],
  ['INV-034', 'Ialuset batch', 0, C.dressings, 'قطعة'],
  ['INV-035', 'Ialuset cream', 0, C.dressings, 'قطعة'],
  // Casting & splinting
  ['INV-036', 'Soft band 4', 0, C.casts, 'رول'],
  ['INV-037', 'Soft band 6', 0, C.casts, 'رول'],
  ['INV-038', 'Soft band 8', 0, C.casts, 'رول'],
  ['INV-039', 'Dyna Cast', 0, C.casts, 'رول'],
  ['INV-040', 'Jepsona 3', 0, C.casts, 'رول'],
  ['INV-041', 'Jepsona 4', null, C.casts, 'رول'],
  ['INV-042', 'Jepsona 6', 10, C.casts, 'رول'],
  ['INV-043', 'Jepsona 8', null, C.casts, 'رول'],
  // Syringes & needles
  ['INV-044', 'Free needle', 0, C.syringes, 'قطعة'],
  ['INV-045', 'Syringe insulin', 0, C.syringes, 'قطعة'],
  ['INV-046', 'Syringe 1 cc', 0, C.syringes, 'قطعة'],
  ['INV-047', 'Syringe 3 cc', 0, C.syringes, 'قطعة'],
  ['INV-048', 'Syringe 5 cc', 0, C.syringes, 'قطعة'],
  ['INV-049', 'Syringe 10 cc', 0, C.syringes, 'قطعة'],
  ['INV-050', 'Syringe 20 cc', 0, C.syringes, 'قطعة'],
  ['INV-051', 'Salem syringe', 0, C.syringes, 'قطعة'],
  // IV access & catheters
  ['INV-052', 'Canula', 1, C.iv, 'قطعة'],
  ['INV-053', 'I V set', 0, C.iv, 'قطعة'],
  ['INV-054', 'Micro dropper', 0, C.iv, 'قطعة'],
  ['INV-055', 'Foleys silicon', 0, C.iv, 'قطعة'],
  ['INV-056', 'Urine bag', 5, C.iv, 'قطعة'],
  // Respiratory
  ['INV-057', 'Nebulizer Kit Adult', 5, C.resp, 'قطعة'],
  ['INV-058', 'Nebulizer Kit Peds', 5, C.resp, 'قطعة'],
  // Protective & general consumables
  ['INV-059', 'Latex gloves', 1, C.ppe, 'زوج'],
  ['INV-060', 'Nylon gloves', 1, C.ppe, 'زوج'],
  ['INV-061', 'Sterile gloves', 1, C.ppe, 'زوج'],
  ['INV-062', 'Face mask', 2.5, C.ppe, 'قطعة'],
  ['INV-063', 'Alcohol swab', 0, C.ppe, 'قطعة'],
  ['INV-064', 'Draw sheet', 0, C.ppe, 'قطعة'],
  // Examination & minor surgery tools
  ['INV-065', 'Prob cover', 0, C.exam, 'قطعة'],
  ['INV-066', 'Ear piece', 0, C.exam, 'قطعة'],
  ['INV-067', 'Tongue depressor', 0, C.exam, 'قطعة'],
  ['INV-068', 'Surgical blade', 0, C.exam, 'قطعة'],
];

/** Rows of the sheet that are services, not stock. Urinalysis is already in the lab catalog (L083); Vital Signs (0 JD) is part of the visit. */
export const SHEET_SERVICES: [code: string, name: string, price: number | null, category: 'PROCEDURE' | 'NURSING' | 'CONSULTATION' | 'LAB'][] = [
  ['SRV-ECG', 'E.C.G تخطيط قلب', 20, 'PROCEDURE'],
  ['SRV-GLUCO', 'Gluco check فحص سكر', 2, 'NURSING'],
  ['SRV-DR-ORTHO', 'DR-Fees Ortho كشفية عظام', null, 'CONSULTATION'],
  ['SRV-DR-GYNA', 'DR-Gyna كشفية نسائية', null, 'CONSULTATION'],
  ['SRV-LAB', 'Lab Test تحليل مخبري', null, 'LAB'],
];
