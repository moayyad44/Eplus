-- Audit logs are append-only: no application user may modify or delete them.
CREATE OR REPLACE FUNCTION audit_logs_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (% is not allowed)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();

CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_block_mutation();

-- Inventory quantity must never become negative.
ALTER TABLE "inventory_items" ADD CONSTRAINT inventory_items_quantity_non_negative CHECK ("quantity" >= 0);
-- Invoice amounts sanity checks.
ALTER TABLE "invoices" ADD CONSTRAINT invoices_amounts_non_negative CHECK ("total" >= 0 AND "paidAmount" >= 0 AND "balance" >= 0);
ALTER TABLE "payments" ADD CONSTRAINT payments_amount_positive CHECK ("amount" > 0);
