// installmentBilling Edge Function — DataEdge / Vortexedge Limited
//
// Flow:
//   1. Find all pending subscriptions for the user
//   2. Check wallet balance
//   3. Apply student 20% discount for first 7 days if within first 7 days
//   4. Deduct wallet, update ledger
//   5. If fully paid → activate subscription + queue VTU job
//   6. Else → update amount_paid
//
// Called by:
//   - CreateSubscription (first payment trigger)
//   - paystackWebhook (on charge.success)
//   - Cron job / scheduled trigger (daily deductions)
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

serve(async (req) => {
  try {
    const { user_id } = await req.json();

    // Fetch pending subscriptions for user
    const subsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${user_id}&status=eq.pending`,
      { headers }
    );
    const subs = await subsRes.json();
    if (!subs.length) return new Response("No pending subscriptions", { status: 200 });

    const subscription = subs[0];

    // Fetch wallet
    const walletRes = await fetch(
      `${SUPABASE_URL}/rest/v1/wallets?user_id=eq.${user_id}`,
      { headers }
    );
    const wallet = (await walletRes.json())[0];
    if (!wallet) return new Response("Wallet not found", { status: 404 });

    const daily = subscription.daily_amount || subscription.daily_installment;

    // Student 7-day discount check
    const now   = new Date();
    const start = new Date(subscription.created_at);
    const diffDays = (now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    const isStudentDiscountActive =
      subscription.is_student && diffDays <= 7;

    const amountToDeduct = isStudentDiscountActive ? daily * 0.8 : daily; // 20% off = pay 80%

    if (wallet.balance < amountToDeduct) {
      return new Response("Insufficient balance", { status: 200 });
    }

    // Debit wallet
    await fetch(`${SUPABASE_URL}/rest/v1/wallets?user_id=eq.${user_id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ balance: wallet.balance - amountToDeduct }),
    });

    // Sync users.wallet_balance
    await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${user_id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ wallet_balance: wallet.balance - amountToDeduct }),
    });

    // Ledger debit entry
    await fetch(`${SUPABASE_URL}/rest/v1/ledger_transactions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        user_id,
        type: "debit",
        amount: amountToDeduct,
        reference: subscription.id,
      }),
    });

    // Wallet transaction record
    await fetch(`${SUPABASE_URL}/rest/v1/wallet_transactions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        user_id,
        amount: amountToDeduct,
        type: "debit",
        reference: subscription.id,
        metadata: {
          description: "Installment payment",
          subscription_id: subscription.id,
          student_discount: isStudentDiscountActive,
        },
      }),
    });

    const newPaid = subscription.amount_paid + amountToDeduct;
    const total   = subscription.total_price;

    if (newPaid >= total) {
      // Fully paid → activate
      await fetch(
        `${SUPABASE_URL}/rest/v1/subscriptions?id=eq.${subscription.id}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            status: "completed",
            amount_paid: total,
            completed_at: new Date().toISOString(),
          }),
        }
      );

      // Queue VTU delivery job
      await fetch(`${SUPABASE_URL}/rest/v1/vtu_jobs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          subscription_id: subscription.id,
          provider_priority: 1,
          status: "queued",
        }),
      });
    } else {
      // Partial payment → update amount_paid and activate paying status
      await fetch(
        `${SUPABASE_URL}/rest/v1/subscriptions?id=eq.${subscription.id}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            amount_paid: newPaid,
            status: "paying",
            updated_at: new Date().toISOString(),
          }),
        }
      );
    }

    return new Response(
      JSON.stringify({ success: true, amount_deducted: amountToDeduct }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
