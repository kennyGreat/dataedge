// errorHandler Edge Function — DataEdge / Vortexedge Limited
//
// Central error notification handler for cron jobs and background workers.
//
// Flow:
//   1. Receive an error payload (source, message, context)
//   2. Log it to system_events table
//   3. Send an SMS alert to the admin phone via Termii (if ADMIN_PHONE is set)
//
// Called by:
//   - installmentBilling (on unrecoverable cron failure)
//   - vtuProcessor       (on dead-letter threshold reached)
//   - retryWorker        (on repeated failure)
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TERMII_KEY
// Optional env vars:
//   ADMIN_PHONE — admin phone number to receive SMS alerts

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TERMII_KEY   = Deno.env.get("TERMII_KEY")!;
const ADMIN_PHONE  = Deno.env.get("ADMIN_PHONE") ?? "";

const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

serve(async (req) => {
  try {
    const { source, message, context } = await req.json();

    if (!source || !message) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: source and message" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Persist error in system_events for audit trail
    await fetch(`${SUPABASE_URL}/rest/v1/system_events`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type:    "cron_error",
        payload: { source, message, context: context ?? null },
      }),
    });

    // Send SMS alert to admin (non-blocking, failure does not bubble up)
    if (ADMIN_PHONE) {
      try {
        await fetch("https://api.ng.termii.com/api/sms/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to:      ADMIN_PHONE,
            from:    "DataEdge",
            sms:     `[DataEdge ALERT] ${source}: ${message}`,
            type:    "plain",
            api_key: TERMII_KEY,
          }),
        });
      } catch (_) {
        // SMS failure must not fail the handler
      }
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
