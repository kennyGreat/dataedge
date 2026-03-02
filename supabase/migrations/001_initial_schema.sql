-- ════════════════════════════════════════════════════════
-- DataEdge — Vortexedge Limited
-- Migration 001: Initial Schema
-- ════════════════════════════════════════════════════════

-- EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── PROVIDERS ───
CREATE TABLE IF NOT EXISTS public.providers (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       TEXT NOT NULL,
  api_name   TEXT,
  api_url    TEXT,
  priority   INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed providers
INSERT INTO public.providers (name, api_name) VALUES
  ('MTN',    'mtn'),
  ('Airtel', 'airtel'),
  ('Glo',    'glo')
ON CONFLICT DO NOTHING;

-- ─── DATA PLANS ───
CREATE TABLE IF NOT EXISTS public.data_plans (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL,
  provider_id   UUID REFERENCES public.providers(id) ON DELETE SET NULL,
  category      TEXT NOT NULL DEFAULT 'daily',  -- daily | weekly | monthly
  data_size_gb  NUMERIC NOT NULL DEFAULT 0,
  base_price    NUMERIC NOT NULL DEFAULT 0,
  marked_price  NUMERIC NOT NULL DEFAULT 0,
  daily_price   NUMERIC NOT NULL DEFAULT 0,
  vtu_code      TEXT,
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── PROFILES (extended auth.users) ───
CREATE TABLE IF NOT EXISTS public.profiles (
  id                UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email             TEXT,
  full_name         TEXT,
  phone             TEXT,
  paystack_customer_code TEXT,
  paystack_dva_id   TEXT,
  role              TEXT DEFAULT 'user',
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ─── USERS (mirror + wallet fields) ───
CREATE TABLE IF NOT EXISTS public.users (
  id                     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email                  TEXT,
  full_name              TEXT,
  phone                  TEXT,
  wallet_balance         NUMERIC DEFAULT 0,
  virtual_account_number TEXT,
  virtual_bank_name      TEXT,
  is_student             BOOLEAN DEFAULT FALSE,
  account_locked         BOOLEAN DEFAULT FALSE,
  created_at             TIMESTAMPTZ DEFAULT NOW()
);

-- ─── WALLETS ───
CREATE TABLE IF NOT EXISTS public.wallets (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  balance    NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── WALLET TRANSACTIONS ───
CREATE TABLE IF NOT EXISTS public.wallet_transactions (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  amount     NUMERIC NOT NULL,
  type       TEXT NOT NULL DEFAULT 'credit',  -- credit | debit | refund
  reference  TEXT,
  metadata   JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── SUBSCRIPTIONS ───
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_id                UUID REFERENCES public.data_plans(id) ON DELETE SET NULL,
  phone                  TEXT,
  phone_number           TEXT,           -- alias used by some edge functions
  total_price            NUMERIC NOT NULL DEFAULT 0,
  amount_paid            NUMERIC NOT NULL DEFAULT 0,
  daily_amount           NUMERIC DEFAULT 0,
  daily_installment      NUMERIC DEFAULT 0,  -- alias used by CreateSubscription fn
  status                 TEXT NOT NULL DEFAULT 'pending',  -- pending | paying | active | completed | cancelled | suspended
  is_student             BOOLEAN DEFAULT FALSE,
  student_discount_until TIMESTAMPTZ,
  next_billing_at        TIMESTAMPTZ,
  activated_at           TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  expires_at             TIMESTAMPTZ,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

-- ─── VTU JOBS ───
CREATE TABLE IF NOT EXISTS public.vtu_jobs (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subscription_id  UUID REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  status           TEXT DEFAULT 'queued',  -- queued | success | retry | failed
  provider_used    TEXT,
  provider_priority INTEGER DEFAULT 1,
  attempts         INTEGER DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ─── LEDGER TRANSACTIONS ───
CREATE TABLE IF NOT EXISTS public.ledger_transactions (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,  -- credit | debit
  amount     NUMERIC NOT NULL,
  reference  TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── WEBHOOK EVENTS (idempotency) ───
CREATE TABLE IF NOT EXISTS public.webhook_events (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reference  TEXT UNIQUE NOT NULL,
  payload    JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── INSTALLMENT AUDIT LOGS ───
CREATE TABLE IF NOT EXISTS public.installment_audit_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subscription_id UUID REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  amount          NUMERIC,
  action          TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── FRAUD SCORES ───
CREATE TABLE IF NOT EXISTS public.fraud_scores (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  score      NUMERIC DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── FRAUD LOCKS ───
CREATE TABLE IF NOT EXISTS public.fraud_locks (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  reason     TEXT,
  locked_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── VTU DEAD LETTER ───
CREATE TABLE IF NOT EXISTS public.vtu_dead_letter (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id     UUID REFERENCES public.vtu_jobs(id) ON DELETE SET NULL,
  reason     TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── PROVIDER METRICS ───
CREATE TABLE IF NOT EXISTS public.provider_metrics (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider_id UUID REFERENCES public.providers(id) ON DELETE CASCADE,
  success     INTEGER DEFAULT 0,
  failure     INTEGER DEFAULT 0,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── SYSTEM EVENTS ───
CREATE TABLE IF NOT EXISTS public.system_events (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type       TEXT,
  payload    JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── DEVICE TOKENS ───
CREATE TABLE IF NOT EXISTS public.device_tokens (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,
  platform   TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── INDEXES ───
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id  ON public.subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status   ON public.subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_user_id      ON public.wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_vtu_jobs_status        ON public.vtu_jobs(status);
CREATE INDEX IF NOT EXISTS idx_webhook_events_ref     ON public.webhook_events(reference);
CREATE INDEX IF NOT EXISTS idx_data_plans_provider    ON public.data_plans(provider_id);
CREATE INDEX IF NOT EXISTS idx_data_plans_category    ON public.data_plans(category);
