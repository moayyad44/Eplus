-- Bank reconciliation only marks lines (reconciledAt / reconId); that is allowed even in a closed period.
-- Any other change to a line in a closed period is still refused.
CREATE OR REPLACE FUNCTION acc_guard_line() RETURNS trigger AS $$
DECLARE st "JournalStatus"; d DATE; eid TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'reconciledAt' - 'reconId') = (to_jsonb(OLD) - 'reconciledAt' - 'reconId') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN eid := OLD."entryId"; ELSE eid := NEW."entryId"; END IF;
  IF TG_OP <> 'DELETE' THEN
    IF (SELECT "isGroup" FROM acc_accounts WHERE id = NEW."accountId") THEN
      RAISE EXCEPTION 'ACC_GROUP_ACCOUNT: entries go to sub-accounts, not to a group account';
    END IF;
  END IF;
  SELECT status, date INTO st, d FROM acc_journal_entries WHERE id = eid;
  IF st IS NOT NULL AND st <> 'DRAFT' AND acc_period_status(d) = 'CLOSED' THEN RAISE EXCEPTION 'ACC_PERIOD_CLOSED: %', d; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
