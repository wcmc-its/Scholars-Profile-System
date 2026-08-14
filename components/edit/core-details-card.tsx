/**
 * CoreDetailsCard — the `Core.description` / `Core.url` / `Core.visible`
 * editor (cores-as-org-units P3). All three are plain in-row columns on
 * `Core` (no `field_override` layer, mirroring how a Center edits its own
 * description/url in-row) — description and URL are Save-gated text fields,
 * visibility is an immediate-POST toggle, all three POST
 * `/api/edit/core` (`{ coreId, action, ... }`).
 *
 * Authz is enforced server-side (Owner/Curator/Superuser of the core, the
 * same check the claim queue page uses); this card is only ever rendered for
 * an actor who already passed that gate.
 */
"use client";

import * as React from "react";
import { Check } from "lucide-react";

import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** Matches `validateUnitDescription`'s cap (manual-layer ≤ 4,000). */
const DESCRIPTION_MAX_CHARS = 4000;
/** Matches `validateUnitUrl`'s cap (the `Core.url @db.VarChar(512)` column). */
const URL_MAX_CHARS = 512;

export type CoreDetailsCardProps = {
  coreId: string;
  description: string | null;
  url: string | null;
  visible: boolean;
};

async function postCore(
  coreId: string,
  action: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/edit/core", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coreId, action, ...payload }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    return { ok: res.ok && data.ok === true, error: data.error };
  } catch {
    return { ok: false };
  }
}

export function CoreDetailsCard({ coreId, description, url, visible }: CoreDetailsCardProps) {
  const descInitial = description ?? "";
  const [desc, setDesc] = React.useState(descInitial);
  const [descSaved, setDescSaved] = React.useState(descInitial);
  const [descSavedFlag, setDescSavedFlag] = React.useState(false);
  const descDirty = desc !== descSaved;
  const descOverLimit = desc.length > DESCRIPTION_MAX_CHARS;

  const urlInitial = url ?? "";
  const [urlValue, setUrlValue] = React.useState(urlInitial);
  const [urlSaved, setUrlSaved] = React.useState(urlInitial);
  const [urlSavedFlag, setUrlSavedFlag] = React.useState(false);
  const urlDirty = urlValue !== urlSaved;
  const urlOverLimit = urlValue.length > URL_MAX_CHARS;

  const [isVisible, setIsVisible] = React.useState(visible);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function saveDescription() {
    if (!descDirty || descOverLimit || busy) return;
    setBusy(true);
    setError(null);
    const res = await postCore(coreId, "set_description", { description: desc });
    if (res.ok) {
      setDescSaved(desc);
      setDescSavedFlag(true);
    } else {
      setError(mapErrorToMessage(res.error ?? ""));
    }
    setBusy(false);
  }

  async function saveUrl() {
    if (!urlDirty || urlOverLimit || busy) return;
    setBusy(true);
    setError(null);
    const res = await postCore(coreId, "set_url", { url: urlValue });
    if (res.ok) {
      setUrlSaved(urlValue);
      setUrlSavedFlag(true);
    } else {
      setError(mapErrorToMessage(res.error ?? ""));
    }
    setBusy(false);
  }

  async function toggleVisible(next: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await postCore(coreId, "set_visible", { visible: next });
    if (res.ok) {
      setIsVisible(next);
    } else {
      setError(mapErrorToMessage(res.error ?? ""));
    }
    setBusy(false);
  }

  return (
    <EditPanel
      slot="core-details-card"
      headingId="core-details-heading"
      heading="Details"
      description="This core facility's public description, website, and listing visibility."
      headerAction={
        <Badge
          variant="outline"
          className="bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border rounded-full"
          data-testid="core-visible-badge"
        >
          {isVisible ? "Visible" : "Hidden"}
        </Badge>
      }
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Description</span>
          <Textarea
            aria-label="Core description"
            value={desc}
            rows={4}
            onChange={(e) => {
              setDesc(e.target.value);
              if (descSavedFlag) setDescSavedFlag(false);
              if (error) setError(null);
            }}
            data-testid="core-description-input"
          />
          <div className="flex items-center justify-between gap-3">
            <span
              aria-live="polite"
              className={cn(
                "text-xs tabular-nums",
                descOverLimit ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {desc.length.toLocaleString()}/{DESCRIPTION_MAX_CHARS.toLocaleString()}
            </span>
            <div className="flex items-center gap-3">
              {descSavedFlag && (
                <span
                  role="status"
                  aria-live="polite"
                  className="text-apollo-green inline-flex items-center gap-1 text-sm"
                >
                  <Check className="size-4" />
                  Saved
                </span>
              )}
              <Button
                type="button"
                variant="apollo"
                disabled={!descDirty || descOverLimit || busy}
                onClick={saveDescription}
                data-testid="core-description-save"
              >
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Website</span>
          <Input
            type="text"
            aria-label="Core website URL"
            value={urlValue}
            placeholder="https://…"
            onChange={(e) => {
              setUrlValue(e.target.value);
              if (urlSavedFlag) setUrlSavedFlag(false);
              if (error) setError(null);
            }}
            data-testid="core-url-input"
          />
          <div className="flex items-center justify-end gap-3">
            {urlSavedFlag && (
              <span
                role="status"
                aria-live="polite"
                className="text-apollo-green inline-flex items-center gap-1 text-sm"
              >
                <Check className="size-4" />
                Saved
              </span>
            )}
            <Button
              type="button"
              variant="apollo"
              disabled={!urlDirty || urlOverLimit || busy}
              onClick={saveUrl}
              data-testid="core-url-save"
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div>
            <span className="text-sm font-medium">List on the public core-facilities pages</span>
            <p className="text-muted-foreground text-xs">
              Off by default. The site&apos;s core-facility pages must also be enabled for a
              visible core to actually show.
            </p>
          </div>
          <Switch
            checked={isVisible}
            disabled={busy}
            onCheckedChange={(checked) => toggleVisible(checked)}
            aria-label="List this core on the public core-facilities pages"
            data-testid="core-visible-toggle"
          />
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    </EditPanel>
  );
}

function mapErrorToMessage(code: string): string {
  switch (code) {
    case "not_core_owner":
      return "You no longer have access to this core. Refresh the page and try again.";
    case "description_too_long":
    case "url_too_long":
    case "invalid_url":
    case "invalid_value":
      return "We couldn't save that. Check the value and try again.";
    default:
      return "Something went wrong — your changes weren't saved. Please try again.";
  }
}
