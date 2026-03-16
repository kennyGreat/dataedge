// createVirtualAccount Edge Function — DataEdge / Vortexedge Limited
//
// Flow:
//   1. Validate caller JWT → extract authenticated user_id (no body-spoofing)
//   2. Create Paystack customer (email + name + phone)
//   3. Create dedicated virtual account (Wema Bank)
//   4. Save account_number + bank_name to users table
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PAYSTACK_SECRET_KEY

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const PAYSTACK_SECRET = Deno.env.get("PAYSTACK_SECRET_KEY")!;
const SUPABASE_URL    = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ── JWT validation ──────────────────────────────────────────────────────────
async function getAuthenticatedUser(req: Request): Promise<{ id: string; email: string }> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new Error("Missing Authorization header");

  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) throw new Error("Invalid or expired token");
  return res.json();
}

serve(async (req) => {
  try {
    // ── Authenticate caller ──
    let authUser: { id: string; email: string };
    try {
      authUser = await getAuthenticatedUser(req);
    } catch (e) {
      return new Response(
        JSON.stringify({ error: (e as Error).message }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // user_id is always taken from the validated JWT — never from the request body
    const user_id = authUser.id;

    const { first_name, last_name, phone } = await req.json();
    // email comes from the validated token, not the body
    const email = authUser.email;

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
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
