-- «Invoice without a visit»: everyone who can create invoices keeps doing so (existing installs; a fresh install gets it from bootstrap).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "roles") THEN
    INSERT INTO "permissions" ("key", "module", "description")
      VALUES ('invoices.without_visit', 'billing', 'إنشاء فاتورة بدون زيارة (بيع مباشر أو تصحيح) عند تفعيل «الفاتورة تحتاج زيارة»')
    ON CONFLICT ("key") DO NOTHING;
    INSERT INTO "role_permissions" ("roleId", "permissionKey")
      SELECT rp."roleId", 'invoices.without_visit' FROM "role_permissions" rp WHERE rp."permissionKey" = 'invoices.create'
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
