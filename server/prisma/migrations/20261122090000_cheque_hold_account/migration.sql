-- Cheques still outstanding in the previous system, imported without an entry: the account their amount sits in.
ALTER TABLE "acc_cheques" ADD COLUMN "holdAccountId" TEXT;
