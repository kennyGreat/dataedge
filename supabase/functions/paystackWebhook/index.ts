// paystackWebhook Edge Function — DataEdge / Vortexedge Limited
//
// Flow:
//   1. Verify Paystack HMAC-SHA512 signature
//   2. Idempotency check (webhook_events table)
//   3. Log webhook event
//   4. Look up user by email
//   5. Check account lock
//   6. Credit wallet + ledger
//   7. Trigger installmentBilling for immediate deduction
//
// Paystack webhook config:
//   URL: https://jhwsdurdkpciwezhlgzt.supabase.co/functions/v1/paystackWebhook
//   Events: charge.success
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PAYSTACK_SECRET_KEY

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

serve(async (req) => {
  try {
    const SUPABASE_URL    = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const PAYSTACK_SECRET = Deno.env.get("PAYSTACK_SECRET_KEY")!;

    const headers = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };

    const rawBody  = await req.text();
    const signature = req.headers.get("x-paystack-signature");

    // ── Verify Paystack HMAC-SHA512 signature ──
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(PAYSTACK_SECRET),
      { name: "HMAC", hash: "SHA-512" },
      false,
      ["sign"]
    );
    const signed = await crypto.subtle.sign(
      "HMAC", key, new TextEncoder().encode(rawBody)
    );
    const computed = Array.from(new Uint8Array(signed))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (computed !== signature) {
      return new Response("Invalid signature", { status: 401 });
    }

    const body = JSON.parse(rawBody);

    // Only process successful charges
    if (body.event !== "charge.success") {
      return new Response("Ignored", { status: 200 });
    }

    const reference = body.data.reference;
    const amount    = body.data.amount / 100; // Paystack sends in kobo
    const email     = body.data.customer.email;

    // ── Idempotency check ──
    const dupCheck = await fetch(
      `${SUPABASE_URL}/rest/v1/webhook_events?reference=eq.${reference}`,
      { headers }
    );
    const dupData = await dupCheck.json();
    if (dupData.length > 0) {
      return new Response("Duplicate ignored", { status: 200 });
    }

    // Log webhook
    await fetch(`${SUPABASE_URL}/rest/v1/webhook_events`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reference, payload: body }),
    });

    // Get user by email
    const userRes = await fetch(
      `${SUPABASE_URL}/rest/v1/users?email=eq.${email}`,
      { headers }
    );
    const users = await userRes.json();
    if (!users.length) return new Response("User not found", { status: 200 });

    const user = users[0];

    // Account lock check
    if (user.account_locked) {
      return new Response("Account locked", { status: 403 });
    }

    // ── Credit wallet ──
    await fetch(`${SUPABASE_URL}/rest/v1/wallets?user_id=eq.${user.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ balance: (user.wallet_balance || 0) + amount }),
    });

    // Sync users.wallet_balance
    await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${user.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ wallet_balance: (user.wallet_balance || 0) + amount }),
    });

    // Wallet transaction record
    await fetch(`${SUPABASE_URL}/rest/v1/wallet_transactions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        user_id: user.id,
        amount,
        type: "credit",
        reference,
        metadata: { description: "Paystack Top-up", paystack_reference: reference },
      }),
    });

    // Ledger credit entry
    await fetch(`${SUPABASE_URL}/rest/v1/ledger_transactions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ user_id: user.id, type: "credit", amount, reference }),
    });

    // ── Trigger immediate installment billing ──
    await fetch(`${SUPABASE_URL}/functions/v1/installmentBilling`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: user.id }),
    });

    return new Response("Processed", { status: 200 });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
