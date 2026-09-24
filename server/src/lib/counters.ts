import type { Db } from './prisma';

/** Atomically increments a named counter (row-level lock inside the current transaction). */
export async function nextCounter(db: Db, key: string): Promise<number> {
  const rows = await (db as any).$queryRaw<{ value: number }[]>`
    INSERT INTO "counters" ("key", "value") VALUES (${key}, 1)
    ON CONFLICT ("key") DO UPDATE SET "value" = "counters"."value" + 1
    RETURNING "value"`;
  return Number(rows[0].value);
}

export const pad = (n: number, width = 6) => String(n).padStart(width, '0');
