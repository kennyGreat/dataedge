// CreateSubscription Edge Function — DataEdge / Vortexedge Limited
//
// Flow:
//   1. Validate caller JWT → extract authenticated user_id (no body-spoofing)
//   2. Rate-limit: max 5 subscription attempts per user per 5 minutes
//   3. Idempotency check: reject duplicate active subscription for same plan
//   4. Fetch plan details + user student flag
//   5. Create subscription row (status: pending)
//   6. Send SMS confirmation via Termii
//   7. Trigger installmentBilling for immediate first deduction
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TERMII_KEY

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TERMII_KEY   = Deno.env.get("TERMII_KEY")!;

const serviceHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

// ── JWT validation ──────────────────────────────────────────────────────────
// Validates the user's Bearer token against the Supabase Auth API.
// Returns the authenticated user object or throws on invalid/missing token.
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

// ── Rate limiting (DB-backed) ───────────────────────────────────────────────
// Rejects if the user created >= 5 subscriptions in the last 5 minutes.
class RateLimitError extends Error {
  readonly status = 429;
  constructor() {
    super("Rate limit exceeded: too many subscription attempts");
  }
}

async function checkRateLimit(userId: string): Promise<void> {
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&created_at=gte.${encodeURIComponent(since)}&select=id`,
    { headers: serviceHeaders }
  );
  const recent = await res.json();
  if (Array.isArray(recent) && recent.length >= 5) {
    throw new RateLimitError();
  }
}

async function sendSMS(phone: string, message: string) {
  try {
    await fetch("https://api.ng.termii.com/api/sms/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: phone,
        from: "DataEdge",
        sms: message,
        type: "plain",
        api_key: TERMII_KEY,
      }),
    });
  } catch (_) {
    // SMS failure should not block subscription creation
  }
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

    const { plan_id, phone_number } = await req.json();

    if (!plan_id) {
      return new Response(
        JSON.stringify({ error: "Missing required field: plan_id" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // ── Rate limiting ──
    try {
      await checkRateLimit(user_id);
    } catch (e) {
      const err = e as RateLimitError;
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: err.status ?? 429, headers: { "Content-Type": "application/json" } }
      );
    }

    // Idempotency check: reject if an active/paying/pending subscription for this plan already exists
    const existingRes = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${user_id}&plan_id=eq.${plan_id}&status=in.(pending,paying,active)&limit=1`,
      { headers: serviceHeaders }
    );
    const existing = await existingRes.json();
    if (existing.length > 0) {
      return new Response(
        JSON.stringify({ error: "Subscription already active for this plan", subscription: existing[0] }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    // Fetch plan
    const planRes = await fetch(
      `${SUPABASE_URL}/rest/v1/data_plans?id=eq.${plan_id}&select=*`,
      { headers: serviceHeaders }
    );
    const plan = (await planRes.json())[0];
    if (!plan) {
      return new Response(
        JSON.stringify({ error: "Plan not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Fetch user (for student flag)
    const userRes = await fetch(
      `${SUPABASE_URL}/rest/v1/users?id=eq.${user_id}&select=*`,
      { headers: serviceHeaders }
    );
    const user = (await userRes.json())[0];
    const isStudent = user?.is_student === true;

    // Calculate pricing
    const totalPrice       = plan.marked_price;
    const dailyInstallment = plan.daily_price;

    // Student discount: 50% off daily rate for first 7 days
    const studentDiscountUntil = isStudent
      ? new Date(Date.now() + 7 * 86400000).toISOString()
      : null;

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 35);

    // Create subscription
    const subRes = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions`, {
      method: "POST",
      headers: { ...serviceHeaders, Prefer: "return=representation" },
      body: JSON.stringify({
        user_id,
        plan_id,
        phone_number,
        phone: phone_number,
        total_price: totalPrice,
        daily_installment: dailyInstallment,
        daily_amount: dailyInstallment,
        amount_paid: 0,
        status: "pending",
        is_student: isStudent,
        student_discount_until: studentDiscountUntil,
        expires_at: expiresAt.toISOString(),
      }),
    });

    const subscription = (await subRes.json())[0];
    if (!subscription) {
      return new Response(
        JSON.stringify({ error: "Failed to create subscription" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // Send SMS confirmation
    if (phone_number) {
      const discountNote = isStudent ? " (50% student discount active for 7 days)" : "";
      await sendSMS(
        phone_number,
        `DataEdge: Your ${plan.name} subscription is active! Daily installment: ₦${dailyInstallment}${discountNote}. We will deduct daily until fully paid.`
      );
    }

    // Trigger immediate first billing
    await fetch(`${SUPABASE_URL}/functions/v1/installmentBilling`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ user_id }),
    });

    return new Response(
      JSON.stringify({ success: true, subscription }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
