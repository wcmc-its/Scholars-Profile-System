/**
 * Report 21 — F and K awards. NIH fellowship (F) and career development (K)
 * awards held by a center's research members and by the trainees in their
 * labs. Pure: params and the classification; the DB half is
 * `fk-awards.server.ts`.
 *
 * An award is one holder's mechanism + IC + serial ("F31CA123456"), so the
 * yearly rows and renewals InfoEd keeps for it collapse into one, spanning
 * the earliest start to the latest end. Only PI-type rows hold an award
 * (`HOLDER_ROLES`); a "Key Personnel" row on the same award is how InfoEd
 * names the sponsor or mentor on a trainee's F or K.
 *
 * Categories, first match wins:
 *   - member: the holder is a research member on the as-of date.
 *   - trainee: a mentor record (PhD, postdoc, AOC, FRT) links the holder to a member.
 *   - key_personnel: no such record, but a member is Key Personnel on the award.
 *   - no_mentor: the holder has no mentor record at all, so the lab is unknown.
 * A holder whose mentors are all non-members is not the center's and is left out.
 *
 * InfoEd holds only WCM-administered awards, so an award administered at MSK
 * or Rockefeller is not here at all.
 */

export const FK_MECHANISM = /^[FK]\d{2}$/;
export const HOLDER_ROLES: ReadonlySet<string> = new Set(["PI", "PI-Subaward", "Co-PI"]);
export const KEY_PERSONNEL = "Key Personnel";

export type FkCategory = "member" | "trainee" | "key_personnel" | "no_mentor";
export const FK_CATEGORIES: ReadonlyArray<{ key: FkCategory; label: string }> = [
  { key: "member", label: "Member" },
  { key: "trainee", label: "Trainee of a member" },
  { key: "key_personnel", label: "Trainee via Key Personnel" },
  { key: "no_mentor", label: "No mentor record" },
];

export type MentorSource = "PhD" | "postdoc" | "AOC" | "FRT";

export type FkAwardsParams = {
  from: number;
  to: number;
  /** YYYY-MM-DD the membership is read on; default today. */
  asOf: string;
  /** Leave out faculty whose only link to a member is an FRT mentor (a career
   *  mentor, not necessarily a lab head). */
  labOnly: boolean;
};

/** Ten calendar years, newest first: two CCSG cycles. */
export function fkAwardYears(now = new Date()): number[] {
  const y = now.getUTCFullYear();
  return Array.from({ length: 10 }, (_, i) => y - i);
}

const isCalendarDate = (iso: string) => {
  const t = Date.parse(iso);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === iso;
};

/** Default: awards active at any point this calendar year, members as of today. */
export function parseFkAwardsParams(sp: URLSearchParams, now = new Date()): FkAwardsParams {
  const years = fkAwardYears(now);
  const year = (k: string, fallback: number) => {
    const y = Number(sp.get(k));
    return years.includes(y) ? y : fallback;
  };
  const from = year("from", years[0]);
  const to = Math.max(from, year("to", from));
  const asOf = sp.get("asOf") ?? "";
  return {
    from,
    to,
    asOf:
      /^\d{4}-\d{2}-\d{2}$/.test(asOf) && isCalendarDate(asOf)
        ? asOf
        : now.toISOString().slice(0, 10),
    labOnly: sp.get("labOnly") === "1",
  };
}

export function fkAwardsQuery(p: FkAwardsParams): string {
  const q = new URLSearchParams({ from: String(p.from), to: String(p.to), asOf: p.asOf });
  if (p.labOnly) q.set("labOnly", "1");
  return q.toString();
}

export function fkPeriodLabel(p: Pick<FkAwardsParams, "from" | "to">): string {
  return p.from === p.to ? String(p.from) : `${p.from} to ${p.to}`;
}

/** "5 F31 CA123456-02" → "F31CA123456"; null when the number has no such core. */
export function awardCore(awardNumber: string | null): string | null {
  return (
    (awardNumber ?? "")
      .replace(/\s+/g, "")
      .toUpperCase()
      .match(/[FK]\d{2}[A-Z]{2}\d{6}/)?.[0] ?? null
  );
}

export type FkGrantRow = {
  cwid: string;
  role: string;
  mechanism: string | null;
  awardNumber: string | null;
  externalId: string;
  title: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;
};
export type FkMembership = {
  cwid: string;
  programCode: string | null;
  startDate: string | null;
  endDate: string | null;
};
export type FkMentorLink = { mentorCwid: string; menteeCwid: string; source: MentorSource };
export type FkPerson = { cwid: string; name: string; roleCategory: string | null };

export type FkMentor = {
  cwid: string;
  name: string;
  program: string | null;
  sources: MentorSource[];
};
export type FkAward = {
  category: FkCategory;
  holderCwid: string;
  holderName: string;
  holderRole: string | null;
  mechanism: string;
  awardNumber: string;
  title: string;
  start: string;
  end: string;
  /** The member's own program, for a member award. */
  program: string | null;
  /** Member mentors (trainee) or member Key Personnel (key_personnel); empty otherwise. */
  mentors: FkMentor[];
  /** Faculty whose only member link is FRT: a career mentor, maybe not a lab. */
  careerMentorOnly: boolean;
};
export type FkAwards = {
  awards: FkAward[];
  /** Award counts by category, F and K separately. */
  counts: Record<FkCategory, { F: number; K: number }>;
  /** Awards whose holders are mentored only by non-members (left out). */
  notCenter: number;
  /** Faculty awards left out by `labOnly`. */
  careerMentorOnlyHidden: number;
};

const ROLE_LABELS: Record<string, string> = {
  full_time_faculty: "Full-time faculty",
  part_time_faculty: "Part-time faculty",
  affiliated_faculty: "Affiliated faculty",
  postdoc: "Postdoc",
  doctoral_student: "Doctoral student",
  non_faculty_academic: "Non-faculty academic",
};
export const roleLabel = (rc: string | null) => (rc ? (ROLE_LABELS[rc] ?? rc) : "");

export function computeFkAwards(input: {
  grants: readonly FkGrantRow[];
  memberships: readonly FkMembership[];
  links: readonly FkMentorLink[];
  people: readonly FkPerson[];
  programs: ReadonlyArray<{ code: string; label: string }>;
  params: FkAwardsParams;
}): FkAwards {
  const { params: p } = input;
  const lc = (s: string) => s.toLowerCase();
  const programLabel = new Map(input.programs.map((x) => [x.code, x.label]));
  const people = new Map(input.people.map((x) => [lc(x.cwid), x]));
  const members = new Map<string, string | null>();
  for (const m of input.memberships)
    if ((!m.startDate || m.startDate <= p.asOf) && (!m.endDate || m.endDate >= p.asOf))
      members.set(
        lc(m.cwid),
        m.programCode ? (programLabel.get(m.programCode) ?? m.programCode) : null,
      );
  const mentorsOf = new Map<string, FkMentorLink[]>();
  for (const l of input.links) {
    const k = lc(l.menteeCwid);
    mentorsOf.set(k, [...(mentorsOf.get(k) ?? []), l]);
  }

  const fk = input.grants.filter((g) => g.mechanism && FK_MECHANISM.test(g.mechanism));
  const keyOf = (g: FkGrantRow) => awardCore(g.awardNumber) ?? `id:${g.externalId}`;
  const keyPersonnel = new Map<string, Set<string>>();
  for (const g of fk)
    if (g.role === KEY_PERSONNEL)
      keyPersonnel.set(keyOf(g), (keyPersonnel.get(keyOf(g)) ?? new Set()).add(lc(g.cwid)));

  const held = new Map<string, FkGrantRow & { key: string }>();
  for (const g of fk) {
    if (!HOLDER_ROLES.has(g.role)) continue;
    const key = keyOf(g);
    const id = `${lc(g.cwid)}|${key}`;
    const a = held.get(id);
    if (!a) held.set(id, { ...g, key });
    else {
      if (g.startDate < a.startDate) a.startDate = g.startDate;
      if (g.endDate > a.endDate) {
        a.endDate = g.endDate;
        a.awardNumber = g.awardNumber; // the latest year's number
        a.title = g.title;
      }
    }
  }

  const person = (cwid: string): FkPerson =>
    people.get(cwid) ?? { cwid, name: cwid, roleCategory: null };
  const counts = Object.fromEntries(
    FK_CATEGORIES.map((c) => [c.key, { F: 0, K: 0 }]),
  ) as FkAwards["counts"];
  const awards: FkAward[] = [];
  let notCenter = 0;
  let careerMentorOnlyHidden = 0;
  const windowStart = `${p.from}-01-01`;
  const windowEnd = `${p.to}-12-31`;

  for (const a of held.values()) {
    if (a.startDate > windowEnd || a.endDate < windowStart) continue;
    const cwid = lc(a.cwid);
    const holder = person(cwid);
    const links = mentorsOf.get(cwid) ?? [];
    const memberLinks = links.filter((l) => members.has(lc(l.mentorCwid)));
    const kp = [...(keyPersonnel.get(a.key) ?? [])].filter((c) => c !== cwid && members.has(c));

    let category: FkCategory;
    let mentors: FkMentor[] = [];
    if (members.has(cwid)) category = "member";
    else if (memberLinks.length) {
      category = "trainee";
      const by = new Map<string, FkMentor>();
      for (const l of memberLinks) {
        const m = lc(l.mentorCwid);
        const e = by.get(m) ?? {
          cwid: m,
          name: person(m).name,
          program: members.get(m) ?? null,
          sources: [],
        };
        if (!e.sources.includes(l.source)) e.sources.push(l.source);
        by.set(m, e);
      }
      mentors = [...by.values()];
    } else if (kp.length) {
      category = "key_personnel";
      mentors = kp.map((m) => ({
        cwid: m,
        name: person(m).name,
        program: members.get(m) ?? null,
        sources: [],
      }));
    } else if (links.length) {
      notCenter++;
      continue;
    } else category = "no_mentor";

    const careerMentorOnly =
      category === "trainee" &&
      (holder.roleCategory ?? "").endsWith("_faculty") &&
      mentors.every((m) => m.sources.every((s) => s === "FRT"));
    if (careerMentorOnly && p.labOnly) {
      careerMentorOnlyHidden++;
      continue;
    }
    const mech = a.mechanism!;
    counts[category][mech[0] as "F" | "K"]++;
    awards.push({
      category,
      holderCwid: cwid,
      holderName: holder.name,
      holderRole: holder.roleCategory,
      mechanism: mech,
      awardNumber: a.awardNumber ?? "",
      title: a.title,
      start: a.startDate,
      end: a.endDate,
      program: category === "member" ? (members.get(cwid) ?? null) : null,
      mentors,
      careerMentorOnly,
    });
  }
  const order = new Map(FK_CATEGORIES.map((c, i) => [c.key, i]));
  awards.sort(
    (x, y) =>
      order.get(x.category)! - order.get(y.category)! ||
      x.mechanism.localeCompare(y.mechanism) ||
      x.holderName.localeCompare(y.holderName),
  );
  return { awards, counts, notCenter, careerMentorOnlyHidden };
}
