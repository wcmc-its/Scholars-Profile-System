/**
 * The External Profiles card on the Identifiers & Profiles tab (#2699): one
 * input per platform in a two-up grid, each labelled with its host prefix so
 * the field shows and asks for just the handle — a pasted full URL is reduced
 * to it on blur, and the stored canonical URL is shown the same way. One Save,
 * inert until a field differs from what the server last stored. Every write is
 * `POST /api/edit/field` with `fieldName: "profileLinks"` and the whole object
 * (each handle sent with its prefix put back, so the server parses what a
 * paste would have given it); the server canonicalizes and names the
 * offending platform on a bad link, which is what the inline error points at.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { EditPanel, OwnedBadge } from "@/components/edit/edit-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  PROFILE_LINK_PLATFORM_KEYS,
  PROFILE_LINK_PLATFORMS,
  profileLinkHandle,
  profileLinkInput,
  type ProfileLinkPlatform,
  type ProfileLinks,
} from "@/lib/edit/profile-links";

export type ProfileLinksCardProps = {
  cwid: string;
  /** "self" → second person; "superuser" → third person with the scholar's name. */
  mode: "self" | "superuser";
  scholarName: string;
  initial: ProfileLinks;
  /** True when another card on the tab already owns the `panel-heading` id. */
  subsection?: boolean;
};

type Values = Record<ProfileLinkPlatform, string>;

/** Stored canonical URLs → the handles the fields show. */
const toValues = (links: ProfileLinks): Values =>
  Object.fromEntries(
    PROFILE_LINK_PLATFORM_KEYS.map((k) => [k, profileLinkHandle(k, links[k] ?? "")]),
  ) as Values;

export function ProfileLinksCard({
  cwid,
  mode,
  scholarName,
  initial,
  subsection = false,
}: ProfileLinksCardProps) {
  const router = useRouter();
  const whose = mode === "superuser" ? `${scholarName}'s` : "your";
  const normalize = (k: ProfileLinkPlatform) =>
    setValues((v) => ({ ...v, [k]: profileLinkHandle(k, v[k]) }));
  const [values, setValues] = React.useState<Values>(() => toValues(initial));
  // What the server last acknowledged; Save is inert until the inputs differ.
  const [baseline, setBaseline] = React.useState<Values>(values);
  const [busy, setBusy] = React.useState(false);
  const [badPlatform, setBadPlatform] = React.useState<ProfileLinkPlatform | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const dirty = PROFILE_LINK_PLATFORM_KEYS.some((k) => values[k] !== baseline[k]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBadPlatform(null);
    setSaved(false);
    setBusy(true);
    try {
      const res = await fetch("/api/edit/field", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "scholar",
          entityId: cwid,
          fieldName: "profileLinks",
          value: Object.fromEntries(
            PROFILE_LINK_PLATFORM_KEYS.map((k) => [k, profileLinkInput(k, values[k])]),
          ),
        }),
      });
      const data = (await res.json()) as
        | { ok: true; value: string }
        | { ok: false; error: string; field?: string };
      if (!res.ok || data.ok !== true) {
        const field = "field" in data ? data.field : undefined;
        if (
          data.ok === false &&
          data.error === "invalid_link" &&
          field &&
          Object.hasOwn(PROFILE_LINK_PLATFORMS, field)
        ) {
          const p = field as ProfileLinkPlatform;
          setBadPlatform(p);
          setError(`That doesn't look like a ${PROFILE_LINK_PLATFORMS[p].label} profile link.`);
        } else if (
          data.ok === false &&
          (data.error === "not_self" || data.error === "proxy_conflict")
        ) {
          setError("You can't edit this scholar's profile links.");
        } else {
          setError("Couldn't save the links. Try again.");
        }
        return;
      }
      // Reflect the server's canonical form so the inputs show what was stored.
      const stored = toValues(JSON.parse(data.value) as ProfileLinks);
      setValues(stored);
      setBaseline(stored);
      setSaved(true);
      router.refresh();
    } catch {
      setError("Couldn't save the links. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <EditPanel
      heading="External profiles"
      headerAction={<OwnedBadge />}
      // A peer of the ORCID card (same weight), not an eyebrow under it; it just
      // can't reuse the `panel-heading` id the first card owns.
      headingId={subsection ? "profile-links-heading" : undefined}
      slot="profile-links-card"
      description={`Shown in the Contact card on ${whose} public profile. Paste a full URL or just the handle; clear a field to remove the link.`}
    >
      <form onSubmit={submit} className="flex flex-col gap-4" data-testid="profile-links-form">
        <div className="grid gap-x-5 gap-y-4 md:grid-cols-2">
          {PROFILE_LINK_PLATFORM_KEYS.map((k) => (
            <label key={k} className="flex flex-col gap-1.5 text-sm">
              <span className="flex items-baseline gap-1.5 font-medium">
                {PROFILE_LINK_PLATFORMS[k].label}
                <span className="text-muted-foreground truncate text-xs font-normal">
                  {PROFILE_LINK_PLATFORMS[k].hint}
                </span>
              </span>
              <Input
                value={values[k]}
                onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
                onBlur={() => normalize(k)}
                placeholder={PROFILE_LINK_PLATFORMS[k].placeholder}
                aria-invalid={badPlatform === k || undefined}
                disabled={busy}
                data-testid={`profile-link-${k}`}
              />
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t pt-4">
          <Button
            type="submit"
            variant="apollo"
            size="sm"
            disabled={busy || !dirty}
            data-testid="profile-links-save"
          >
            Save external profiles
          </Button>
          <span
            className="text-muted-foreground text-sm"
            role="status"
            data-testid="profile-links-hint"
          >
            {dirty ? "Unsaved changes" : saved ? "Saved just now" : "No changes yet"}
          </span>
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm" data-testid="profile-links-error">
            {error}
          </p>
        )}
      </form>
    </EditPanel>
  );
}
