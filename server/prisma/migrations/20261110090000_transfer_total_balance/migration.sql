-- A transfer between warehouses does not change an item's total, but the "total after" written on the
-- transfer-out half showed the total in the middle of the transfer (lowered by the quantity moved).
-- Corrects that column only; quantities and warehouse balances are untouched.
UPDATE "inventory_transactions" SET "balanceAfter" = "balanceAfter" - "quantity" WHERE "type" = 'TRANSFER_OUT';
