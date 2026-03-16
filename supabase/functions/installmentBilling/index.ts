// installmentBilling Edge Function — DataEdge / Vortexedge Limited
//
// Modes:
//   Single-user  — POST { user_id }
//     • Called by CreateSubscription and paystackWebhook for immediate first deduction.
//     • Processes all pending/paying subscriptions for one user.
//
//   Bulk / cron  — POST {} (no user_id)
//     • Called by the pg_cron schedule (daily at 08:00 UTC) or manually.
//     • Processes every pending/paying subscription across all users.
//
// Flow per subscription:
//   1. Resolve daily amount (student discount applied if within 7-day window)
//   2. Skip if wallet balance is insufficient (subscription stays pending)
//   3. Debit wallet, record wallet_transaction + ledger_transaction + audit_log
//   4. If fully paid → mark completed + queue VTU job
//   5. Else → update amount_paid + advance next_billing_at by 1 day
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

// Process a single subscription row. Returns a result descriptor.
async function processSubscription(
  subscription: Record<string, unknown>
): Promise<{ id: string; result: string; amount?: number }> {
  const userId = subscription.user_id as string;
  const daily  =
    Number(subscription.daily_amount) ||
    Number(subscription.daily_installment) ||
    0;

  if (daily <= 0) {
    return { id: subscription.id as string, result: "skipped_no_daily" };
  }

  // Fetch authoritative wallet balance
  const walletRes = await fetch(
    `${SUPABASE_URL}/rest/v1/wallets?user_id=eq.${userId}&select=balance`,
    { headers }
  );
  const walletRows = await walletRes.json();
  const wallet = walletRows[0];
  if (!wallet) return { id: subscription.id as string, result: "no_wallet" };

  // Student 7-day discount: 20% off (pay 80%)
  const now       = new Date();
  const discountUntil = subscription.student_discount_until
    ? new Date(subscription.student_discount_until as string)
    : null;
  const isStudentDiscountActive =
    subscription.is_student === true &&
    discountUntil !== null &&
    now <= discountUntil;

  const amountToDeduct = isStudentDiscountActive ? daily * 0.8 : daily;

  if (Number(wallet.balance) < amountToDeduct) {
    // Advance next_billing_at so cron retries tomorrow
    await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?id=eq.${subscription.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ next_billing_at: new Date(now.getTime() + 86400000).toISOString() }),
      }
    );
    return { id: subscription.id as string, result: "insufficient_balance" };
  }

  const newBalance = Number(wallet.balance) - amountToDeduct;

  // Debit wallet
  await fetch(`${SUPABASE_URL}/rest/v1/wallets?user_id=eq.${userId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ balance: newBalance }),
  });

  // Sync users.wallet_balance mirror (also kept in sync by DB trigger)
  await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ wallet_balance: newBalance }),
  });

  // Wallet transaction record
  await fetch(`${SUPABASE_URL}/rest/v1/wallet_transactions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      user_id: userId,
      amount: amountToDeduct,
      type: "debit",
      reference: subscription.id,
      metadata: {
        description:      "Installment payment",
        subscription_id:  subscription.id,
        student_discount: isStudentDiscountActive,
      },
    }),
  });

  // Ledger debit entry
  await fetch(`${SUPABASE_URL}/rest/v1/ledger_transactions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      user_id:   userId,
      type:      "debit",
      amount:    amountToDeduct,
      reference: subscription.id,
    }),
  });

  // Audit log
  await fetch(`${SUPABASE_URL}/rest/v1/installment_audit_logs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      subscription_id: subscription.id,
      user_id:         userId,
      amount:          amountToDeduct,
      action:          "daily_deduction",
    }),
  });

  const newPaid = Number(subscription.amount_paid) + amountToDeduct;
  const total   = Number(subscription.total_price);

  if (newPaid >= total) {
    // Fully paid → complete + queue VTU job
    await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?id=eq.${subscription.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          status:       "completed",
          amount_paid:  total,
          completed_at: now.toISOString(),
          updated_at:   now.toISOString(),
        }),
      }
    );

    await fetch(`${SUPABASE_URL}/rest/v1/vtu_jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        subscription_id:   subscription.id,
        provider_priority: 1,
        status:            "queued",
      }),
    });

    return { id: subscription.id as string, result: "completed", amount: amountToDeduct };
  } else {
    // Partial payment — advance billing date
    await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?id=eq.${subscription.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          amount_paid:     newPaid,
          status:          "paying",
          next_billing_at: new Date(now.getTime() + 86400000).toISOString(),
          updated_at:      now.toISOString(),
        }),
      }
    );

    return { id: subscription.id as string, result: "partial", amount: amountToDeduct };
  }
}

serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    const userId: string | undefined = body?.user_id;

    let subs: Record<string, unknown>[];

    if (userId) {
      // Single-user mode: process all pending/paying subscriptions for this user
      const subsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&status=in.(pending,paying)`,
        { headers }
      );
      subs = await subsRes.json();
    } else {
      // Bulk / cron mode: process all overdue subscriptions across all users.
      // Limited to 500 per invocation to stay within the Edge Function 60-second timeout.
      // The pg_cron schedule calls this every day; any unprocessed subscriptions will be
      // picked up on the next run because next_billing_at is advanced per cycle.
      const now = new Date().toISOString();
      const subsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/subscriptions?status=in.(pending,paying)&or=(next_billing_at.is.null,next_billing_at.lte.${encodeURIComponent(now)})&limit=500`,
        { headers }
      );
      subs = await subsRes.json();
    }

    if (!subs.length) {
      return new Response(
        JSON.stringify({ success: true, processed: 0, message: "No subscriptions due" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const results = await Promise.all(subs.map(processSubscription));

    return new Response(
      JSON.stringify({ success: true, processed: results.length, results }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
