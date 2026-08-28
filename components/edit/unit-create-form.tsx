/**
 * UnitCreateForm — the `/edit/unit/new` create form (#540 Phase 7,
 * `unit-curation-edit-ui-spec.md` § The create form). One route, two modes
 * (`center` | `division`) selected by a segmented control that is only shown to
 * a Superuser — an Owner can create informal centers only and sees the center
 * form with no toggle.
 *
 * - **center** (Owner of the parent dept, or Superuser): name + slug + parent
 *   department + center type. An Owner's parent department is fixed (read-only,
 *   from `?dept=`) and the center type is locked to `center`; a Superuser picks
 *   the department and may choose `institute`. For a Superuser the department
 *   can be OMITTED (#2541) — it scopes who may edit the center rather than
 *   placing it in a hierarchy (`Center` has no parent column), so a
 *   cross-campus center is created with none. That omission is an explicit
 *   checkbox, never a blank field: the picker can show typed-but-unselected
 *   text, so "blank" would be an ambiguous signal.
 * - **division** (Superuser only): a pre-registered LDAP N-code + name + slug +
 *   parent department. The form does not look the code up — that's the point
 *   (pre-registration before LDAP catches up).
 *
 * Submit POSTs `/api/edit/unit` op:"create"; on success it routes to the new
 * unit's editor at `?attr=description` (the create form omits a description
 * field — the redirect lands on the description editor, and the create endpoint
 * does not accept one). Format validation reuses the server's validators
 * (`validateUnitName` / `validateSlugFormat` / `validateLdapCode`); a slug/code
 * collision is reported by the server on submit.
 *
 * A successful create REPLACES the form with a success panel naming the unit
 * and linking to its editor (#2545). Previously this relied on a `router.push`
 * redirect, which left the operator on a populated form with no signal when it
 * failed to commit; clicking Create again returned `slug_taken`, which reads as
 * failure and invites a DUPLICATE under a different slug.
 *
 * The push is now gone entirely (#2546): `dirty` is always true at submit here,
 * so UnsavedChangesGuard's disarm cleanup fired `history.back()` and ate the
 * navigation on every create. The panel is the landing, not a fallback.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { DepartmentPicker, type DepartmentOption } from "@/components/edit/department-picker";
import { UnsavedChangesGuard } from "@/components/edit/unsaved-changes-guard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  validateLdapCode,
  validateSlugFormat,
  validateUnitName,
} from "@/lib/edit/validators";

type Mode = "center" | "division";

/** The post-create destination — where the success panel sends the operator. */
function unitEditorHref(mode: Mode, code: string): string {
  return `/edit/${mode}/${encodeURIComponent(code)}?attr=description`;
}

export type UnitCreateFormProps = {
  initialMode: Mode;
  /** A Superuser can create both kinds and sees the mode toggle. */
  canSwitchMode: boolean;
  isSuperuser: boolean;
  /** The full department list for the Superuser picker (empty for an Owner). */
  departments: ReadonlyArray<DepartmentOption>;
  /** An Owner's fixed parent department (read-only); null for a Superuser. */
  fixedDept: DepartmentOption | null;
};

export function UnitCreateForm({
  initialMode,
  canSwitchMode,
  isSuperuser,
  departments,
  fixedDept,
}: UnitCreateFormProps) {

  const [mode, setMode] = React.useState<Mode>(initialMode);
  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [code, setCode] = React.useState("");
  const [centerType, setCenterType] = React.useState<"center" | "institute">("center");
  const [dept, setDept] = React.useState<DepartmentOption | null>(fixedDept);
  const [noParentDept, setNoParentDept] = React.useState(false);

  const [submitting, setSubmitting] = React.useState(false);
  const [done, setDone] = React.useState(false);
  /** The code the server minted — held so the success panel can build the
   *  editor href for it (#2545). */
  const [createdCode, setCreatedCode] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Move focus to the success panel when it replaces the form, so a screen
  // reader lands on the confirmation (and its link) rather than on nothing.
  const successRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (done) successRef.current?.focus();
  }, [done]);

  const [cancelHref, setCancelHref] = React.useState("/edit/scholars");
  React.useEffect(() => {
    const ref = document.referrer;
    if (ref && ref.startsWith(window.location.origin)) {
      const path = ref.slice(window.location.origin.length);
      if (path && path !== window.location.pathname + window.location.search) setCancelHref(path);
    }
  }, []);

  // Effective parent department: the Owner's fixed dept, or the Superuser's pick.
  const effectiveDept = isSuperuser ? dept : fixedDept;

  // A center's dept is only the authz key (#2541) and a Superuser needs none;
  // a division's is a real FK, and an Owner's is what admits them — neither may
  // opt out. The opt-out is a deliberate tick rather than an empty picker: the
  // picker holds its typed query internally, so an empty `dept` can mean either
  // "none" or "typed a name and never picked it".
  const canOmitDept = mode === "center" && isSuperuser;
  const omitDept = canOmitDept && noParentDept;

  const nameOk = validateUnitName(name).ok;
  const slugOk = validateSlugFormat(slug).ok;
  const codeOk = mode === "division" ? validateLdapCode(code).ok : true;
  const deptOk = omitDept || effectiveDept !== null;
  const canSubmit = !submitting && nameOk && slugOk && codeOk && deptOk;

  const dirty = !done && (name.length > 0 || slug.length > 0 || code.length > 0);

  function clearError() {
    if (error) setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // The second clause is what `deptOk` already enforces, kept as its own gate
    // so nothing can submit a department-less body without the explicit tick.
    if (!canSubmit || (effectiveDept === null && !omitDept)) return;
    setSubmitting(true);
    setError(null);
    try {
      const body =
        mode === "center"
          ? {
              op: "create",
              unitType: "center",
              name: validateUnitName(name).ok ? name.trim() : name,
              slug: slug.trim(),
              // Explicit `null` = no parent; the endpoint reads an absent key
              // the same way, but never accepts "".
              deptCode: effectiveDept?.code ?? null,
              centerType,
            }
          : {
              op: "create",
              unitType: "division",
              code: code.trim().toUpperCase(),
              name: name.trim(),
              slug: slug.trim(),
              deptCode: effectiveDept?.code ?? null,
            };
      const res = await fetch("/api/edit/unit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as
        | { ok: true; code: string; slug: string }
        | { ok: false; error: string; field?: string };
      if (!res.ok || data.ok !== true) {
        setError(mapErrorToMessage("error" in data ? data.error : ""));
        return;
      }
      // Deliberately NO `router.push` here (#2546). This form's `dirty` is
      // always true at submit — a valid name is required — so
      // UnsavedChangesGuard has always pushed its history sentinel, and its
      // disarm cleanup fires `history.back()` the instant `done` flips. That
      // pop raced, and reliably beat, the push: measured on staging, the
      // redirect was eaten on every create. Rather than operate on a guard
      // mounted by five other /edit forms to rescue a navigation nobody has
      // ever actually received, the success panel below IS the landing.
      setDone(true);
      setCreatedCode(data.code);
    } catch {
      setError(mapErrorToMessage(""));
    } finally {
      setSubmitting(false);
    }
  }

  // Success REPLACES the form (#2545). This panel is the ONLY success path —
  // a plain statement that the unit exists plus a real link to its editor.
  // Because the form is gone, the double-submit that produced a misleading
  // `slug_taken` cannot happen.
  if (done && createdCode) {
    const unitNoun =
      mode === "division" ? "Division" : centerType === "institute" ? "Institute" : "Center";
    const createdName = name.trim() || slug.trim();
    return (
      <div
        ref={successRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className="border-apollo-border-strong bg-apollo-surface flex max-w-xl flex-col gap-3 rounded-md border p-5"
        data-testid="create-success"
      >
        <h2 className="text-base font-medium">{unitNoun} created</h2>
        <p className="text-muted-foreground text-sm">
          <span className="text-foreground font-medium">{createdName}</span> was created. Opening
          its editor now — if this page doesn&apos;t move, use the link below.
        </p>
        {/* Deliberately a bare <a>, NOT next/link: this link exists BECAUSE a
            soft nav failed, so routing it through the same App Router
            machinery would reproduce the hang it is the escape hatch for. */}
        <a
          href={unitEditorHref(mode, createdCode)}
          className="text-apollo-slate text-sm underline"
          data-testid="create-success-link"
        >
          Go to {createdName}
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex max-w-xl flex-col gap-5" data-testid="unit-create-form">
      <UnsavedChangesGuard dirty={dirty} />

      {canSwitchMode && (
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium">What are you creating?</label>
          <RadioGroup
            value={mode}
            onValueChange={(v) => {
              setMode(v as Mode);
              // A division's dept is required, so the opt-out resets with the
              // mode rather than carrying a stale tick into the other form.
              setNoParentDept(false);
              clearError();
            }}
            className="flex gap-4"
          >
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="center" data-testid="create-mode-center" /> Center / institute
            </label>
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="division" data-testid="create-mode-division" /> Division (LDAP code)
            </label>
          </RadioGroup>
        </div>
      )}

      {mode === "division" && (
        <div className="flex flex-col gap-1">
          <label htmlFor="create-code" className="text-sm font-medium">
            LDAP N-code
          </label>
          <Input
            id="create-code"
            value={code}
            onChange={(e) => {
              setCode(e.target.value.toUpperCase());
              clearError();
            }}
            placeholder="N1280"
            autoComplete="off"
            spellCheck={false}
            data-testid="create-code"
          />
          <p className="text-muted-foreground text-xs">
            Pre-registers a division before the directory catches up. Format: N followed by 2–8
            letters or digits.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor="create-name" className="text-sm font-medium">
          Name
        </label>
        <Input
          id="create-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            clearError();
          }}
          autoComplete="off"
          data-testid="create-name"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="create-slug" className="text-sm font-medium">
          URL segment
        </label>
        <Input
          id="create-slug"
          value={slug}
          onChange={(e) => {
            setSlug(e.target.value);
            clearError();
          }}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={slug.length > 0 && !slugOk}
          data-testid="create-slug"
        />
        {slug.length > 0 && !slugOk && (
          <p className="text-destructive text-xs" data-testid="create-slug-error">
            Use lowercase letters, numbers, and hyphens only — no leading or trailing hyphen, no
            double hyphens.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium">Parent department</label>
        {isSuperuser ? (
          <DepartmentPicker
            // Remounting on the opt-out clears the picker's own typed query, so
            // a disabled field can never keep showing a name it never selected.
            key={omitDept ? "no-parent" : "pick-parent"}
            departments={departments}
            value={dept}
            onChange={(d) => {
              setDept(d);
              clearError();
            }}
            placeholder={omitDept ? "No parent department" : undefined}
            disabled={omitDept}
            idPrefix="create-dept"
          />
        ) : (
          <div
            className="border-apollo-border-strong bg-apollo-surface text-muted-foreground rounded-md border px-3 py-2 text-sm"
            data-testid="create-dept-fixed"
          >
            {fixedDept ? (
              <>
                <span className="text-foreground font-medium">{fixedDept.name}</span> · {fixedDept.code}
              </>
            ) : (
              "—"
            )}
          </div>
        )}
        {canOmitDept && (
          <>
            <label className="mt-1 flex items-center gap-2 text-sm">
              <Checkbox
                id="create-dept-none"
                aria-describedby="create-dept-none-note"
                checked={noParentDept}
                onCheckedChange={(c) => {
                  const on = c === true;
                  setNoParentDept(on);
                  // The tick IS the choice — drop whatever was picked.
                  if (on) setDept(null);
                  clearError();
                }}
                data-testid="create-dept-none"
              />
              No parent department (cross-campus initiative)
            </label>
            <p
              id="create-dept-none-note"
              className="text-muted-foreground text-xs"
              data-testid="create-dept-none-note"
            >
              Scopes who can edit this center — it is not a parent in the hierarchy (a center has no
              parent unit). Tick the box for a cross-campus center that belongs to no department.
            </p>
          </>
        )}
      </div>

      {mode === "center" && (
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium">Type</label>
          <RadioGroup
            value={centerType}
            onValueChange={(v) => {
              setCenterType(v as "center" | "institute");
              clearError();
            }}
            className="flex gap-4"
          >
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="center" data-testid="create-type-center" /> Center
            </label>
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem
                value="institute"
                disabled={!isSuperuser}
                data-testid="create-type-institute"
              />{" "}
              Institute
            </label>
          </RadioGroup>
          {!isSuperuser && (
            <p className="text-muted-foreground text-xs">
              Only a superuser can designate an institute.
            </p>
          )}
        </div>
      )}

      {error && (
        <Alert variant="destructive" data-testid="create-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" variant="apollo" disabled={!canSubmit} data-testid="create-submit">
          {submitting ? "Creating…" : "Create"}
        </Button>
        <Link
          href={cancelHref}
          className="text-muted-foreground hover:text-foreground text-sm"
          data-testid="create-cancel"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}

function mapErrorToMessage(code: string): string {
  switch (code) {
    case "slug_taken":
    case "collision":
      return "That URL segment is already in use. Choose another.";
    case "code_taken":
      return "That LDAP code is already registered as a division.";
    case "invalid_code":
      return "Enter a valid LDAP code — N followed by 2–8 letters or digits.";
    case "name_too_long":
    case "invalid_name":
      return "Enter a name (up to 255 characters).";
    case "reserved_slug":
      return "That URL segment is reserved — choose another.";
    case "dept_not_found":
    case "invalid_dept_code":
      return "That parent department couldn't be found. Choose another.";
    case "invalid_center_type":
      return "That center type isn't allowed.";
    case "not_superuser":
      return "You don't have permission to create this unit.";
    default:
      return "Something went wrong — the unit wasn't created. Please try again.";
  }
}
