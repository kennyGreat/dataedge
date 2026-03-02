-- ════════════════════════════════════════════════════════
-- DataEdge — Vortexedge Limited
-- Migration 003: Row Level Security Policies
-- ════════════════════════════════════════════════════════

-- Enable RLS on all user-facing tables
ALTER TABLE public.users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_plans          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.providers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vtu_jobs            ENABLE ROW LEVEL SECURITY;


-- ─── DATA PLANS (public read) ───
CREATE POLICY "data_plans_public_read"
  ON public.data_plans FOR SELECT
  TO anon, authenticated
  USING (is_active = TRUE);


-- ─── PROVIDERS (public read) ───
CREATE POLICY "providers_public_read"
  ON public.providers FOR SELECT
  TO anon, authenticated
  USING (TRUE);


-- ─── USERS ───
CREATE POLICY "users_own_row_select"
  ON public.users FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "users_own_row_update"
  ON public.users FOR UPDATE
  TO authenticated
  USING (auth.uid() = id);

-- Service role (edge functions) has full access via SECURITY DEFINER functions


-- ─── PROFILES ───
CREATE POLICY "profiles_own_row_select"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "profiles_own_row_update"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id);


-- ─── WALLETS ───
CREATE POLICY "wallets_own_select"
  ON public.wallets FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "wallets_own_insert"
  ON public.wallets FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "wallets_own_update"
  ON public.wallets FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);


-- ─── WALLET TRANSACTIONS ───
CREATE POLICY "wallet_tx_own_select"
  ON public.wallet_transactions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "wallet_tx_own_insert"
  ON public.wallet_transactions FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);


-- ─── SUBSCRIPTIONS ───
CREATE POLICY "subs_own_select"
  ON public.subscriptions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "subs_own_insert"
  ON public.subscriptions FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "subs_own_update"
  ON public.subscriptions FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);


-- ─── VTU JOBS (read-only for users) ───
CREATE POLICY "vtu_jobs_own_select"
  ON public.vtu_jobs FOR SELECT
  TO authenticated
  USING (
    subscription_id IN (
      SELECT id FROM public.subscriptions WHERE user_id = auth.uid()
    )
  );


-- Note: Service role (SUPABASE_SERVICE_ROLE_KEY) used by edge functions
-- bypasses all RLS automatically — no additional policies needed for backend ops.
