/**
 * Who of the Cornell roster becomes a scholar row, under which role, and what
 * that means for the rows already there. Pure, so the rules are testable.
 */
export type RosterRow = {
  netid: string;
  name: string | null;
  name_first: string | null;
  name_last: string | null;
  email: string | null;
  primary_department: string | null;
  primary_job_title: string | null;
  affiliations_all: string | null;
  is_active_employee: number | null;
  is_faculty: number | null;
  is_rte_faculty: number | null;
  is_postdoc: number | null;
  is_student_grad_all: number | null;
  // identity_cornell_hr (monthly Workday file): academic rank and track.
  hr_title: string | null;
  hr_track: string | null;
  // identity_cornell_directory (Cornell's live directory).
  display_name: string | null;
  given_name: string | null;
  surname: string | null;
};

export type IthacaRole =
  | "ithaca_faculty"
  | "ithaca_rte_faculty"
  | "ithaca_emeritus"
  | "ithaca_postdoc"
  | "ithaca_researcher"
  | "ithaca_student_grad";

/**
 * The agreed population (plan, 2026-11-11), first match wins. Out: staff,
 * undergrads, the noisy "researcher" flag, research/teaching titles, departed
 * faculty. Research staff come from the HR academic rank, not that flag.
 */
export function roleOf(r: RosterRow): IthacaRole | null {
  const on = (v: number | null) => v === 1;
  if (/emerit/i.test(r.hr_title ?? "")) return "ithaca_emeritus";
  if (on(r.is_faculty) && !on(r.is_active_employee) && /emeritus/i.test(r.affiliations_all ?? "")) {
    return "ithaca_emeritus";
  }
  if (on(r.is_faculty) && on(r.is_active_employee)) return "ithaca_faculty";
  if (on(r.is_rte_faculty)) return "ithaca_rte_faculty";
  if (on(r.is_postdoc)) return "ithaca_postdoc";
  if (r.hr_track === "Non Faculty" && /^Research Associate|Research Scientist/i.test(r.hr_title ?? "")) {
    return "ithaca_researcher";
  }
  if (on(r.is_student_grad_all)) return "ithaca_student_grad";
  return null;
}

export type IthacaPerson = {
  cwid: string;
  preferredName: string;
  fullName: string;
  roleCategory: IthacaRole;
  primaryDepartment: string | null;
  primaryTitle: string | null;
  email: string | null;
};

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const cap = (s: string | null | undefined, n: number) => clean(s).slice(0, n) || null;

/** In-scope roster rows as scholar fields. Nameless people are skipped: a row needs a name. */
export function toPeople(rows: RosterRow[]): { people: IthacaPerson[]; nameless: number } {
  const people = new Map<string, IthacaPerson>();
  let nameless = 0;
  for (const r of rows) {
    const roleCategory = roleOf(r);
    if (!roleCategory) continue;
    const first = clean(r.name_first) || clean(r.given_name);
    const last = clean(r.name_last) || clean(r.surname);
    const preferredName = clean(`${first} ${last}`);
    if (!preferredName) {
      nameless += 1;
      continue;
    }
    const cwid = clean(r.netid).toLowerCase();
    const email = clean(r.email).toLowerCase();
    people.set(cwid, {
      cwid,
      preferredName: preferredName.slice(0, 255),
      fullName: (clean(r.display_name) || preferredName).slice(0, 255),
      roleCategory,
      primaryDepartment: cap(r.primary_department, 255),
      primaryTitle: cap(r.hr_title || r.primary_job_title, 255),
      // Cornell addresses only: a WCM address on an Ithaca row would collide with the WCM row's.
      email: email.endsWith("@cornell.edu") ? email : null,
    });
  }
  return { people: [...people.values()], nameless };
}

export type ExistingRow = { cwid: string; campus: string; deletedAt: Date | null };

export type RosterPlan = {
  create: IthacaPerson[];
  /** Ithaca rows to refresh; `revive` when soft-deleted. */
  update: { person: IthacaPerson; revive: boolean }[];
  /** Live Ithaca rows no longer on the roster. */
  prune: string[];
  /** On the roster under a cuid a WCM row holds, live or departed: ED owns it. */
  wcmOwned: number;
};

export function planRoster(people: IthacaPerson[], existing: ExistingRow[]): RosterPlan {
  const byCwid = new Map(existing.map((e) => [e.cwid.toLowerCase(), e]));
  const plan: RosterPlan = { create: [], update: [], prune: [], wcmOwned: 0 };
  const onRoster = new Set<string>();
  for (const person of people) {
    onRoster.add(person.cwid);
    const row = byCwid.get(person.cwid);
    if (!row) plan.create.push(person);
    else if (row.campus === "ithaca") plan.update.push({ person, revive: !!row.deletedAt });
    // ponytail: a departed WCM row is not moved to Ithaca. Until the CWID/NetID
    // namespaces merge, an equal string is as likely two people as one, and the row
    // carries WCM publications and ORCID state. Move rows when the merger lands.
    else plan.wcmOwned += 1;
  }
  for (const e of existing) {
    if (e.campus === "ithaca" && !e.deletedAt && !onRoster.has(e.cwid.toLowerCase())) {
      plan.prune.push(e.cwid);
    }
  }
  return plan;
}
