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
│   │   ├── 001_initial_schema.sql    # All tables
│   │   ├── 002_rpc_functions.sql     # RPC functions
│   │   └── 003_rls_policies.sql      # Row Level Security policies
│   └── functions/
│       ├── CreateSubscription/       # Creates sub + SMS + triggers billing
│       ├── createVirtualAccount/     # Paystack DVA creation (Wema Bank)
│       ├── installmentBilling/       # Daily deduction worker
│       ├── paystackWebhook/          # Paystack charge.success handler
│       ├── vtuProcessor/             # VTU job processor
│       ├── retryWorker/              # Failed job retry worker
│       ├── adminDashboard/           # Admin metrics
│       └── activatePlan/             # Plan activation handler
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
- `webhook_events` — idempotency log for Paystack webhooks
- `ledger_transactions` — financial ledger

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

---

## ✅ Production Checklist

### Email Confirmation

By default (`enable_confirmations = false` in `supabase/config.toml`), users are auto-logged in immediately after signup — no email is sent and `data.session` is returned from `signUp()`.

For production deployments, enable email confirmation to require users to verify their address:

1. **Update `supabase/config.toml`:**
   ```toml
   [auth.email]
   enable_confirmations = true
   ```

2. **Configure SMTP in your Supabase project dashboard:**
   - Go to **Authentication → Settings → SMTP Settings**
   - Fill in your SMTP provider details (e.g. SendGrid, Resend, Mailgun):
     | Field | Example |
     |---|---|
     | Host | `smtp.sendgrid.net` |
     | Port | `465` (SSL) or `587` (TLS) |
     | Username | `apikey` |
     | Password | your SMTP API key |
     | Sender email | `noreply@yourdomain.com` |
     | Sender name | `DataEdge` |

3. **Customise the confirmation email template** (optional):
   - Go to **Authentication → Email Templates → Confirm signup**

4. **Frontend behaviour** — the `doSignup()` function in both `index.html` and `mobile.html` already handles both flows:
   - `data.session` returned → user is auto-logged in (confirmations **off**)
   - `data.session` is `null` → show "Check your email" message (confirmations **on**)
