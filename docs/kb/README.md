# Scholars ServiceNow KB articles

Source drafts for the four internal ServiceNow Knowledge Base articles that support the Scholars Profile System (`scholars.weill.cornell.edu`). Tracked in **#506 Gate D3** (folded in from closed #534).

Each article is organized around one question: **what can this audience do in Scholars, and what can't they do?** Scholars looks like a directory editor but most fields are read-only mirrors of upstream systems (Web Directory, Faculty Affairs, ReCiter, ReciterAI, OSRA). Leading with the can/can't boundary keeps tickets in the right queue.

The **public / visitor FAQ is not in the KB** — it lives on the Scholars site itself (`/about`, linked from the footer "Help & support").

| # | File | Audience | SN template | Visibility |
|---|---|---|---|---|
| 1 | [`01-scholars.md`](./01-scholars.md) | Scholars (faculty / postdocs / fellows / doctoral students) | HowTo | All staff |
| 2 | [`02-dept-admins.md`](./02-dept-admins.md) | Department administrators / unit owners | SOP | All staff — **DEFERRED, gated on #540** |
| 3 | [`03-superusers.md`](./03-superusers.md) | Scholars superusers + library curators | SOP | **Superuser group + ITSOPS only** |
| 4 | [`04-itsops.md`](./04-itsops.md) | ITSOPS / Service Desk agents | SOP | Service Desk |

## Publishing checklist (#506 D3 acceptance)

- [ ] Articles 1, 3, 4 reviewed by the responsible office (1: library/Scholars; 3+4: Service Desk KM), pasted into ServiceNow with the template indicated.
- [ ] **Article 2 drafted only once #540 is concrete enough** that the dept/center-admin can/can't list is stable — pin the article to a #540 phase boundary.
- [ ] **Article 4 in place *before*** the Scholars → ServiceNow intake integration (#519 / #520) goes live — it's the agents' routing script.
- [ ] Article 3 visibility restricted to the superuser group + ITSOPS.
- [ ] Article 1 deep-links to in-app entry points (e.g. "Request a custom URL" → the actual request flow).
- [ ] Pin "describes behavior as of `vN.N.N`" on sections covering UI that's still iterating (slug-request, suppression, unit curation).

## Shared references

- Correction routing (who each correction type goes to): [`../feedback-handling-matrix.md`](../feedback-handling-matrix.md) (#514) — the single source for assignment groups; **don't restate destinations in an article, link this.**
- Public help surface: `/about` (and `/about/methodology`).
- Launch-window outreach the KB supports: [`../outreach/`](../outreach/) (#506 D5).
