// CreateSubscription Edge Function — DataEdge / Vortexedge Limited
//
// Flow:
//   1. Fetch plan details (student discount check)
//   2. Check user is_student flag
//   3. Create subscription row (status: pending)
//   4. Send SMS confirmation via Termii
//   5. Trigger installmentBilling to deduct first payment immediately
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TERMII_KEY

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TERMII_KEY   = Deno.env.get("TERMII_KEY")!;

const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

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
    const { user_id, plan_id, phone_number } = await req.json();

    if (!user_id || !plan_id) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: user_id and plan_id" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Fetch plan
    const planRes = await fetch(
      `${SUPABASE_URL}/rest/v1/data_plans?id=eq.${plan_id}&select=*`,
      { headers }
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
      { headers }
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
      headers: { ...headers, Prefer: "return=representation" },
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
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
