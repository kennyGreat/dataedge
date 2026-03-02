// activatePlan Edge Function — DataEdge / Vortexedge Limited
//
// Called when a subscription is fully paid to trigger data delivery.
// This is a wrapper that ensures VTU job is queued and vtuProcessor runs.
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
    const { subscription_id } = await req.json();

    if (!subscription_id) {
      return new Response(
        JSON.stringify({ error: "subscription_id is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Verify subscription is completed
    const subRes = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?id=eq.${subscription_id}`,
      { headers }
    );
    const sub = (await subRes.json())[0];

    if (!sub) {
      return new Response(
        JSON.stringify({ error: "Subscription not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    if (sub.status !== "completed") {
      return new Response(
        JSON.stringify({ error: "Subscription not yet fully paid", status: sub.status }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Check if VTU job already queued
    const existingJobRes = await fetch(
      `${SUPABASE_URL}/rest/v1/vtu_jobs?subscription_id=eq.${subscription_id}`,
      { headers }
    );
    const existingJobs = await existingJobRes.json();

    let jobId: string;

    if (existingJobs.length === 0) {
      // Queue VTU delivery
      const newJobRes = await fetch(`${SUPABASE_URL}/rest/v1/vtu_jobs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          subscription_id,
          provider_priority: 1,
          status: "queued",
          attempts: 0,
        }),
      });
      const newJob = (await newJobRes.json())[0];
      jobId = newJob?.id;
    } else {
      jobId = existingJobs[0].id;
    }

    // Trigger VTU processor
    await fetch(`${SUPABASE_URL}/functions/v1/vtuProcessor`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    return new Response(
      JSON.stringify({
        status: "ok",
        message: "Plan activation triggered",
        subscription_id,
        vtu_job_id: jobId,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
