// createVirtualAccount Edge Function — DataEdge / Vortexedge Limited
//
// Flow:
//   1. Create Paystack customer (email + name + phone)
//   2. Create dedicated virtual account (Wema Bank)
//   3. Save account_number + bank_name to users table
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PAYSTACK_SECRET_KEY

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const PAYSTACK_SECRET = Deno.env.get("PAYSTACK_SECRET_KEY")!;
const SUPABASE_URL    = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req) => {
  try {
    const { user_id, email, first_name, last_name, phone } = await req.json();

    if (!user_id || !email) {
      return new Response(
        JSON.stringify({ error: "user_id and email are required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Step 1: Create Paystack customer
    const customerRes = await fetch("https://api.paystack.co/customer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, first_name, last_name, phone }),
    });

    const customer = await customerRes.json();
    if (!customer.status) {
      return new Response(
        JSON.stringify({ error: "Failed to create Paystack customer", details: customer }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Step 2: Create dedicated virtual account (Wema Bank)
    const dvaRes = await fetch("https://api.paystack.co/dedicated_account", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        customer: customer.data.customer_code,
        preferred_bank: "wema-bank",
      }),
    });

    const dva = await dvaRes.json();
    if (!dva.status || !dva.data?.account_number) {
      return new Response(
        JSON.stringify({ error: "Failed to create virtual account", details: dva }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const accountNumber = dva.data.account_number;
    const bankName      = dva.data.bank?.name || "Wema Bank";

    // Step 3: Save to users table
    await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${user_id}`, {
      method: "PATCH",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        virtual_account_number: accountNumber,
        virtual_bank_name: bankName,
      }),
    });

    // Also save Paystack customer code to profiles
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user_id}`, {
      method: "PATCH",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        paystack_customer_code: customer.data.customer_code,
      }),
    });

    return new Response(
      JSON.stringify({ account_number: accountNumber, bank_name: bankName }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
