-- The payment a refund would be issued against.
--
-- `decideRefund` requires exactly one of a payment intent or a charge -- Stripe will not
-- refund "a subscription", only a specific payment. We never stored either, so the owner
-- panel's refund control called `requestRefund` and then `decideRefund` and could never
-- get past the second: every attempt returned REFUND_TARGET_REQUIRED and left an orphan
-- `queued_for_owner` row that the owner's own control could not then action.
--
-- Found by the independent auditor on 20 September 2026. No test caught it because the
-- owner port had no injectable transport, so no test could reach the branch at all.
--
-- `invoice.paid` carries the payment intent for the payment that just succeeded, which is
-- the moment we genuinely learn it. Recorded per subscription and overwritten each period,
-- so it names the MOST RECENT paid period and nothing older. That is a real limitation and
-- it is why `issueRefund` refuses rather than guessing when the order it was asked to
-- refund is not the one this payment covers.
ALTER TABLE subscriptions ADD COLUMN latest_payment_intent_id TEXT;

-- The period that payment covered, so a refund cannot be aimed at a payment for a
-- different period by accident.
ALTER TABLE subscriptions ADD COLUMN latest_payment_period_end TEXT;
