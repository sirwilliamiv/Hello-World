-- pay.invoices 1.0.0 — 20260701_create_pay_invoices (down)
-- Reverse dependency order. A major bump without a working rollback fails
-- publication (ARCHITECTURE.md section 9.2).

DROP TABLE IF EXISTS credit_note;
DROP TABLE IF EXISTS receipt;
DROP TABLE IF EXISTS invoice_line;
DROP TABLE IF EXISTS invoice;
DROP TABLE IF EXISTS invoice_sequence;
