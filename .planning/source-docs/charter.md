# Project Charter: Scholars @ Weill Cornell Medicine

_Last updated: 2026-04-28_

## Project Information

| Field | Value |
|---|---|
| Project Name | Scholars @ Weill Cornell Medicine |
| Funding Sponsor | Terrie [last name TBD] |
| Project Executive | Chris Huang |
| Project Manager | TBD |
| Stakeholders | VIVO/ASMS Steering Committee (Chris Huang, Alex, Terrie, Vinay Varughese, Charlie, Sumanth); Office of Faculty Affairs (OFA); Application Architecture Committee (AAC); Change Advisory Board (CAB); ITS Development Team; Data & Analytics product team (prospective downstream owner of faculty self-edit) |

## Business Case

### Problems & Opportunities

VIVO, the institution's current scholar profile system, has reached end of life. The platform has experienced repeated all-hands-on-deck outages lasting 8+ hours that persist despite tactical fixes. Its legacy Java/Tomcat, RDF triple-store, and Apache Solr architecture requires manual reindexing, suffers data synchronization drift with downstream tools, and demands operational expertise the team can no longer sustain.

WCM also lacks a modern, branded, performant public surface for showcasing its scholars to patients, prospective collaborators, funders, students, journalists, and the broader research community. Replacement is urgent and presents an opportunity to establish a reusable platform that can support current and future researcher-facing services.

### Goal

Replace VIVO with a custom, modular, AWS-native scholar profile platform aligned with WCM's existing development stack and operational model. Deliver public scholar profiles in Phase 1; expand data depth, integrations, and limited self-edit capability across subsequent phases. Establish the Scholar API as a reusable backend for additional researcher-facing applications.

## Project Definition

### Objectives

- Stand up a public Scholars @ WCM site (`scholars.weill.cornell.edu`) to replace VIVO.
- Build a reusable Scholar API as the backend for current and future researcher-facing applications.
- Integrate authoritative data from Enterprise Directory, ASMS, InfoEd, ReCiter, and COI as read-only source systems.
- Provide minimal faculty self-edit (overview statement, suppressions) as an interim service pending the Data & Analytics product's assumption of that role.
- Decommission VIVO.

### Dependencies

| Dependency | Completion Date | Comments |
|---|---|---|
| WCM institutional UI / branding standards | TBD | Awaiting institutional guidance; required for final design polish. |
| SAML integration with WCM identity | TBD | Required for authenticated self-edit. |
| Read access to source systems (Directory, ASMS, InfoEd, ReCiter, COI) | TBD | Daily refresh expected. |
| AWS infrastructure provisioning (Fargate, RDS, CloudFront, Redis, Route 53, ACM) | TBD | |
| AAC and CAB approvals | TBD | |

### Out of Scope

- Full CRIS / RIM platform features (research outputs workflow, OA compliance, faculty review automation).
- Linked data, RDF, or SPARQL endpoints.
- Editing of structured data sourced from authoritative systems (appointments, education, grants, publications, COI).
- Long-term ownership of faculty self-edit, which is expected to transition to the Data & Analytics product.
- Any functional duplication of upstream systems (COI, ASMS, InfoEd, Enterprise Directory, ReCiter).

### Assumptions

- WCM institutional UI / branding standards will be published in time to apply during Phase 1.
- Source systems remain available and stable across the project window.
- The Data & Analytics product will absorb faculty self-edit, permitting Scholars to keep self-edit minimal.
- The existing development team can deliver against the proposed stack (React / Next.js / Node, MySQL on RDS, Fargate, Redis, CloudFront, S3).
- SAML integration with the institutional identity provider is straightforward.
- Daily data refresh cadence is acceptable for Phase 1; near-real-time integration is not required.

### Constraints

- VIVO continues to degrade; phased launch must outpace VIVO's decline to avoid an uncontrolled decommissioning.
- Self-edit scope must remain minimal until the D&A product handoff.
- Solution must conform to WCM branding standards once published.
- AWS-native, microservices architecture is required.
- Source systems are consumed read-only; no write-back to upstream systems.

### High Impacting Risks

- Institutional UI / branding standards delayed, blocking final design polish and launch.
- VIVO suffers a catastrophic failure prior to Scholars launch, forcing premature decommissioning before a replacement is ready.
- Data integration complexity across five source systems is underestimated, extending the Phase 1 timeline.
- Scope creep on faculty self-edit if the D&A product timeline slips, creating pressure to expand Scholars beyond its interim role.
- SEO degradation and loss of inbound links during URL migration from VIVO to Scholars.
- Stakeholder sign-off (AAC, CAB, Steering Committee) delayed beyond planning assumptions.

### Success Criteria

- All active WCM faculty with public release codes have profiles in Scholars.
- VIVO is decommissioned within approximately two months of Scholars launch.
- Daily data refresh from all source systems operates reliably.
- Uptime materially exceeds VIVO's recent record.
- Google indexing preserves or improves SEO position post-migration.
- Faculty self-edit (overview statement) is functional and adopted by faculty.
- Sign-off secured from the VIVO/ASMS Steering Committee, AAC, and CAB.
