/**
 * POST /api/feedback/submit — write one `feedback_submission` row
 * (#538, docs/feedback-badge-spec.md PR-2).
 *
 * Server-side enforcement of the conditional rules so a hostile client
 * cannot stuff prose into a non-qualifying row:
 *
 *   - mode = "generic"  → accuracy + one_change forced NULL regardless
 *                         of payload; usefulness still accepted (diffuse
 *                         "Scholars overall" reading is meaningful)
 *   - purpose = browse_unit → accuracy + one_change forced NULL
 *   - usefulness ∉ {4,5} → what_helped forced NULL
 *   - usefulness ∉ {1,2} → what_missing forced NULL
 *   - accuracy ∉ {1,2,3} → one_change forced NULL
 *   - task_success ∉ {no, partially} → task_failure_intent forced NULL
 *
 * Honeypot: a non-empty `website` field → respond 200 with no DB write
 * (don't tell the bot it failed). Same-origin: `Origin` header must
 * match `FEEDBACK_SITE_ORIGIN` / `NEXT_PUBLIC_SITE_URL`.
 */
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";
import { CURRENT_CONSENT_VERSION } from "@/lib/feedback/consent";
import { normalizeUserCwid } from "@/lib/feedback/cwid";
import { urlToPageRoute } from "@/lib/feedback/page-route";
import { sanitizeFreeText } from "@/lib/feedback/sanitize";
import { getAllowedOrigins, validateSameOriginUrl } from "@/lib/feedback/same-origin";
import {
  FeedbackMode,
  FeedbackPurpose,
  FeedbackRole,
  FeedbackTaskSuccess,
} from "@/lib/generated/prisma/client";

export const dynamic = "force-dynamic";

/** Free-text bounds (mirrors SPEC § Sanitization). */
const BOUND = {
  purpose_other: 200,
  task_failure_intent: 500,
  what_helped: 500,
  what_missing: 500,
  one_change: 500,
  role_other: 100,
  contact_email: 255,
} as const;

/** Minimal email-shape check: must have an `@` with at least one char before and a `.` after. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidPurpose(v: unknown): v is FeedbackPurpose {
  return typeof v === "string" && (Object.values(FeedbackPurpose) as string[]).includes(v);
}
function isValidTaskSuccess(v: unknown): v is FeedbackTaskSuccess {
  return typeof v === "string" && (Object.values(FeedbackTaskSuccess) as string[]).includes(v);
}
function isValidRole(v: unknown): v is FeedbackRole {
  return typeof v === "string" && (Object.values(FeedbackRole) as string[]).includes(v);
}
function isValidMode(v: unknown): v is FeedbackMode {
  return v === FeedbackMode.contextual || v === FeedbackMode.generic;
}

function clampLikert5(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseInt(v, 10) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

function err(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}

function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const allowed = getAllowedOrigins(process.env);
  if (allowed.length === 0) return false;
  try {
    const u = new URL(origin);
    return allowed.includes(`${u.protocol}//${u.host}`);
  } catch {
    return false;
  }
}

function normalizeEmail(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.length > BOUND.contact_email) return null;
  return EMAIL_PATTERN.test(trimmed) ? trimmed : null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Feature flag — endpoint behaves as if it doesn't exist when off.
  if (process.env.FEEDBACK_BADGE_ENABLED !== "on") {
    return err(404, "not_found");
  }
  if (!isSameOrigin(request)) {
    return err(403, "cross_origin");
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return err(400, "invalid_json");
  }

  // Honeypot — silent 200, no row.
  if (typeof body.website === "string" && body.website.trim().length > 0) {
    return NextResponse.json({ ok: true });
  }

  if (body.consent !== true) {
    return err(400, "consent_required");
  }

  const mode: FeedbackMode = isValidMode(body.mode) ? body.mode : FeedbackMode.generic;

  // --- enums ---
  const purpose = isValidPurpose(body.purpose) ? body.purpose : null;
  const taskSuccess = isValidTaskSuccess(body.task_success) ? body.task_success : null;
  const role = isValidRole(body.role) ? body.role : null;

  // --- free text ---
  const purposeOther = sanitizeFreeText(body.purpose_other as string | null | undefined, BOUND.purpose_other);
  if (!purposeOther.ok) return err(400, "bad_text");
  const taskFailureIntentRaw = sanitizeFreeText(
    body.task_failure_intent as string | null | undefined,
    BOUND.task_failure_intent,
  );
  if (!taskFailureIntentRaw.ok) return err(400, "bad_text");
  const whatHelpedRaw = sanitizeFreeText(body.what_helped as string | null | undefined, BOUND.what_helped);
  if (!whatHelpedRaw.ok) return err(400, "bad_text");
  const whatMissingRaw = sanitizeFreeText(body.what_missing as string | null | undefined, BOUND.what_missing);
  if (!whatMissingRaw.ok) return err(400, "bad_text");
  const oneChangeRaw = sanitizeFreeText(body.one_change as string | null | undefined, BOUND.one_change);
  if (!oneChangeRaw.ok) return err(400, "bad_text");
  const roleOther = sanitizeFreeText(body.role_other as string | null | undefined, BOUND.role_other);
  if (!roleOther.ok) return err(400, "bad_text");

  // --- Likerts ---
  const usefulness = clampLikert5(body.usefulness);
  const accuracyRaw = clampLikert5(body.accuracy);
  const wouldUseAgain = clampLikert5(body.would_use_again);

  // --- mode + Q1 gating for accuracy (SPEC § Q1 as the branching key) ---
  // Generic mode: accuracy hidden regardless of Q1.
  // browse_unit: accuracy hidden in both modes.
  const accuracyAllowed = mode === FeedbackMode.contextual && purpose !== FeedbackPurpose.browse_unit;
  const accuracy = accuracyAllowed ? accuracyRaw : null;

  // --- conditional enforcement (SPEC § Conditional follow-ups) ---
  const taskFailureIntent =
    taskSuccess === FeedbackTaskSuccess.no || taskSuccess === FeedbackTaskSuccess.partially
      ? taskFailureIntentRaw.value
      : null;
  const whatHelped = usefulness === 4 || usefulness === 5 ? whatHelpedRaw.value : null;
  const whatMissing = usefulness === 1 || usefulness === 2 ? whatMissingRaw.value : null;
  const oneChange =
    accuracy === 1 || accuracy === 2 || accuracy === 3 ? oneChangeRaw.value : null;

  // --- page URL + route ---
  const pageUrl =
    mode === FeedbackMode.contextual
      ? validateSameOriginUrl(body.page_url as string | null | undefined)
      : null;
  const pageRoute = pageUrl ? urlToPageRoute(pageUrl) : null;

  // --- optional contact ---
  const cwid = normalizeUserCwid(body.cwid as string | null | undefined);
  const contactEmail = normalizeEmail(body.contact_email);
  const followupOptin = body.followup_optin === true;

  await db.write.feedbackSubmission.create({
    data: {
      mode,
      pageUrl,
      pageRoute,
      cwid,
      purpose,
      purposeOther: purposeOther.value,
      taskSuccess,
      taskFailureIntent,
      usefulness,
      whatHelped,
      whatMissing,
      accuracy,
      oneChange,
      wouldUseAgain,
      role,
      roleOther: roleOther.value,
      consent: true,
      consentVersion: CURRENT_CONSENT_VERSION,
      contactEmail,
      followupOptin,
    },
  });

  return NextResponse.json({ ok: true });
}
