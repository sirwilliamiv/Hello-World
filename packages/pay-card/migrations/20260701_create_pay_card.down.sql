-- pay.card 1.0.0 — 20260701_create_pay_card (down)
-- Dropped in reverse dependency order. A major bump without a working rollback
-- fails publication (ARCHITECTURE.md section 9.2).

DROP TABLE IF EXISTS refund;
DROP TABLE IF EXISTS charge;
DROP TABLE IF EXISTS payment_method;
