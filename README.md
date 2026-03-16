# DataEdge — Installment Data Plans
### A product of Vortexedge Limited

DataEdge is a Nigerian procurement web app that lets users subscribe to data plans and pay in small daily installments. Powered by Supabase, Paystack, and Termii.

---

## 🚀 Deployment (GitHub Pages)

1. Push this repo to GitHub
2. Go to **Settings → Pages**
3. Set source to `main` branch, `/ (root)` folder
4. Your app will be live at `https://yourusername.github.io/dataedge/`

---

## 📁 Project Structure

```
dataedge/
├── index.html                        # Main frontend app (single file, self-contained)
├── README.md                         # This file
├── .gitignore
├── supabase/
│   ├── migrations/
│   │   ├── 001_initial_schema.sql    # All tables + basic indexes
│   │   ├── 002_rpc_functions.sql     # RPC functions (auth trigger, pay_installment, etc.)
│   │   ├── 003_rls_policies.sql      # Row Level Security policies (user-facing tables)
│   │   └── 004_production_enhancements.sql  # Composite indexes, RLS for remaining tables,
│   │                                        # admin policies, cron functions, wallet sync trigger
│   └── functions/
│       ├── CreateSubscription/       # Creates sub + SMS + triggers billing (idempotent)
│       ├── createVirtualAccount/     # Paystack DVA creation (Wema Bank)
│       ├── installmentBilling/       # Daily deduction worker (single-user or bulk/cron mode)
│       ├── paystackWebhook/          # Paystack charge.success handler (HMAC-verified)
│       ├── vtuProcessor/             # VTU job processor with provider fallback
│       ├── retryWorker/              # Failed job retry worker
│       ├── adminDashboard/           # Admin metrics
│       ├── activatePlan/             # Plan activation handler
│       └── errorHandler/             # Cron error notifications (SMS + system_events log)
```

---

## ⚙️ Environment Variables (Supabase Edge Functions)

Set these in your Supabase project → Settings → Edge Functions → Secrets:

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (never expose publicly) |
| `PAYSTACK_SECRET_KEY` | Paystack secret key (from Paystack dashboard) |
| `TERMII_KEY` | Termii API key (for SMS notifications) |
| `VTU_SECRET` | VTU provider API secret |
| `ADMIN_PHONE` | Admin phone number for cron error SMS alerts (optional) |

---

## 🗄️ Database

All tables are in `supabase/migrations/`. Apply them in order:

```bash
# Using Supabase CLI
supabase db push

# Or run each SQL file manually in the Supabase SQL Editor
```

**Core Tables:**
- `users` — mirror of auth.users with wallet_balance, virtual_account fields, is_student
- `wallets` — user wallet balances
- `wallet_transactions` — full audit trail (credit/debit/refund)
- `data_plans` — 59 data plans with daily_price and marked_price
- `providers` — MTN, Airtel, Glo
- `subscriptions` — user subscriptions with installment tracking
- `vtu_jobs` — data delivery job queue
- `profiles` — extended user profiles (Paystack fields)
- `webhook_events` — idempotency log for Paystack webhooks (service-role only)
- `ledger_transactions` — financial ledger (users can read own rows)
- `installment_audit_logs` — audit trail for every installment deduction
- `system_events` — internal error and event log (service-role only)

**Production Notes (Migration 004):**
- Composite & partial indexes added for 100k+ user scale
- RLS enabled on all tables; admin access controlled by `profiles.role = 'admin'`
- `wallet_balance` in `users` is automatically synced via DB trigger when `wallets.balance` changes
- pg_cron schedules installed automatically when pg_cron extension is enabled:
  - `dataedge-daily-billing` — runs `trigger_installment_billing()` every day at 08:00 UTC
  - `dataedge-reset-failed-jobs` — runs `reset_failed_jobs()` every 3 minutes

**Enable pg_cron:**
1. Supabase Dashboard → Database → Extensions → search "pg_cron" → Enable
2. Re-run migration 004 or execute the cron schedule block manually

---

## 🔧 Features

- ✅ **Auth** — Email/password signup & login via Supabase Auth
- ✅ **Wallet** — Fund wallet, view balance & transaction history
- ✅ **Virtual Account** — Paystack dedicated Wema Bank account per user
- ✅ **58+ Plans** — MTN, Airtel, Glo (daily, weekly, monthly)
- ✅ **Installments** — Subscribe and pay daily from wallet
- ✅ **Student Discounts** — 50% off daily rate for 7 days
- ✅ **SMS Notifications** — Powered by Termii
- ✅ **VTU Delivery** — Auto-delivers data on full payment
- ✅ **Admin Dashboard** — Edge function with platform metrics

---

## 🏢 Company

**Vortexedge Limited** — All rights reserved © 2026
