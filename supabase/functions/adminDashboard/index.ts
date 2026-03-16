// adminDashboard Edge Function — DataEdge / Vortexedge Limited
//
// Returns platform-wide metrics for admin use.
// Access is restricted to users whose profiles.role = 'admin'.
//
// Metrics returned:
//   - total_users
//   - total_wallet_balance (sum of all wallets)
//   - active_subscriptions count
//   - completed_subscriptions count
//   - pending_vtu_jobs count
//   - revenue_today (sum of debit transactions today)
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const serviceHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
};

// ── JWT validation ──────────────────────────────────────────────────────────
async function getAuthenticatedUser(req: Request): Promise<{ id: string }> {
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
  // ── Authenticate caller ──
  let authUser: { id: string };
  try {
    authUser = await getAuthenticatedUser(req);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Admin role check ──
  const profileRes = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${authUser.id}&select=role`,
    { headers: serviceHeaders }
  );
  if (!profileRes.ok) {
    return new Response(
      JSON.stringify({ error: "Failed to verify admin role" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
  const profiles = await profileRes.json();
  if (!Array.isArray(profiles) || profiles.length !== 1 || profiles[0].role !== "admin") {
    return new Response(
      JSON.stringify({ error: "Forbidden: admin access required" }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const today = new Date().toISOString().split("T")[0];

    const [
      usersRes,
      activeSubsRes,
      completedSubsRes,
      walletsRes,
      revRes,
      pendingVTURes,
    ] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/users?select=count`, { headers: serviceHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/subscriptions?status=in.(paying,active)&select=count`, { headers: serviceHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/subscriptions?status=eq.completed&select=count`, { headers: serviceHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/wallets?select=balance`, { headers: serviceHeaders }),
      fetch(
        `${SUPABASE_URL}/rest/v1/wallet_transactions?type=eq.debit&created_at=gte.${today}&select=amount`,
        { headers: serviceHeaders }
      ),
      fetch(`${SUPABASE_URL}/rest/v1/vtu_jobs?status=in.(queued,retry)&select=count`, { headers: serviceHeaders }),
    ]);

    const walletData  = await walletsRes.json();
    const revenueData = await revRes.json();

    const totalWallet  = walletData.reduce((s: number, w: { balance: string }) => s + Number(w.balance), 0);
    const revenueToday = revenueData.reduce((s: number, t: { amount: string }) => s + Number(t.amount), 0);

    return new Response(
      JSON.stringify({
        total_users:              await usersRes.json(),
        active_subscriptions:     await activeSubsRes.json(),
        completed_subscriptions:  await completedSubsRes.json(),
        pending_vtu_jobs:         await pendingVTURes.json(),
        total_wallet_balance:     totalWallet,
        revenue_today:            revenueToday,
        generated_at:             new Date().toISOString(),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
