/**
 * The External Profiles card on the Identifiers & Profiles tab (#2699): one
 * input per platform, one Save. Every write is `POST /api/edit/field` with
 * `fieldName: "profileLinks"` and the whole object; the server canonicalizes
 * (a pasted `twitter.com/…?s=21` comes back `https://x.com/…`) and names the
 * offending platform on a bad link, which is what the inline error points at.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { EditPanel } from "@/components/edit/edit-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  PROFILE_LINK_PLATFORM_KEYS,
  PROFILE_LINK_PLATFORMS,
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

export function ProfileLinksCard({
  cwid,
  mode,
  scholarName,
  initial,
  subsection = false,
}: ProfileLinksCardProps) {
  const router = useRouter();
  const whose = mode === "superuser" ? `${scholarName}'s` : "your";
  const [values, setValues] = React.useState<Record<ProfileLinkPlatform, string>>(
    () =>
      Object.fromEntries(PROFILE_LINK_PLATFORM_KEYS.map((k) => [k, initial[k] ?? ""])) as Record<
        ProfileLinkPlatform,
        string
      >,
  );
  const [busy, setBusy] = React.useState(false);
  const [badPlatform, setBadPlatform] = React.useState<ProfileLinkPlatform | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

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
          value: values,
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
      const stored = JSON.parse(data.value) as ProfileLinks;
      setValues(
        Object.fromEntries(PROFILE_LINK_PLATFORM_KEYS.map((k) => [k, stored[k] ?? ""])) as Record<
          ProfileLinkPlatform,
          string
        >,
      );
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
      owned
      subsection={subsection}
      slot="profile-links-card"
      description={`Links to ${whose} profiles elsewhere, shown in the Contact card. Paste a URL or a handle; leave a field blank to remove it.`}
    >
      <form onSubmit={submit} className="flex flex-col gap-3" data-testid="profile-links-form">
        {PROFILE_LINK_PLATFORM_KEYS.map((k) => (
          <label key={k} className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{PROFILE_LINK_PLATFORMS[k].label}</span>
            <Input
              value={values[k]}
              onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
              placeholder={PROFILE_LINK_PLATFORMS[k].placeholder}
              aria-invalid={badPlatform === k || undefined}
              className="max-w-xl"
              disabled={busy}
              data-testid={`profile-link-${k}`}
            />
          </label>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" disabled={busy} data-testid="profile-links-save">
            Save
          </Button>
          {saved && !error && (
            <span className="text-muted-foreground text-sm" role="status">
              Saved.
            </span>
          )}
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
