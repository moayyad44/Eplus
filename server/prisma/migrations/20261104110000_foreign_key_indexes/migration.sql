-- CreateIndex
CREATE INDEX "appointments_branchId_idx" ON "appointments"("branchId");

-- CreateIndex
CREATE INDEX "appointments_visitTypeId_idx" ON "appointments"("visitTypeId");

-- CreateIndex
CREATE INDEX "attachments_authorizationId_idx" ON "attachments"("authorizationId");

-- CreateIndex
CREATE INDEX "attachments_claimId_idx" ON "attachments"("claimId");

-- CreateIndex
CREATE INDEX "attachments_expenseId_idx" ON "attachments"("expenseId");

-- CreateIndex
CREATE INDEX "attachments_labOrderId_idx" ON "attachments"("labOrderId");

-- CreateIndex
CREATE INDEX "attachments_patientInsuranceId_idx" ON "attachments"("patientInsuranceId");

-- CreateIndex
CREATE INDEX "attendance_shiftAssignmentId_idx" ON "attendance"("shiftAssignmentId");

-- CreateIndex
CREATE INDEX "consultations_doctorId_idx" ON "consultations"("doctorId");

-- CreateIndex
CREATE INDEX "ecoin_lot_uses_txnId_idx" ON "ecoin_lot_uses"("txnId");

-- CreateIndex
CREATE INDEX "einvoices_originalId_idx" ON "einvoices"("originalId");

-- CreateIndex
CREATE INDEX "expenses_branchId_idx" ON "expenses"("branchId");

-- CreateIndex
CREATE INDEX "expenses_paymentMethodId_idx" ON "expenses"("paymentMethodId");

-- CreateIndex
CREATE INDEX "expenses_supplierId_idx" ON "expenses"("supplierId");

-- CreateIndex
CREATE INDEX "insurance_authorizations_companyId_idx" ON "insurance_authorizations"("companyId");

-- CreateIndex
CREATE INDEX "insurance_authorizations_contractId_idx" ON "insurance_authorizations"("contractId");

-- CreateIndex
CREATE INDEX "insurance_authorizations_patientInsuranceId_idx" ON "insurance_authorizations"("patientInsuranceId");

-- CreateIndex
CREATE INDEX "insurance_authorizations_serviceId_idx" ON "insurance_authorizations"("serviceId");

-- CreateIndex
CREATE INDEX "insurance_authorizations_visitId_idx" ON "insurance_authorizations"("visitId");

-- CreateIndex
CREATE INDEX "insurance_claim_events_allocationId_idx" ON "insurance_claim_events"("allocationId");

-- CreateIndex
CREATE INDEX "insurance_claim_items_invoiceItemId_idx" ON "insurance_claim_items"("invoiceItemId");

-- CreateIndex
CREATE INDEX "insurance_claim_items_serviceId_idx" ON "insurance_claim_items"("serviceId");

-- CreateIndex
CREATE INDEX "insurance_claims_contractId_idx" ON "insurance_claims"("contractId");

-- CreateIndex
CREATE INDEX "insurance_claims_patientInsuranceId_idx" ON "insurance_claims"("patientInsuranceId");

-- CreateIndex
CREATE INDEX "insurance_claims_visitId_idx" ON "insurance_claims"("visitId");

-- CreateIndex
CREATE INDEX "insurance_coverage_rules_serviceId_idx" ON "insurance_coverage_rules"("serviceId");

-- CreateIndex
CREATE INDEX "insurance_payments_methodId_idx" ON "insurance_payments"("methodId");

-- CreateIndex
CREATE INDEX "inventory_items_categoryId_idx" ON "inventory_items"("categoryId");

-- CreateIndex
CREATE INDEX "inventory_items_supplierId_idx" ON "inventory_items"("supplierId");

-- CreateIndex
CREATE INDEX "inventory_items_unitId_idx" ON "inventory_items"("unitId");

-- CreateIndex
CREATE INDEX "invoice_items_serviceId_idx" ON "invoice_items"("serviceId");

-- CreateIndex
CREATE INDEX "invoice_template_items_serviceId_idx" ON "invoice_template_items"("serviceId");

-- CreateIndex
CREATE INDEX "invoices_branchId_idx" ON "invoices"("branchId");

-- CreateIndex
CREATE INDEX "invoices_insuranceContractId_idx" ON "invoices"("insuranceContractId");

-- CreateIndex
CREATE INDEX "invoices_patientInsuranceId_idx" ON "invoices"("patientInsuranceId");

-- CreateIndex
CREATE INDEX "invoices_templateId_idx" ON "invoices"("templateId");

-- CreateIndex
CREATE INDEX "lab_order_items_labTestId_idx" ON "lab_order_items"("labTestId");

-- CreateIndex
CREATE INDEX "lab_orders_doctorId_idx" ON "lab_orders"("doctorId");

-- CreateIndex
CREATE INDEX "laboratory_tests_serviceId_idx" ON "laboratory_tests"("serviceId");

-- CreateIndex
CREATE INDEX "medical_reports_doctorId_idx" ON "medical_reports"("doctorId");

-- CreateIndex
CREATE INDEX "medical_reports_visitId_idx" ON "medical_reports"("visitId");

-- CreateIndex
CREATE INDEX "patient_insurances_contractId_idx" ON "patient_insurances"("contractId");

-- CreateIndex
CREATE INDEX "payments_patientId_idx" ON "payments"("patientId");

-- CreateIndex
CREATE INDEX "prescriptions_doctorId_idx" ON "prescriptions"("doctorId");

-- CreateIndex
CREATE INDEX "purchase_order_items_itemId_idx" ON "purchase_order_items"("itemId");

-- CreateIndex
CREATE INDEX "purchase_order_items_purchaseOrderId_idx" ON "purchase_order_items"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "role_permissions_permissionKey_idx" ON "role_permissions"("permissionKey");

-- CreateIndex
CREATE INDEX "services_inventoryItemId_idx" ON "services"("inventoryItemId");

-- CreateIndex
CREATE INDEX "shift_assignments_shiftId_idx" ON "shift_assignments"("shiftId");

-- CreateIndex
CREATE INDEX "stock_count_items_itemId_idx" ON "stock_count_items"("itemId");

-- CreateIndex
CREATE INDEX "stock_counts_warehouseId_idx" ON "stock_counts"("warehouseId");

-- CreateIndex
CREATE INDEX "stock_transfer_items_itemId_idx" ON "stock_transfer_items"("itemId");

-- CreateIndex
CREATE INDEX "stock_transfers_fromWarehouseId_idx" ON "stock_transfers"("fromWarehouseId");

-- CreateIndex
CREATE INDEX "stock_transfers_toWarehouseId_idx" ON "stock_transfers"("toWarehouseId");

-- CreateIndex
CREATE INDEX "supplier_payments_methodId_idx" ON "supplier_payments"("methodId");

-- CreateIndex
CREATE INDEX "supplier_payments_purchaseOrderId_idx" ON "supplier_payments"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "user_permission_overrides_permissionKey_idx" ON "user_permission_overrides"("permissionKey");

-- CreateIndex
CREATE INDEX "users_branchId_idx" ON "users"("branchId");

-- CreateIndex
CREATE INDEX "visits_branchId_idx" ON "visits"("branchId");

-- CreateIndex
CREATE INDEX "visits_patientInsuranceId_idx" ON "visits"("patientInsuranceId");

-- CreateIndex
CREATE INDEX "visits_visitTypeId_idx" ON "visits"("visitTypeId");

