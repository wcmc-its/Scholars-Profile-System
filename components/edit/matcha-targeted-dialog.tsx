"use client";

/**
 * Matcha targeted messages — the "Email individually" review queue. Top: "the pitch" (what the
 * partner is looking for), drafted on open by `/api/edit/matcha/pitch` and editable. Then one card
 * per selected researcher, in rank order, with their own editable message
 * (`buildTargetedEmail`): "Open in mail app" (a `mailto:` to that person), "Copy", and a "Done"
 * tick the officer works down. Editing the pitch rewrites every card the officer has not edited
 * by hand. Nothing is sent from Scholars; addresses live only in this dialog's state.
 */
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { MAILTO_SOFT_LIMIT, buildMailto, buildTargetedEmail } from "@/lib/edit/matcha-email";

/** One selected researcher, with the brief pieces the message uses ("" when absent). */
export type TargetedPerson = {
  cwid: string;
  name: string;
  hasBrief: boolean;
  angle: string;
  angleRole: string;
  topic: string;
};

/** What `/api/edit/matcha/contacts` returns. */
export type TargetedContacts = {
  contacts: { cwid: string; name: string; email: string }[];
  missing: { cwid: string; name: string }[];
  officer: { name: string; email: string | null };
};

type Card = {
  /** The officer's hand edit; absent ⇒ the message follows the pitch. */
  override?: string;
  done: boolean;
  copied?: "ok" | "failed";
};

/** localStorage key for the officer's pitch on one search. */
export function pitchStorageKey(submissionId: string): string {
  return `matcha-pitch:${submissionId}`;
}

// ponytail: the edited pitch is cached in THIS browser only (localStorage); persist it on the
// submission server-side if officers need it across devices.
function readCachedPitch(submissionId: string): string | null {
  try {
    return window.localStorage.getItem(pitchStorageKey(submissionId));
  } catch {
    return null;
  }
}

function writeCachedPitch(submissionId: string, pitch: string): void {
  try {
    window.localStorage.setItem(pitchStorageKey(submissionId), pitch);
  } catch {
    // Storage blocked: the pitch still lives in the dialog.
  }
}

export function TargetedEmailDialog({
  submissionId,
  people,
  focus,
  requester,
  loadContacts,
  draftPitch,
  onClose,
}: {
  submissionId: string;
  /** The selected researchers, in rank order. */
  people: readonly TargetedPerson[];
  focus: string;
  requester: string | null;
  loadContacts: () => Promise<TargetedContacts>;
  draftPitch: () => Promise<string>;
  onClose: () => void;
}) {
  const [contacts, setContacts] = useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | ({ kind: "ready" } & TargetedContacts)
  >({ kind: "loading" });
  const [pitch, setPitchState] = useState("");
  const [pitchStatus, setPitchStatus] = useState<"idle" | "drafting" | "error">("idle");
  const [cards, setCards] = useState<Record<string, Card>>({});

  function setPitch(next: string) {
    setPitchState(next);
    writeCachedPitch(submissionId, next);
  }

  function regenerate() {
    setPitchStatus("drafting");
    draftPitch()
      .then((p) => {
        setPitch(p);
        setPitchStatus("idle");
      })
      .catch(() => setPitchStatus("error"));
  }

  // On open: addresses, and the pitch (the cached edit when there is one, else a fresh draft).
  useEffect(() => {
    let live = true;
    loadContacts()
      .then((r) => live && setContacts({ kind: "ready", ...r }))
      .catch(
        (err: unknown) =>
          live &&
          setContacts({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          }),
      );
    const cached = readCachedPitch(submissionId);
    if (cached) setPitchState(cached);
    else regenerate();
    return () => {
      live = false;
    };
    // Once per open: the dialog is remounted for a new selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const officerName = contacts.kind === "ready" ? contacts.officer.name : "";
  // The directory's preferred name (as the per-person Email greets) and address, by cwid.
  const contactBy = new Map(
    contacts.kind === "ready" ? contacts.contacts.map((c) => [c.cwid, c]) : [],
  );
  const reachable = people.filter((p) => contactBy.has(p.cwid));
  const missing = contacts.kind === "ready" ? contacts.missing : [];
  const doneCount = reachable.filter((p) => cards[p.cwid]?.done).length;

  function patchCard(cwid: string, patch: Partial<Card>) {
    setCards((prev) => ({ ...prev, [cwid]: { ...(prev[cwid] ?? { done: false }), ...patch } }));
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-slot="matcha-targeted-dialog"
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>Email researchers individually</DialogTitle>
          <DialogDescription>
            {contacts.kind === "ready"
              ? `${doneCount} of ${reachable.length} done. Review each message, then open it in your mail app or copy it. Nothing is sent by Scholars.`
              : "Addresses are looked up when you ask and are not saved."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1">
          <label htmlFor="matcha-pitch" className="text-sm font-medium">
            The pitch
          </label>
          <p className="text-muted-foreground text-xs">
            What the partner is looking for, in every message. Check it says nothing confidential.
          </p>
          <Textarea
            id="matcha-pitch"
            rows={4}
            value={pitch}
            disabled={pitchStatus === "drafting"}
            placeholder={pitchStatus === "drafting" ? "Drafting the pitch…" : ""}
            onChange={(e) => setPitch(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pitchStatus === "drafting"}
              onClick={regenerate}
            >
              {pitchStatus === "drafting" ? "Drafting…" : "Regenerate"}
            </Button>
            {pitchStatus === "error" ? (
              <span className="text-destructive text-xs" role="alert">
                Couldn&apos;t draft the pitch. Write one, or try again.
              </span>
            ) : null}
          </div>
        </div>

        {contacts.kind === "loading" ? (
          <p className="text-sm" role="status">
            Looking up addresses…
          </p>
        ) : contacts.kind === "error" ? (
          <p className="text-destructive text-sm" role="alert">
            {contacts.message}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {reachable.map((p) => {
              const card = cards[p.cwid] ?? { done: false };
              const { name, email } = contactBy.get(p.cwid)!;
              const built = buildTargetedEmail({
                focus,
                requester,
                officerName,
                name,
                pitch,
                angle: p.angle,
                angleRole: p.angleRole,
                topic: p.topic,
              });
              const body = card.override ?? built.body;
              const mailto = buildMailto({ to: email, subject: built.subject, body });
              return (
                <section
                  key={p.cwid}
                  data-slot="matcha-targeted-card"
                  aria-label={name}
                  className="border-border flex flex-col gap-2 rounded border p-3"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold">{name}</div>
                      <div className="text-muted-foreground text-xs">{email}</div>
                    </div>
                    <label className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        checked={card.done}
                        onChange={(e) => patchCard(p.cwid, { done: e.target.checked })}
                      />
                      Done
                    </label>
                  </div>
                  {!p.hasBrief ? (
                    <p
                      className="text-muted-foreground text-xs"
                      data-slot="matcha-targeted-no-brief"
                    >
                      No brief — draft one for a personal line
                    </p>
                  ) : null}
                  <Textarea
                    aria-label={`Message to ${name}`}
                    rows={10}
                    value={body}
                    onChange={(e) => patchCard(p.cwid, { override: e.target.value })}
                  />
                  {mailto.length > MAILTO_SOFT_LIMIT ? (
                    <p className="text-xs" data-slot="matcha-targeted-too-long">
                      Too long for some mail apps — use Copy.
                    </p>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <Button asChild variant="apollo" size="sm">
                      <a href={mailto} onClick={() => patchCard(p.cwid, { done: true })}>
                        Open in mail app
                      </a>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard
                          .writeText(body)
                          .then(() => patchCard(p.cwid, { copied: "ok" }))
                          .catch(() => patchCard(p.cwid, { copied: "failed" }));
                      }}
                    >
                      Copy
                    </Button>
                    {card.copied === "ok" ? (
                      <span className="text-xs" role="status">
                        Copied
                      </span>
                    ) : card.copied === "failed" ? (
                      <span className="text-destructive text-xs" role="alert">
                        Couldn&apos;t copy; select the message and copy it.
                      </span>
                    ) : null}
                  </div>
                </section>
              );
            })}
            {missing.length > 0 ? (
              <div data-slot="matcha-targeted-missing" className="text-sm">
                <div className="font-medium">No email on file</div>
                <ul className="text-muted-foreground list-disc pl-5">
                  {missing.map((m) => (
                    <li key={m.cwid}>{m.name}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
