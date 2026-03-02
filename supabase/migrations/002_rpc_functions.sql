-- ════════════════════════════════════════════════════════
-- DataEdge — Vortexedge Limited
-- Migration 002: RPC Functions & Auth Trigger
-- ════════════════════════════════════════════════════════

-- ─── TRIGGER: handle_new_user ───
-- Fires on every new auth.users signup
-- Creates rows in profiles, users, and wallets tables
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO UPDATE SET email = NEW.email;

  INSERT INTO public.users (id, email, wallet_balance)
  VALUES (NEW.id, NEW.email, 0)
  ON CONFLICT DO NOTHING;

  INSERT INTO public.wallets (user_id, balance)
  VALUES (NEW.id, 0)
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

-- Attach trigger to auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ─── RPC: get_wallet_balance ───
-- Returns current wallet balance for a user
CREATE OR REPLACE FUNCTION public.get_wallet_balance(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE v_balance NUMERIC;
BEGIN
  SELECT COALESCE(balance, 0) INTO v_balance
  FROM wallets WHERE user_id = p_user_id;
  RETURN COALESCE(v_balance, 0);
END;
$$;


-- ─── RPC: fund_wallet_request ───
-- Credits user wallet and records transaction
-- Called from frontend when admin verifies bank transfer
CREATE OR REPLACE FUNCTION public.fund_wallet_request(
  p_user_id  uuid,
  p_amount   numeric,
  p_reference text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE v_new_balance NUMERIC;
BEGIN
  IF p_amount <= 0 THEN
    RETURN json_build_object('success', false, 'error', 'Amount must be positive');
  END IF;

  -- Upsert wallet row (safe for new users)
  INSERT INTO wallets (user_id, balance)
  VALUES (p_user_id, 0)
  ON CONFLICT DO NOTHING;

  -- Credit wallet
  UPDATE wallets
  SET balance = balance + p_amount
  WHERE user_id = p_user_id
  RETURNING balance INTO v_new_balance;

  -- Sync to users.wallet_balance mirror
  UPDATE users SET wallet_balance = v_new_balance WHERE id = p_user_id;

  -- Record transaction for audit trail
  INSERT INTO wallet_transactions (user_id, amount, type, reference, metadata)
  VALUES (p_user_id, p_amount, 'credit', p_reference,
          json_build_object('description', 'Wallet Top-up'));

  RETURN json_build_object('success', true, 'balance', v_new_balance);
END;
$$;


-- ─── RPC: pay_installment ───
-- Debits wallet and updates subscription progress
-- Called from frontend Pay Installment button
CREATE OR REPLACE FUNCTION public.pay_installment(
  p_user_id         uuid,
  p_subscription_id uuid,
  p_amount          numeric,
  p_reference       text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_wallet_balance  NUMERIC;
  v_sub             subscriptions%ROWTYPE;
  v_new_balance     NUMERIC;
  v_new_paid        NUMERIC;
  v_new_status      TEXT;
BEGIN
  -- Check wallet balance
  SELECT COALESCE(balance, 0) INTO v_wallet_balance
  FROM wallets WHERE user_id = p_user_id;

  IF v_wallet_balance < p_amount THEN
    RETURN json_build_object('success', false, 'error', 'Insufficient wallet balance');
  END IF;

  -- Get subscription
  SELECT * INTO v_sub FROM subscriptions WHERE id = p_subscription_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Subscription not found');
  END IF;

  -- Debit wallet
  UPDATE wallets
  SET balance = balance - p_amount
  WHERE user_id = p_user_id
  RETURNING balance INTO v_new_balance;

  -- Sync users mirror
  UPDATE users SET wallet_balance = v_new_balance WHERE id = p_user_id;

  -- Record wallet transaction
  INSERT INTO wallet_transactions (user_id, amount, type, reference, metadata)
  VALUES (p_user_id, p_amount, 'debit', p_reference,
          json_build_object(
            'description', 'Installment payment',
            'subscription_id', p_subscription_id
          ));

  -- Update subscription paid amount and status
  v_new_paid   := v_sub.amount_paid + p_amount;
  v_new_status := v_sub.status;

  IF v_new_paid >= v_sub.total_price THEN
    v_new_paid   := v_sub.total_price;
    v_new_status := 'completed';
  END IF;

  UPDATE subscriptions
  SET
    amount_paid  = v_new_paid,
    status       = v_new_status,
    completed_at = CASE WHEN v_new_status = 'completed' THEN NOW() ELSE completed_at END,
    updated_at   = NOW()
  WHERE id = p_subscription_id;

  -- Queue VTU job if completed
  IF v_new_status = 'completed' THEN
    INSERT INTO vtu_jobs (subscription_id, status, provider_priority)
    VALUES (p_subscription_id, 'queued', 1);
  END IF;

  RETURN json_build_object(
    'success',           true,
    'wallet_balance',    v_new_balance,
    'amount_paid',       v_new_paid,
    'balance_remaining', v_sub.total_price - v_new_paid,
    'status',            v_new_status
  );
END;
$$;


-- ─── RPC: subscribe_and_pay ───
-- Creates subscription and pays first installment atomically
-- Alternative to CreateSubscription edge fn (no SMS)
CREATE OR REPLACE FUNCTION public.subscribe_and_pay(
  p_user_id uuid,
  p_plan_id uuid,
  p_phone   text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_plan        data_plans%ROWTYPE;
  v_wallet_bal  NUMERIC;
  v_sub_id      UUID;
  v_pay_result  JSON;
BEGIN
  SELECT * INTO v_plan FROM data_plans WHERE id = p_plan_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Plan not found');
  END IF;

  SELECT COALESCE(balance, 0) INTO v_wallet_bal
  FROM wallets WHERE user_id = p_user_id;

  IF v_wallet_bal < v_plan.daily_price THEN
    RETURN json_build_object('success', false,
      'error', 'Insufficient wallet balance for first installment');
  END IF;

  -- Create subscription
  INSERT INTO subscriptions (user_id, plan_id, total_price, amount_paid, status, daily_amount, phone)
  VALUES (p_user_id, p_plan_id, v_plan.marked_price, 0, 'active', v_plan.daily_price, p_phone)
  RETURNING id INTO v_sub_id;

  -- Pay first installment
  SELECT pay_installment(p_user_id, v_sub_id, v_plan.daily_price, 'first-installment')
  INTO v_pay_result;

  RETURN json_build_object(
    'success',         true,
    'subscription_id', v_sub_id,
    'first_payment',   v_pay_result
  );
END;
$$;


-- ─── RPC: credit_wallet (admin) ───
-- Admin shortcut to credit by email
CREATE OR REPLACE FUNCTION public.credit_wallet(user_email text, amount numeric)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE wallets
  SET balance = balance + amount
  WHERE user_id = (
    SELECT id FROM users WHERE email = user_email
  );
END;
$$;
