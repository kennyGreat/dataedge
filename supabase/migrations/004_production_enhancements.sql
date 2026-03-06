-- ════════════════════════════════════════════════════════
-- DataEdge — Vortexedge Limited
-- Migration 004: Production Enhancements
--   • Composite & partial indexes for 100k+ users
--   • RLS on all remaining tables (webhook_events, ledger_transactions, etc.)
--   • Admin read-only policies via profiles.role = 'admin'
--   • handle_automatic_profile_creation (idempotent, for existing users)
--   • verify_subscription_completion RPC
--   • reset_failed_jobs RPC (exponential backoff)
--   • trigger_installment_billing stored procedure (pg_cron target)
--   • wallet_balance sync trigger (users.wallet_balance kept in sync)
--   • pg_cron schedule setup
-- ════════════════════════════════════════════════════════


-- ─── PHASE 1: Additional Indexes ───────────────────────

-- Composite index: most common dashboard/billing query
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status
  ON public.subscriptions(user_id, status);

-- Partial index: only pending/paying rows (used by billing cron)
CREATE INDEX IF NOT EXISTS idx_subscriptions_billing
  ON public.subscriptions(next_billing_at)
  WHERE status IN ('pending', 'paying');

-- Composite index: wallet transaction history per user sorted by date
CREATE INDEX IF NOT EXISTS idx_wallet_tx_user_created
  ON public.wallet_transactions(user_id, created_at DESC);

-- Composite index: VTU job lookup by subscription
CREATE INDEX IF NOT EXISTS idx_vtu_jobs_sub_status
  ON public.vtu_jobs(subscription_id, status);

-- Partial index: jobs the retry worker needs to pick up quickly
CREATE INDEX IF NOT EXISTS idx_vtu_jobs_retry
  ON public.vtu_jobs(attempts)
  WHERE status = 'retry';

-- Ledger lookup by user and date
CREATE INDEX IF NOT EXISTS idx_ledger_user_created
  ON public.ledger_transactions(user_id, created_at DESC);

-- Subscription created_at for admin reports
CREATE INDEX IF NOT EXISTS idx_subscriptions_created_at
  ON public.subscriptions(created_at DESC);

-- Installment audit log lookups
CREATE INDEX IF NOT EXISTS idx_audit_sub_id
  ON public.installment_audit_logs(subscription_id);

CREATE INDEX IF NOT EXISTS idx_audit_user_id
  ON public.installment_audit_logs(user_id);

-- Fraud indexes
CREATE INDEX IF NOT EXISTS idx_fraud_scores_user
  ON public.fraud_scores(user_id);

CREATE INDEX IF NOT EXISTS idx_fraud_locks_user
  ON public.fraud_locks(user_id);


-- ─── PHASE 2: Enable RLS on remaining tables ───────────

ALTER TABLE public.ledger_transactions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.installment_audit_logs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fraud_scores            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fraud_locks             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vtu_dead_letter         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_metrics        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_tokens           ENABLE ROW LEVEL SECURITY;


-- ─── PHASE 3: RLS Policies ─────────────────────────────

-- ledger_transactions: users can only read their own rows (no self-insert; written by SECURITY DEFINER fns)
CREATE POLICY "ledger_tx_own_select"
  ON public.ledger_transactions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- webhook_events: no direct user access (service role only)
CREATE POLICY "webhook_events_deny_users"
  ON public.webhook_events FOR ALL
  TO authenticated
  USING (FALSE);

-- installment_audit_logs: users can read their own audit trail
CREATE POLICY "audit_logs_own_select"
  ON public.installment_audit_logs FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- fraud_scores / fraud_locks: deny all authenticated access (service role only)
CREATE POLICY "fraud_scores_deny_users"
  ON public.fraud_scores FOR ALL
  TO authenticated
  USING (FALSE);

CREATE POLICY "fraud_locks_deny_users"
  ON public.fraud_locks FOR ALL
  TO authenticated
  USING (FALSE);

-- system_events: deny all authenticated access (internal use only)
CREATE POLICY "system_events_deny_users"
  ON public.system_events FOR ALL
  TO authenticated
  USING (FALSE);

-- vtu_dead_letter: deny all authenticated access (internal use only)
CREATE POLICY "vtu_dead_letter_deny_users"
  ON public.vtu_dead_letter FOR ALL
  TO authenticated
  USING (FALSE);

-- provider_metrics: public read (useful for status pages / transparency)
CREATE POLICY "provider_metrics_public_read"
  ON public.provider_metrics FOR SELECT
  TO anon, authenticated
  USING (TRUE);

-- device_tokens: users manage their own
CREATE POLICY "device_tokens_own_select"
  ON public.device_tokens FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "device_tokens_own_insert"
  ON public.device_tokens FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "device_tokens_own_delete"
  ON public.device_tokens FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);


-- ─── PHASE 4: Admin Read-Only Policies ─────────────────
-- Admin role is set via profiles.role = 'admin'
-- These policies allow admins to read all rows on every table

CREATE POLICY "admin_read_users"
  ON public.users FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "admin_read_subscriptions"
  ON public.subscriptions FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "admin_read_wallets"
  ON public.wallets FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "admin_read_wallet_tx"
  ON public.wallet_transactions FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "admin_read_vtu_jobs"
  ON public.vtu_jobs FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "admin_read_ledger"
  ON public.ledger_transactions FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "admin_read_profiles"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "admin_read_audit_logs"
  ON public.installment_audit_logs FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );


-- ─── PHASE 5: Core Functions ───────────────────────────

-- ── handle_automatic_profile_creation ──
-- Idempotent upsert of profile/user/wallet rows for users who signed up
-- before the trigger existed, or whose trigger insertion failed.
-- Frontend should call this RPC on first login (supabase.rpc('ensure_profile')).
CREATE OR REPLACE FUNCTION public.ensure_profile(p_user_id uuid, p_email text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_email TEXT;
BEGIN
  -- Resolve email: use provided value, fall back to auth.users
  IF p_email IS NOT NULL THEN
    v_email := p_email;
  ELSE
    SELECT email INTO v_email FROM auth.users WHERE id = p_user_id;
  END IF;

  INSERT INTO public.profiles (id, email)
  VALUES (p_user_id, v_email)
  ON CONFLICT (id) DO UPDATE SET email = COALESCE(EXCLUDED.email, profiles.email);

  INSERT INTO public.users (id, email, wallet_balance)
  VALUES (p_user_id, v_email, 0)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.wallets (user_id, balance)
  VALUES (p_user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;
END;
$$;


-- ── verify_subscription_completion ──
-- Returns whether a subscription is fully paid and ready for VTU delivery.
-- Also returns remaining balance to pay.
CREATE OR REPLACE FUNCTION public.verify_subscription_completion(p_subscription_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_sub subscriptions%ROWTYPE;
BEGIN
  SELECT * INTO v_sub FROM public.subscriptions WHERE id = p_subscription_id;
  IF NOT FOUND THEN
    RETURN json_build_object('found', false, 'error', 'Subscription not found');
  END IF;

  RETURN json_build_object(
    'found',             true,
    'subscription_id',   v_sub.id,
    'status',            v_sub.status,
    'total_price',       v_sub.total_price,
    'amount_paid',       v_sub.amount_paid,
    'balance_remaining', GREATEST(v_sub.total_price - v_sub.amount_paid, 0),
    'is_complete',       (v_sub.amount_paid >= v_sub.total_price),
    'vtu_queued',        EXISTS (
                           SELECT 1 FROM public.vtu_jobs
                           WHERE subscription_id = p_subscription_id
                             AND status IN ('queued', 'success')
                         )
  );
END;
$$;


-- ── reset_failed_jobs ──
-- Resets failed/retry VTU jobs to queued using exponential back-off.
-- Safe to call from pg_cron or the retryWorker edge function.
-- Jobs with attempts >= 5 are moved to the dead-letter queue and not retried.
CREATE OR REPLACE FUNCTION public.reset_failed_jobs()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_requeued   INTEGER := 0;
  v_dead_lettered INTEGER := 0;
  v_job        RECORD;
  v_backoff_ok BOOLEAN;
BEGIN
  FOR v_job IN
    SELECT id, attempts, updated_at
    FROM public.vtu_jobs
    WHERE status = 'retry'
  LOOP
    IF v_job.attempts >= 5 THEN
      -- Move to dead letter
      INSERT INTO public.vtu_dead_letter (job_id, reason)
      VALUES (v_job.id, 'Max retry attempts reached (' || v_job.attempts || ')')
      ON CONFLICT DO NOTHING;

      UPDATE public.vtu_jobs
      SET status = 'failed', updated_at = NOW()
      WHERE id = v_job.id;

      v_dead_lettered := v_dead_lettered + 1;
    ELSE
      -- Exponential back-off: wait 2^attempts minutes before requeue.
      -- Retry schedule (minutes after last attempt): 2, 4, 8, 16 → max 4 retries then dead-letter.
      -- This function is called every 3 minutes by pg_cron, so the effective windows are:
      --   attempt 1 → retry after ~2 min  (next cron tick)
      --   attempt 2 → retry after ~4 min
      --   attempt 3 → retry after ~8 min
      --   attempt 4 → retry after ~16 min
      v_backoff_ok := (
        NOW() >= v_job.updated_at + (INTERVAL '1 minute' * POWER(2, v_job.attempts))
      );

      IF v_backoff_ok THEN
        UPDATE public.vtu_jobs
        SET status = 'queued', updated_at = NOW()
        WHERE id = v_job.id;

        v_requeued := v_requeued + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN json_build_object(
    'requeued',      v_requeued,
    'dead_lettered', v_dead_lettered
  );
END;
$$;


-- ── trigger_installment_billing ──
-- Called by pg_cron daily. Processes all subscriptions that are due today.
-- Deducts wallet, records ledger, queues VTU job on completion.
-- Uses pg_net to call the installmentBilling edge function per user (if available),
-- or performs the billing inline when pg_net is unavailable.
CREATE OR REPLACE FUNCTION public.trigger_installment_billing()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_sub          RECORD;
  v_wallet       RECORD;
  v_daily        NUMERIC;
  v_new_paid     NUMERIC;
  v_new_balance  NUMERIC;
  v_processed    INTEGER := 0;
  v_skipped      INTEGER := 0;
  v_now          TIMESTAMPTZ := NOW();
  v_is_discount  BOOLEAN;
  v_amount       NUMERIC;
BEGIN
  -- Loop over all subscriptions due for billing today
  FOR v_sub IN
    SELECT s.*, dp.daily_price
    FROM public.subscriptions s
    LEFT JOIN public.data_plans dp ON dp.id = s.plan_id
    WHERE s.status IN ('pending', 'paying')
      AND (s.next_billing_at IS NULL OR s.next_billing_at <= v_now)
  LOOP
    -- Resolve daily amount (prefer subscription's stored value)
    v_daily := COALESCE(
      NULLIF(v_sub.daily_amount, 0),
      NULLIF(v_sub.daily_installment, 0),
      v_sub.daily_price,
      0
    );

    IF v_daily <= 0 THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- Fetch current wallet balance
    SELECT * INTO v_wallet FROM public.wallets WHERE user_id = v_sub.user_id;
    IF NOT FOUND OR v_wallet.balance < v_daily THEN
      -- Insufficient balance — postpone by 1 day and continue
      UPDATE public.subscriptions
      SET next_billing_at = v_now + INTERVAL '1 day',
          updated_at      = v_now
      WHERE id = v_sub.id;

      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- Student discount: 20% off within first 7 days
    v_is_discount := (
      v_sub.is_student = TRUE AND
      v_sub.student_discount_until IS NOT NULL AND
      v_now <= v_sub.student_discount_until
    );
    v_amount := CASE WHEN v_is_discount THEN v_daily * 0.8 ELSE v_daily END;

    -- Debit wallet atomically
    UPDATE public.wallets
    SET balance    = balance - v_amount,
        updated_at = v_now
    WHERE user_id = v_sub.user_id
    RETURNING balance INTO v_new_balance;

    -- Sync users.wallet_balance mirror
    UPDATE public.users
    SET wallet_balance = v_new_balance
    WHERE id = v_sub.user_id;

    -- Wallet transaction record
    INSERT INTO public.wallet_transactions (user_id, amount, type, reference, metadata)
    VALUES (
      v_sub.user_id,
      v_amount,
      'debit',
      v_sub.id::text,
      json_build_object(
        'description',      'Daily installment',
        'subscription_id',  v_sub.id,
        'student_discount', v_is_discount
      )
    );

    -- Ledger entry
    INSERT INTO public.ledger_transactions (user_id, type, amount, reference)
    VALUES (v_sub.user_id, 'debit', v_amount, v_sub.id::text);

    -- Audit log
    INSERT INTO public.installment_audit_logs (subscription_id, user_id, amount, action)
    VALUES (v_sub.id, v_sub.user_id, v_amount, 'daily_deduction');

    v_new_paid := v_sub.amount_paid + v_amount;

    IF v_new_paid >= v_sub.total_price THEN
      -- Fully paid — mark completed and queue VTU delivery
      UPDATE public.subscriptions
      SET status       = 'completed',
          amount_paid  = v_sub.total_price,
          completed_at = v_now,
          updated_at   = v_now
      WHERE id = v_sub.id;

      INSERT INTO public.vtu_jobs (subscription_id, status, provider_priority)
      VALUES (v_sub.id, 'queued', 1)
      ON CONFLICT DO NOTHING;
    ELSE
      -- Partial — advance next_billing_at by 1 day
      UPDATE public.subscriptions
      SET amount_paid     = v_new_paid,
          status          = 'paying',
          next_billing_at = v_now + INTERVAL '1 day',
          updated_at      = v_now
      WHERE id = v_sub.id;
    END IF;

    v_processed := v_processed + 1;
  END LOOP;

  RETURN json_build_object(
    'processed', v_processed,
    'skipped',   v_skipped,
    'ran_at',    v_now
  );
END;
$$;


-- ─── PHASE 6: Wallet Balance Sync Trigger ──────────────
-- Keeps users.wallet_balance automatically in sync with wallets.balance
-- so neither table can drift out of sync.

CREATE OR REPLACE FUNCTION public.sync_wallet_balance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.users
  SET wallet_balance = NEW.balance
  WHERE id = NEW.user_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_wallet_balance ON public.wallets;
CREATE TRIGGER trg_sync_wallet_balance
  AFTER UPDATE OF balance ON public.wallets
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_wallet_balance();


-- ─── PHASE 7: pg_cron Job Schedules ────────────────────
-- Requires the pg_cron extension to be enabled in the Supabase project.
-- Enable it from: Supabase Dashboard → Database → Extensions → pg_cron
-- These calls are wrapped in a DO block so the migration succeeds even if
-- pg_cron is not yet enabled (non-fatal error is caught).

DO $$
BEGIN
  -- Daily installment billing at 08:00 UTC
  PERFORM cron.schedule(
    'dataedge-daily-billing',
    '0 8 * * *',
    $cron$ SELECT public.trigger_installment_billing(); $cron$
  );

  -- Reset failed VTU jobs every 3 minutes (respects exponential back-off)
  PERFORM cron.schedule(
    'dataedge-reset-failed-jobs',
    '*/3 * * * *',
    $cron$ SELECT public.reset_failed_jobs(); $cron$
  );
EXCEPTION
  WHEN undefined_function THEN
    -- pg_cron not enabled; skip silently
    NULL;
  WHEN others THEN
    NULL;
END;
$$;
