// vtuProcessor Edge Function — DataEdge / Vortexedge Limited
//
// Flow:
//   1. Fetch up to 10 queued VTU jobs
//   2. For each job, try providers in priority order
//   3. On success → mark job success, record provider used
//   4. On all-fail → mark job for retry
//
// Called by:
//   - retryWorker (cron)
//   - pay_installment RPC (on completion via DB trigger or manual call)
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VTU_SECRET

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VTU_SECRET   = Deno.env.get("VTU_SECRET")!;

const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

serve(async () => {
  try {
    // Fetch queued jobs (max 10 per run)
    const jobsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/vtu_jobs?status=eq.queued&limit=10`,
      { headers }
    );
    const jobs = await jobsRes.json();
    if (!jobs.length) return new Response("No queued jobs", { status: 200 });

    const results = [];

    for (const job of jobs) {
      // Get subscription details
      const subRes = await fetch(
        `${SUPABASE_URL}/rest/v1/subscriptions?id=eq.${job.subscription_id}&select=*,data_plans(*)`,
        { headers }
      );
      const subscription = (await subRes.json())[0];
      if (!subscription) {
        results.push({ job_id: job.id, status: "skipped", reason: "subscription not found" });
        continue;
      }

      // Get providers sorted by priority
      const providersRes = await fetch(
        `${SUPABASE_URL}/rest/v1/providers?order=priority.asc`,
        { headers }
      );
      const providers = await providersRes.json();

      let success = false;

      for (const provider of providers) {
        if (!provider.api_url) continue;

        try {
          const response = await fetch(provider.api_url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${VTU_SECRET}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              phone: subscription.phone || subscription.phone_number,
              plan_code: subscription.data_plans?.vtu_code,
              network: provider.api_name,
            }),
          });

          const data = await response.json();

          if (data.success || response.ok) {
            // Mark job success
            await fetch(`${SUPABASE_URL}/rest/v1/vtu_jobs?id=eq.${job.id}`, {
              method: "PATCH",
              headers,
              body: JSON.stringify({
                status: "success",
                provider_used: provider.name,
                updated_at: new Date().toISOString(),
              }),
            });

            // Update subscription to active (data delivered)
            await fetch(
              `${SUPABASE_URL}/rest/v1/subscriptions?id=eq.${subscription.id}`,
              {
                method: "PATCH",
                headers,
                body: JSON.stringify({
                  status: "active",
                  activated_at: new Date().toISOString(),
                  expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
                }),
              }
            );

            // Update provider metrics
            await fetch(
              `${SUPABASE_URL}/rest/v1/provider_metrics?provider_id=eq.${provider.id}`,
              {
                method: "PATCH",
                headers,
                body: JSON.stringify({ success: (provider.success || 0) + 1 }),
              }
            );

            success = true;
            results.push({ job_id: job.id, status: "success", provider: provider.name });
            break;
          }
        } catch (_) {
          // Try next provider
        }
      }

      if (!success) {
        const newAttempts = (job.attempts || 0) + 1;

        if (newAttempts >= 5) {
          // Move to dead letter queue
          await fetch(`${SUPABASE_URL}/rest/v1/vtu_jobs?id=eq.${job.id}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({ status: "failed", attempts: newAttempts }),
          });
          await fetch(`${SUPABASE_URL}/rest/v1/vtu_dead_letter`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              job_id: job.id,
              reason: "Max retry attempts reached",
            }),
          });
        } else {
          await fetch(`${SUPABASE_URL}/rest/v1/vtu_jobs?id=eq.${job.id}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({ status: "retry", attempts: newAttempts }),
          });
        }

        results.push({ job_id: job.id, status: "retry", attempts: newAttempts });
      }
    }

    return new Response(
      JSON.stringify({ processed: results.length, results }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
