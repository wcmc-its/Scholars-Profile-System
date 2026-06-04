/**
 * "Request a new org unit" dialog (#728 Phase D, `ed-admin-org-unit-roles-spec.md`
 * § 4.6 / § 4.6.1). Surfaced on `/edit/unit/new` for a non-superuser when the
 * `SELF_EDIT_ORG_UNIT_CREATE_SUPERUSER_ONLY` lockdown is on: only superusers
 * create org units, so everyone else asks ITS to route the request.
 *
 * A thin client over the existing #160 mailer. It POSTs the SAME
 * `/api/edit/request-change` endpoint with `attribute: "org-unit"`,
 * `issueId: "request-new-org-unit"`, the proposed unit in `itemId` and the
 * justification in `detail`, and — crucially — **omits `targetCwid`** so the
 * route defaults `target = session.cwid` (§ 4.6.1: the self-gate is satisfied
 * for any authenticated user; the recipient resolves server-side to ITS
 * Support; no route-logic change). On any non-2xx (incl. `503 send_disabled`
 * while the mailer is dark) or a network error it falls back to a composed
 * `mailto:` exactly like the scholar-bound dialog — so the affordance works
 * before `SELF_EDIT_REQUEST_CHANGE_SEND` flips on.
 *
 * NOT scholar-bound: no `cwid` prop, no `targetCwid` in the body. Reusing
 * `request-a-change-dialog.tsx` is impossible (it requires `cwid` and always
 * sends `targetCwid`).
 */
"use client";

import * as React from "react";
import { Building2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  getChangeConfig,
  type RouteAction,
} from "@/lib/edit/request-a-change";

const ATTRIBUTE_LABEL = "Org Unit";
const ISSUE_ID = "request-new-org-unit";

/** Strip CR/LF so a value can't break out of its mail field (injection guard). */
function sanitize(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Compose the Phase-1 `mailto:` fallback (mirrors the scholar dialog). Subject is
 * the fixed attribute label — never user free text, so no header-injection
 * vector. RFC 6068 wants %20, so encode by hand (URLSearchParams renders "+").
 */
function buildMailto(opts: {
  email: string;
  issueLabel: string;
  itemLabel: string;
  detail: string;
}): string {
  const subject = `Scholars profile correction — ${ATTRIBUTE_LABEL}`;
  const lines = [
    `Issue: ${sanitize(opts.issueLabel)}`,
    `Item: ${opts.itemLabel ? sanitize(opts.itemLabel) : "(unnamed unit)"}`,
    "",
    sanitize(opts.detail) || "(no additional detail provided)",
    "",
    "— Sent from the WCM Scholars profile editor.",
  ];
  const parts = [
    `subject=${encodeURIComponent(subject)}`,
    `body=${encodeURIComponent(lines.join("\n"))}`,
  ];
  return `mailto:${opts.email}?${parts.join("&")}`;
}

export function RequestNewOrgUnitDialog() {
  // The single org-unit issue carries the routing config (label + recipient).
  const issue = getChangeConfig("org-unit").issues.find((i) => i.id === ISSUE_ID)!;
  const route = issue.action as RouteAction;

  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [unitType, setUnitType] = React.useState<"department" | "division" | "center">("center");
  const [parent, setParent] = React.useState("");
  const [justification, setJustification] = React.useState("");
  const [submitted, setSubmitted] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [sentVia, setSentVia] = React.useState<"server" | "mailto" | null>(null);

  React.useEffect(() => {
    if (open) {
      setName("");
      setUnitType("center");
      setParent("");
      setJustification("");
      setSubmitted(false);
      setSending(false);
      setSentVia(null);
    }
  }, [open]);

  /** `itemId` = the proposed unit (short label); `detail` = the justification. */
  const itemLabel = `${sanitize(name) || "(unnamed unit)"} (${unitType}${
    parent.trim() ? `, parent: ${sanitize(parent)}` : ""
  })`;
  const canSubmit = name.trim().length > 0;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSending(true);
    try {
      const res = await fetch("/api/edit/request-change", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attribute: "org-unit",
          issueId: ISSUE_ID,
          itemId: itemLabel,
          detail: justification,
          // targetCwid OMITTED — the route defaults it to the session cwid
          // (§ 4.6.1: self-targeted, gate satisfied for any authenticated user).
        }),
      });
      if (res.ok) {
        setSentVia("server");
        setSubmitted(true);
        return;
      }
    } catch {
      // network error — fall through to the mailto: fallback
    } finally {
      setSending(false);
    }
    // Phase-1 fallback: the user's own mail client (works while the mailer is
    // dark, i.e. SELF_EDIT_REQUEST_CHANGE_SEND off → 503).
    window.location.href = buildMailto({
      email: route.email,
      issueLabel: issue.label,
      itemLabel,
      detail: justification,
    });
    setSentVia("mailto");
    setSubmitted(true);
  }

  return (
    <>
      <Button
        type="button"
        variant="apollo"
        data-testid="request-new-org-unit-trigger"
        onClick={() => setOpen(true)}
      >
        <Building2 />
        Request a new org unit
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="request-new-org-unit-dialog">
          <DialogHeader className="gap-1 text-left">
            <DialogTitle>Request a new org unit</DialogTitle>
            <DialogDescription>
              New org units are created by Scholars superusers. Describe the unit and we&apos;ll
              route your request to {route.office}.
            </DialogDescription>
          </DialogHeader>

          {submitted ? (
            <div className="flex flex-col gap-2" role="status" aria-live="polite">
              {sentVia === "server" ? (
                <>
                  <p className="text-base font-medium">Request sent.</p>
                  <p className="text-muted-foreground text-sm">
                    We&apos;ve routed your request to {route.office}. They&apos;ll follow up if they
                    need more detail.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-base font-medium">Thanks — here&apos;s what happens next.</p>
                  <p className="text-muted-foreground text-sm">
                    Your email client should have opened a pre-filled message to {route.office}. If
                    nothing opened, email{" "}
                    <a
                      className="text-apollo-slate underline"
                      href={`mailto:${route.email}`}
                    >
                      {route.email}
                    </a>{" "}
                    directly.
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="rnou-name" className="text-sm font-medium">
                  Unit name{" "}
                  <span className="text-destructive" aria-hidden>
                    *
                  </span>
                </label>
                <Input
                  id="rnou-name"
                  data-testid="rnou-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Division of Computational Biology"
                  required
                  aria-required="true"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="rnou-type" className="text-sm font-medium">
                  Type
                </label>
                <select
                  id="rnou-type"
                  data-testid="rnou-type"
                  className="border-apollo-border-strong bg-background h-9 rounded-md border px-3 text-sm"
                  value={unitType}
                  onChange={(e) =>
                    setUnitType(e.target.value as "department" | "division" | "center")
                  }
                >
                  <option value="center">Center / institute</option>
                  <option value="division">Division</option>
                  <option value="department">Department</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="rnou-parent" className="text-sm font-medium">
                  Parent department (optional)
                </label>
                <Input
                  id="rnou-parent"
                  data-testid="rnou-parent"
                  value={parent}
                  onChange={(e) => setParent(e.target.value)}
                  placeholder="e.g. Medicine, or an N-code"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="rnou-detail" className="text-sm font-medium">
                  Justification / details (optional)
                </label>
                <Textarea
                  id="rnou-detail"
                  data-testid="rnou-detail"
                  value={justification}
                  onChange={(e) => setJustification(e.target.value)}
                  placeholder="Why is this unit needed? Any codes or context."
                  rows={3}
                />
              </div>
            </div>
          )}

          <DialogFooter>
            {submitted ? (
              <Button type="button" variant="apollo" onClick={() => setOpen(false)}>
                Done
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="apollo"
                  data-testid="rnou-submit"
                  disabled={sending || !canSubmit}
                  onClick={handleSubmit}
                >
                  {sending ? "Sending…" : "Submit request"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
