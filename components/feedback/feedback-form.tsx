"use client";

/**
 * The feedback form (#538 PR-2, docs/feedback-badge-spec.md).
 *
 * Mode-aware (contextual vs. generic), Q1-gated, and conditional on
 * usefulness / accuracy / task-success values. Both the **client form
 * and** the server action enforce the gating rules — see
 * `app/api/feedback/submit/route.ts`. The client side is for UX; the
 * server is the source of truth, and silently drops any field a hostile
 * client included that doesn't match its trigger predicate.
 *
 * Conditional reveal logic (mirrored on server):
 *
 *   - mode = generic        → hide Q3-anchor "this page" copy throughout;
 *                              accuracy section hidden entirely
 *   - purpose = browse_unit → accuracy section hidden in both modes
 *   - usefulness ∈ {4,5}    → reveal "what worked well?" inline
 *   - usefulness ∈ {1,2}    → reveal "what was missing?" inline
 *   - accuracy ∈ {1,2,3}    → reveal "what would you change?" inline
 *   - task_success ∈ {no,partially} → reveal "what were you trying to find?"
 *   - willing-to-contact checked + non-WCM persona → reveal email input
 *
 * Sign-in-to-edit callout only renders when (mode = contextual AND
 * pageRoute = "/scholars/[slug]").
 */
import * as React from "react";

import { SignInToEditCallout } from "@/components/feedback/sign-in-to-edit-callout";
import { FeedbackConfirmation } from "@/components/feedback/feedback-confirmation";
import {
  FeedbackMode,
  FeedbackPurpose,
  FeedbackRole,
  FeedbackTaskSuccess,
} from "@/lib/generated/prisma/enums";

type SubmitState = "idle" | "submitting" | "success" | "error";

interface FeedbackFormProps {
  mode: "contextual" | "generic";
  pageUrl: string | null;
  pageRoute: string | null;
  defaultCwid: string | null;
  defaultRole: FeedbackRole | null;
}

/** Q1 values that suppress accuracy regardless of mode. */
const ACCURACY_SUPPRESSED_PURPOSES: ReadonlySet<string> = new Set([FeedbackPurpose.browse_unit]);

export function FeedbackForm({
  mode,
  pageUrl,
  pageRoute,
  defaultCwid,
  defaultRole,
}: FeedbackFormProps) {
  const [purpose, setPurpose] = React.useState<FeedbackPurpose | "">("");
  const [purposeOther, setPurposeOther] = React.useState("");
  const [taskSuccess, setTaskSuccess] = React.useState<FeedbackTaskSuccess | "">("");
  const [taskFailureIntent, setTaskFailureIntent] = React.useState("");
  const [usefulness, setUsefulness] = React.useState<number | null>(null);
  const [usefulnessNA, setUsefulnessNA] = React.useState(false);
  const [whatHelped, setWhatHelped] = React.useState("");
  const [whatMissing, setWhatMissing] = React.useState("");
  const [accuracy, setAccuracy] = React.useState<number | null>(null);
  const [accuracyNA, setAccuracyNA] = React.useState(false);
  const [oneChange, setOneChange] = React.useState("");
  const [wouldUseAgain, setWouldUseAgain] = React.useState<number | null>(null);
  const [role, setRole] = React.useState<FeedbackRole | "">(defaultRole ?? "");
  const [roleOther, setRoleOther] = React.useState("");
  const [cwid, setCwid] = React.useState(defaultCwid ?? "");
  const [contactEmail, setContactEmail] = React.useState("");
  const [followupOptin, setFollowupOptin] = React.useState(false);
  const [consent, setConsent] = React.useState(false);
  const [state, setState] = React.useState<SubmitState>("idle");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  // --- gating predicates (mirror server) ---
  const isContextual = mode === "contextual";
  const showSignInCallout = isContextual && pageRoute === "/scholars/[slug]";
  // Accuracy: hidden in generic mode regardless of Q1; hidden for browse_unit in both modes.
  const showAccuracy = isContextual && !ACCURACY_SUPPRESSED_PURPOSES.has(purpose);
  const showWhatHelped = usefulness === 4 || usefulness === 5;
  const showWhatMissing = usefulness === 1 || usefulness === 2;
  const showOneChange = showAccuracy && (accuracy === 1 || accuracy === 2 || accuracy === 3);
  const showTaskFailureIntent =
    taskSuccess === FeedbackTaskSuccess.no || taskSuccess === FeedbackTaskSuccess.partially;

  // Surfacing the email field only when contact is wanted and the user isn't
  // a WCM-internal persona (CWID covers WCM). The actual server gating is
  // purely on `contact_email` value present-or-NULL — this is UX, not auth.
  const isWcmInternalRole =
    role === FeedbackRole.wcm_faculty ||
    role === FeedbackRole.wcm_trainee ||
    role === FeedbackRole.wcm_staff;
  const showContactEmail = followupOptin && !isWcmInternalRole;

  if (state === "success") {
    return <FeedbackConfirmation returnTo={pageUrl} />;
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!consent) {
      setErrorMessage("Please confirm your consent before submitting.");
      return;
    }
    setState("submitting");
    setErrorMessage(null);

    const formEl = e.currentTarget;
    const honeypot = (formEl.elements.namedItem("website") as HTMLInputElement | null)?.value ?? "";

    const payload = {
      mode,
      page_url: isContextual ? pageUrl : null,
      cwid: cwid.trim() || null,
      contact_email: showContactEmail ? contactEmail.trim() || null : null,
      purpose: purpose || null,
      purpose_other: purpose === FeedbackPurpose.other ? purposeOther : null,
      task_success: taskSuccess || null,
      task_failure_intent: showTaskFailureIntent ? taskFailureIntent : null,
      usefulness: usefulnessNA ? null : usefulness,
      what_helped: showWhatHelped ? whatHelped : null,
      what_missing: showWhatMissing ? whatMissing : null,
      accuracy: showAccuracy && !accuracyNA ? accuracy : null,
      one_change: showOneChange ? oneChange : null,
      would_use_again: wouldUseAgain,
      role: role || null,
      role_other: role === FeedbackRole.other ? roleOther : null,
      consent: true,
      followup_optin: followupOptin,
      website: honeypot,
    };

    try {
      const res = await fetch("/api/feedback/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const respBody = (await res.json().catch(() => ({}))) as { error?: string };
        setErrorMessage(humanizeError(respBody.error ?? "submit_failed"));
        setState("error");
        return;
      }
      setState("success");
    } catch {
      setErrorMessage("We couldn't submit your feedback right now. Please try again in a moment.");
      setState("error");
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {showSignInCallout ? <SignInToEditCallout /> : null}

      {/* Q1 — purpose */}
      <Section label="What brought you to this page today?">
        <RadioColumn
          name="purpose"
          value={purpose}
          onChange={(v) => setPurpose(v as FeedbackPurpose)}
          options={[
            [FeedbackPurpose.lookup_person, "Looking up a specific person"],
            [FeedbackPurpose.lookup_topic, "Looking for experts on a topic"],
            [FeedbackPurpose.browse_unit, "Browsing a department, division, or center"],
            [FeedbackPurpose.research_story, "Researching for a story, article, or grant"],
            [FeedbackPurpose.evaluate_scholars, "Evaluating Scholars itself"],
            [FeedbackPurpose.other, "Other"],
          ]}
        />
        {purpose === FeedbackPurpose.other ? (
          <input
            type="text"
            placeholder="Tell us more (optional, 200 char max)"
            value={purposeOther}
            onChange={(e) => setPurposeOther(e.target.value)}
            maxLength={200}
            className="mt-2 w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none"
          />
        ) : null}
      </Section>

      {/* Q2 — task success */}
      <Section label="Did you find what you were looking for?">
        <RadioColumn
          name="task_success"
          value={taskSuccess}
          onChange={(v) => setTaskSuccess(v as FeedbackTaskSuccess)}
          options={[
            [FeedbackTaskSuccess.yes_completely, "Yes, completely"],
            [FeedbackTaskSuccess.mostly, "Mostly"],
            [FeedbackTaskSuccess.partially, "Partially"],
            [FeedbackTaskSuccess.no, "No"],
            [FeedbackTaskSuccess.not_looking, "I wasn't looking for anything specific"],
          ]}
        />

        {/* Q2a — task-failure intent */}
        {showTaskFailureIntent ? (
          <ConditionalFollowUp
            badge="Let's help next time — tell us what you were after"
            label="What were you trying to find?"
            value={taskFailureIntent}
            onChange={setTaskFailureIntent}
            maxLength={500}
          />
        ) : null}
      </Section>

      {/* Q3 — usefulness Likert */}
      <Section
        label={
          isContextual ? "How useful was this page to you?" : "How useful was Scholars to you overall?"
        }
        help={
          isContextual
            ? "Did the page give you what you needed for whatever brought you here?"
            : "Take your overall experience with Scholars into account."
        }
      >
        <LikertRow
          name="usefulness"
          value={usefulness}
          onChange={(v) => {
            setUsefulness(v);
            setUsefulnessNA(false);
          }}
          labels={["Not at all useful", "Slightly", "Somewhat", "Useful", "Very useful"]}
        />
        <label className="mt-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={usefulnessNA}
            onChange={(e) => {
              setUsefulnessNA(e.target.checked);
              if (e.target.checked) setUsefulness(null);
            }}
            className="accent-[var(--color-primary-cornell-red)]"
          />
          Not applicable
        </label>

        {/* Q3a — what worked (high tail) */}
        {showWhatHelped ? (
          <ConditionalFollowUp
            badge="You rated this highly — tell us what worked"
            label={
              isContextual
                ? "What made this page especially useful?"
                : "What's working well in Scholars?"
            }
            value={whatHelped}
            onChange={setWhatHelped}
            maxLength={500}
          />
        ) : null}

        {/* Q3b — what was missing (low tail) */}
        {showWhatMissing ? (
          <ConditionalFollowUp
            badge="Help us fix it — what didn't work?"
            label={
              isContextual
                ? "What was missing or didn't help on this page?"
                : "What about Scholars isn't working for you?"
            }
            value={whatMissing}
            onChange={setWhatMissing}
            maxLength={500}
          />
        ) : null}
      </Section>

      {/* Q4 — accuracy Likert (contextual + non-browse_unit only) */}
      {showAccuracy ? (
        <Section
          label="How accurate did the information on this page appear?"
          help="Scholars pulls publications, topics, and impact scores from automated systems. We want to know when they're off."
        >
          <LikertRow
            name="accuracy"
            value={accuracy}
            onChange={(v) => {
              setAccuracy(v);
              setAccuracyNA(false);
            }}
            labels={["Very inaccurate", "Somewhat", "Mixed", "Mostly accurate", "Very accurate"]}
          />
          <label className="mt-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={accuracyNA}
              onChange={(e) => {
                setAccuracyNA(e.target.checked);
                if (e.target.checked) setAccuracy(null);
              }}
              className="accent-[var(--color-primary-cornell-red)]"
            />
            Not applicable
          </label>

          {/* Q4a — one change (accuracy low/mixed) */}
          {showOneChange ? (
            <ConditionalFollowUp
              badge="Help us fix it — what's wrong?"
              label="What would you change to make this page more accurate?"
              value={oneChange}
              onChange={setOneChange}
              maxLength={500}
            />
          ) : null}
        </Section>
      ) : null}

      {/* Q5 — would use again (replaces NPS) */}
      <Section label="Would you use Scholars again?">
        <RadioColumn
          name="would_use_again"
          value={wouldUseAgain == null ? "" : String(wouldUseAgain)}
          onChange={(v) => setWouldUseAgain(Number(v))}
          options={[
            ["1", "Definitely not"],
            ["2", "Probably not"],
            ["3", "Unsure"],
            ["4", "Probably"],
            ["5", "Definitely"],
          ]}
        />
      </Section>

      {/* Q6 — role */}
      <Section label="Which best describes you?" optional>
        <RadioColumn
          name="role"
          value={role}
          onChange={(v) => setRole(v as FeedbackRole)}
          options={[
            [FeedbackRole.wcm_faculty, "WCM faculty"],
            [FeedbackRole.wcm_trainee, "WCM postdoc, fellow, or doctoral student"],
            [FeedbackRole.wcm_staff, "WCM staff or administrator"],
            [FeedbackRole.external_researcher, "Visiting researcher or academic (outside WCM)"],
            [FeedbackRole.journalist, "Journalist or communications professional"],
            [FeedbackRole.patient_or_public, "Patient or member of the public"],
            [FeedbackRole.prefer_not_say, "Prefer not to say"],
            [FeedbackRole.other, "Other"],
          ]}
        />
        {role === FeedbackRole.other ? (
          <input
            type="text"
            placeholder="Tell us more (optional, 100 char max)"
            value={roleOther}
            onChange={(e) => setRoleOther(e.target.value)}
            maxLength={100}
            className="mt-2 w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none"
          />
        ) : null}
      </Section>

      {/* Q8 — optional contact + follow-up */}
      <div className="rounded-md border border-border bg-muted/40 p-4">
        <div className="mb-1 text-sm font-semibold">
          Stay anonymous, or leave your contact info{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          Only needed if you&apos;d like us to follow up. Leave blank to submit anonymously.
        </p>
        <input
          type="text"
          placeholder={
            isWcmInternalRole
              ? "CWID (e.g. abc1234) or email"
              : defaultCwid
                ? "Your CWID"
                : "Your CWID (if you have one)"
          }
          value={cwid}
          onChange={(e) => setCwid(e.target.value)}
          maxLength={32}
          autoComplete="off"
          spellCheck={false}
          className="block max-w-[260px] rounded-md border border-input bg-background px-3 py-1.5 text-sm focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none"
        />
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={followupOptin}
            onChange={(e) => setFollowupOptin(e.target.checked)}
            className="mt-0.5 accent-[var(--color-primary-cornell-red)]"
          />
          <span>
            I&apos;d be willing to be contacted for a brief follow-up interview about my experience.
          </span>
        </label>
        {showContactEmail ? (
          <div className="mt-3">
            <label className="mb-1 block text-xs font-medium text-foreground" htmlFor="contact-email">
              How can we reach you? <span className="font-normal text-muted-foreground">(email)</span>
            </label>
            <input
              id="contact-email"
              type="email"
              placeholder="you@example.com"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              maxLength={255}
              autoComplete="off"
              spellCheck={false}
              className="block w-full max-w-[320px] rounded-md border border-input bg-background px-3 py-1.5 text-sm focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none"
            />
          </div>
        ) : null}
      </div>

      {/* Consent (required) */}
      <div className="rounded-md border border-[var(--color-accent-slate)]/30 bg-[var(--color-accent-slate)]/5 p-4">
        <p className="mb-2 text-sm text-foreground/90">
          I understand that my response may be analyzed in aggregate and used in published
          reports about the Scholars Profile System. No personally identifying information
          will be included without my explicit further consent.
        </p>
        <p className="mb-3 text-xs text-muted-foreground">
          Your CWID or email (if provided) is used only to contact you for an optional
          follow-up. It is never included in published reports.
        </p>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-0.5 accent-[var(--color-primary-cornell-red)]"
            required
          />
          <span>
            I agree to the above.{" "}
            <span className="font-semibold text-[var(--color-primary-cornell-red)]">
              (Required to submit)
            </span>
          </span>
        </label>
      </div>

      {/* honeypot — visually hidden, kept in form for bots to fill */}
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute left-[-9999px] h-px w-px overflow-hidden"
      />

      {errorMessage ? (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {errorMessage}
        </div>
      ) : null}

      <div className="flex items-center gap-3 border-t border-border pt-4">
        <span className="flex-1 text-xs text-muted-foreground">Takes under 90 seconds.</span>
        <button
          type="submit"
          disabled={!consent || state === "submitting"}
          className="rounded-md bg-[var(--color-primary-cornell-red)] px-4 py-2 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-[var(--color-primary-cornell-red)]/90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
        >
          {state === "submitting" ? "Submitting…" : "Submit feedback"}
        </button>
      </div>
      {/* Mode-tag preserved for debug; the server validates it on submit. */}
      <input type="hidden" name="mode" value={mode satisfies FeedbackMode} />
    </form>
  );
}

/* --- internal layout helpers (unchanged from PR-2 prior version) --- */

function Section({
  label,
  help,
  optional,
  children,
}: {
  label: string;
  help?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="border-b border-border pb-5">
      <legend className="mb-1 text-sm font-semibold text-foreground">
        {label}
        {optional ? <span className="ml-1 font-normal text-muted-foreground">(optional)</span> : null}
      </legend>
      {help ? <p className="mb-2 text-xs text-muted-foreground">{help}</p> : null}
      {children}
    </fieldset>
  );
}

function RadioColumn<T extends string>({
  name,
  value,
  onChange,
  options,
}: {
  name: string;
  value: T | "";
  onChange: (v: T) => void;
  options: ReadonlyArray<readonly [T, string]>;
}) {
  return (
    <div role="radiogroup" className="flex flex-col gap-1">
      {options.map(([v, label]) => (
        <label
          key={v}
          className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted"
        >
          <input
            type="radio"
            name={name}
            value={v}
            checked={value === v}
            onChange={() => onChange(v)}
            className="mt-0.5 accent-[var(--color-primary-cornell-red)]"
          />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}

function LikertRow({
  name,
  value,
  onChange,
  labels,
}: {
  name: string;
  value: number | null;
  onChange: (v: number) => void;
  labels: readonly [string, string, string, string, string];
}) {
  return (
    <div role="radiogroup" className="grid grid-cols-5 gap-2">
      {labels.map((label, i) => {
        const n = i + 1;
        const selected = value === n;
        return (
          <label
            key={n}
            className={`relative flex cursor-pointer flex-col items-center gap-1 rounded-md border px-2 py-2.5 text-center text-xs transition-colors ${
              selected
                ? "border-[var(--color-primary-cornell-red)] bg-[var(--color-primary-cornell-red)]/5"
                : "border-input hover:bg-muted"
            }`}
          >
            {selected ? (
              <span
                aria-hidden="true"
                className="absolute right-1 top-1 inline-flex size-3.5 items-center justify-center rounded-full bg-[var(--color-primary-cornell-red)] text-[10px] font-bold text-white"
              >
                ✓
              </span>
            ) : null}
            <span className="text-lg font-semibold text-foreground">{n}</span>
            <span className="text-[11px] leading-tight text-muted-foreground">{label}</span>
            <input
              type="radio"
              name={name}
              value={n}
              checked={selected}
              onChange={() => onChange(n)}
              className="sr-only"
            />
          </label>
        );
      })}
    </div>
  );
}

function ConditionalFollowUp({
  badge,
  label,
  value,
  onChange,
  maxLength,
}: {
  badge: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  maxLength: number;
}) {
  return (
    <div className="mt-4 rounded-r-md border-l-[3px] border-[var(--color-primary-cornell-red)] bg-muted/40 px-3 py-3">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-[var(--color-primary-cornell-red)]">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-3"
          aria-hidden="true"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
        <span>{badge}</span>
      </div>
      <label className="block text-sm font-medium">
        {label} <span className="font-normal text-muted-foreground">(optional)</span>
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={maxLength}
        rows={3}
        placeholder="Type your answer…"
        className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none"
      />
      <div className="mt-1 text-right text-[11px] text-muted-foreground">
        {value.length} / {maxLength}
      </div>
    </div>
  );
}

function humanizeError(code: string): string {
  switch (code) {
    case "consent_required":
      return "Please confirm your consent before submitting.";
    case "cross_origin":
      return "Submission rejected — page origin didn't match.";
    case "not_found":
      return "Feedback is not currently enabled on this site.";
    case "bad_text":
      return "One of the text fields contained an invalid character. Please try again.";
    case "invalid_json":
      return "Something went wrong sending the form. Please refresh and try again.";
    default:
      return "We couldn't submit your feedback right now. Please try again in a moment.";
  }
}
