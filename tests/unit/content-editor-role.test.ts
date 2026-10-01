/**
 * The content_editor role (`lib/auth/content-editor.ts`): steward-shaped reads,
 * allowlisted writes. Covers the session transforms, the write-path strip, each
 * predicate that admits (or must not admit) a content editor, and a verdict
 * table that names every mutating `/api/edit` route — a new route fails here
 * until someone decides whether a content editor may call it.
 */
import { globSync, readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetEffectiveEditSession, mockGetSession, mockImpersonationActive, mockIsSuperuser } =
  vi.hoisted(() => ({
    mockGetEffectiveEditSession: vi.fn(),
    mockGetSession: vi.fn(),
    mockImpersonationActive: vi.fn(),
    mockIsSuperuser: vi.fn(),
  }));
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: mockGetEffectiveEditSession,
  impersonationActive: mockImpersonationActive,
}));
vi.mock("@/lib/auth/session-server", () => ({ getSession: mockGetSession }));
vi.mock("@/lib/auth/superuser", () => ({ isSuperuser: mockIsSuperuser }));

import { isContentEditor } from "@/lib/auth/content-editor";
import {
  stripContentEditorView,
  withContentEditorView,
  withObserverView,
} from "@/lib/auth/observer-view";
import {
  authorizeCommsStewardAction,
  authorizeCoreClaim,
  authorizeFieldEdit,
  authorizeMethodsAction,
  authorizeRevoke,
  canAccessScholarEditPage,
  canEditUnit,
  canGrant,
} from "@/lib/edit/authz";
import { canViewHonorsQueue, isHonorsQueueReadOnly } from "@/lib/edit/honor-queue";
import { resolveEditIdentityForWrite } from "@/lib/edit/request";
import { canViewUsage, type UsageAccessClient } from "@/lib/edit/usage-access";

const plain = { cwid: "cedit1", isSuperuser: false, isCommsSteward: false };
/** The READ session a content editor carries. */
const READ = withContentEditorView(plain, true);
/** The WRITE session the preamble hands every mutating route. */
const WRITE = stripContentEditorView(READ);

describe("withContentEditorView / stripContentEditorView", () => {
  it("gives a plain content editor a flagged, synthetic steward read view", () => {
    expect(READ).toEqual({ ...plain, isCommsSteward: true, isContentEditor: true });
  });

  it("leaves non-members and real superusers/stewards untouched", () => {
    expect(withContentEditorView(plain, false)).toBe(plain);
    const su = { ...plain, isSuperuser: true };
    expect(withContentEditorView(su, true)).toBe(su);
    const cs = { ...plain, isCommsSteward: true };
    expect(withContentEditorView(cs, true)).toBe(cs);
  });

  it("strip drops the synthetic grant but keeps the flag the write predicates read", () => {
    expect(WRITE).toEqual({ ...plain, isCommsSteward: false, isContentEditor: true });
    const cs = { ...plain, isCommsSteward: true };
    expect(stripContentEditorView(cs)).toBe(cs);
  });

  it("applied before the observer view, a member of both groups edits rather than views", () => {
    const both = withObserverView(withContentEditorView(plain, true), true);
    expect(both.isObserver).toBeUndefined();
    expect(both.isContentEditor).toBe(true);
  });
});

describe("isContentEditor", () => {
  it("is dormant unless CONTENT_EDITOR_ENABLED is exactly 'on' and a group cn is set", async () => {
    vi.stubEnv("CONTENT_EDITOR_ENABLED", "off");
    vi.stubEnv("SCHOLARS_CONTENT_EDITOR_GROUP_CN", "ITS:Library:Scholars/content-editor-role");
    expect(await isContentEditor("cedit1")).toBe(false);
    vi.stubEnv("CONTENT_EDITOR_ENABLED", "on");
    vi.stubEnv("SCHOLARS_CONTENT_EDITOR_GROUP_CN", "");
    expect(await isContentEditor("cedit2")).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("resolveEditIdentityForWrite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ cwid: "cedit1" });
    mockImpersonationActive.mockReturnValue(false);
    mockIsSuperuser.mockResolvedValue(false);
  });

  it("strips the content editor's synthetic steward grant before any write predicate", async () => {
    mockGetEffectiveEditSession.mockResolvedValue(READ);
    const r = await resolveEditIdentityForWrite();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.id.session).toEqual(WRITE);
  });
});

describe("write predicates", () => {
  const OTHER = "other9";

  it("profile content on any scholar: bio, Highlights, mentees, a title request", () => {
    for (const fieldName of [
      "overview",
      "selectedHighlightPmids",
      "manualMentees",
      "primaryTitleRequest",
    ] as const) {
      expect(authorizeFieldEdit(WRITE, { entityId: OTHER, fieldName }).ok).toBe(true);
    }
  });

  it("never pins a display title or sets a slug", () => {
    expect(authorizeFieldEdit(WRITE, { entityId: OTHER, fieldName: "primaryTitle" }).ok).toBe(false);
    expect(authorizeFieldEdit(WRITE, { entityId: OTHER, fieldName: "slug" }).ok).toBe(false);
  });

  it("opens any scholar's editor", () => {
    expect(canAccessScholarEditPage(WRITE, OTHER)).toBe(true);
  });

  it("edits any unit and core without holding a role there", () => {
    expect(canEditUnit(WRITE, "none").ok).toBe(true);
    expect(authorizeCoreClaim(WRITE, "none").ok).toBe(true);
  });

  it("never grants Owner/Curator", () => {
    expect(canGrant(WRITE, "none", "owner").ok).toBe(false);
    expect(canGrant(WRITE, "none", "curator").ok).toBe(false);
  });

  it("works Method Families but not the role vocabulary", () => {
    expect(authorizeMethodsAction(WRITE).ok).toBe(true);
    expect(authorizeCommsStewardAction(WRITE).ok).toBe(false);
  });

  it("is not admitted by the methods gate without the flag", () => {
    expect(authorizeMethodsAction(plain).ok).toBe(false);
  });
});

describe("authorizeRevoke — a content editor lifts staff hides on one profile only", () => {
  const staffHide = { createdBy: "curat1", subject: "other9", bySubject: false };

  it("lifts a hide staff applied on one profile", () => {
    expect(authorizeRevoke(WRITE, staffHide).ok).toBe(true);
  });

  it("not a hide the scholar (or their proxy) applied", () => {
    expect(authorizeRevoke(WRITE, { ...staffHide, bySubject: true }).ok).toBe(false);
  });

  it("not a takedown, whole-scholar hide or other kind (no subject)", () => {
    expect(authorizeRevoke(WRITE, { ...staffHide, subject: null }).ok).toBe(false);
  });

  it("without the flag, only the creator may lift it", () => {
    expect(authorizeRevoke(plain, staffHide).ok).toBe(false);
    expect(authorizeRevoke(plain, { createdBy: "cedit1" }).ok).toBe(true);
  });
});

describe("reads beyond the steward view", () => {
  it("sees the Honors queue, read-only", () => {
    expect(canViewHonorsQueue(READ)).toBe(true);
    expect(isHonorsQueueReadOnly(READ)).toBe(true);
  });

  it("sees Usage / ORCID coverage without a unit grant", async () => {
    const db = { unitAdmin: { findFirst: vi.fn() } } as unknown as UsageAccessClient;
    expect(await canViewUsage(READ, db)).toBe(true);
    expect(await canViewUsage(WRITE, db)).toBe(true);
  });
});

/**
 * Every mutating `/api/edit` route, with whether a content editor may call it
 * (on another scholar, or globally). "allow" routes must reach a predicate
 * that admits `isContentEditor`; "deny" routes must not name it. A route added
 * or removed without updating this table fails the first test.
 */
const VERDICT: Record<string, "allow" | "deny"> = {
  "appointment-visibility": "allow",
  appointment: "allow",
  "biosketch/debug-payload": "deny",
  "biosketch/generate": "allow",
  "biosketch/generations": "allow",
  "biosketch/suggest-pubs": "allow",
  "center-leadership": "allow",
  "center-program": "allow",
  "center/[code]/disease-assignments": "allow",
  "center/[code]/disease-auto-publish": "allow",
  "center/[code]/nci-2a/[awardId]": "allow",
  "center/[code]/nci-2a/accept": "allow",
  "clear-field": "deny",
  "coi-gap/[id]/dismiss": "deny",
  "coi-gap/[id]/feedback": "deny",
  "coi-gap/[id]/restore": "deny",
  "core-claim/bulk": "allow",
  "core-claim": "allow",
  "core-client": "allow",
  "core-queue-add": "allow",
  core: "allow",
  cv: "allow",
  field: "allow",
  "frt-mentees/[id]": "deny",
  "functional-roles": "deny",
  grant: "deny",
  "honor/decision": "deny",
  honor: "allow",
  "honor/sources/run": "deny",
  matcha: "deny",
  "mentee-suggestions/[id]/dismiss": "deny",
  "mentee-suggestions/[id]/restore": "deny",
  "methods/families/review": "allow",
  "methods/families/tier": "allow",
  "news-mention/decision": "allow",
  "news-mention/group": "allow",
  "news-mention": "allow",
  "news-mention/undo": "allow",
  "opportunity-admin": "deny",
  "opportunity-intake": "deny",
  orcid: "allow",
  "overview/debug-payload": "deny",
  "overview/generate": "allow",
  "overview/history": "allow",
  "overview/selection": "allow",
  proxy: "deny",
  reject: "deny",
  "report-access": "deny",
  "report-meta/[n]": "deny",
  "reporter-profile/[id]/confirm": "deny",
  "reporter-profile/[id]/reject": "deny",
  "reporter-profile/[id]/revoke": "deny",
  "reports/article-count/cwid-list": "allow",
  "request-change": "allow",
  revoke: "allow",
  roles: "deny",
  roster: "allow",
  "slug-redirect": "deny",
  "slug-request/[id]/decision": "deny",
  "slug-request/[id]/withdraw": "deny",
  "slug-request": "deny",
  "sponsor-match": "deny",
  suppress: "allow",
  unit: "allow",
};

/** Predicates (or the flag itself) through which a content editor's write passes. */
const ADMITS =
  /\b(isContentEditor|authorizeFieldEdit|authorizeOverviewWrite|authorizeCvExport|canEditUnit|authorizeCoreClaim|authorizeMethodsAction|authorizeRevoke|canAccessScholarEditPage|canViewArticleCountReport)\b/;

describe("content editor verdict: every mutating /api/edit route is decided", () => {
  const MUTATING = /export\s+(async\s+function|const)\s+(POST|PUT|PATCH|DELETE)\b/;
  const REEXPORT = /export\s*\{[^}]*\b(POST|PUT|PATCH|DELETE)\b[^}]*\}\s*from\s*"([^"]+)"/;
  const routes = globSync("app/api/edit/**/route.ts")
    .filter((f) => {
      const src = readFileSync(f, "utf8");
      return MUTATING.test(src) || REEXPORT.test(src);
    })
    .map((f) => f.replace(/^app\/api\/edit\//, "").replace(/\/route\.ts$/, ""))
    .sort();

  it("the table names exactly the mutating routes", () => {
    expect(Object.keys(VERDICT).sort()).toEqual(routes);
  });

  it.each(Object.entries(VERDICT).filter(([, v]) => v === "allow"))(
    "%s (allow) reaches a predicate that admits a content editor",
    (route) => {
      expect(ADMITS.test(readFileSync(`app/api/edit/${route}/route.ts`, "utf8"))).toBe(true);
    },
  );

  it.each(Object.entries(VERDICT).filter(([, v]) => v === "deny"))(
    "%s (deny) never names the content-editor flag",
    (route) => {
      expect(/\bisContentEditor\b/.test(readFileSync(`app/api/edit/${route}/route.ts`, "utf8"))).toBe(
        false,
      );
    },
  );
});
