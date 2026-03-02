// retryWorker Edge Function — DataEdge / Vortexedge Limited
//
// Flow:
//   1. Fetch all jobs with status = 'retry'
//   2. Reset them to 'queued'
//   3. Trigger vtuProcessor to handle them
//
// Called by:
//   - Supabase cron (pg_cron) — every hour
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

serve(async () => {
  try {
    // Fetch retry jobs
    const jobsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/vtu_jobs?status=eq.retry&attempts=lt.5`,
      { headers }
    );
    const jobs = await jobsRes.json();

    if (!jobs.length) {
      return new Response(
        JSON.stringify({ message: "No retry jobs found" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Reset to queued
    const ids = jobs.map((j: { id: string }) => j.id).join(",");
    await fetch(
      `${SUPABASE_URL}/rest/v1/vtu_jobs?id=in.(${ids})`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status: "queued" }),
      }
    );

    // Trigger vtuProcessor
    await fetch(`${SUPABASE_URL}/functions/v1/vtuProcessor`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    return new Response(
      JSON.stringify({ requeued: jobs.length }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
