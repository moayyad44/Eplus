import { Prisma, PrismaClient } from '@prisma/client';

// Serialise Decimal columns as JSON numbers (all money/quantities fit safely in a double).
(Prisma.Decimal.prototype as unknown as { toJSON: () => number }).toJSON = function (this: Prisma.Decimal) {
  return this.toNumber();
};

export const prisma = new PrismaClient({
  log: process.env.PRISMA_LOG ? ['query', 'warn', 'error'] : ['warn', 'error'],
});

export type Tx = Prisma.TransactionClient;
export type Db = PrismaClient | Tx;
