-- AlterTable
-- Two mirrors write `orcid_candidate`, each owning its own `source` values and
-- full-replacing them per run: etl/orcid-candidates (rpm_inferred / rpm_admin,
-- nightly) and etl/orcid-registry (orcid_email / orcid_works / orcid_name, weekly).
-- Under a (cwid, orcid) key they collided on the common true-positive case — the
-- same iD seen by both — so the later run overwrote the earlier one's `source`
-- and counts, the person's tier on /edit/orcid-coverage flipped between the
-- nightly and the weekly, and the fold's "RPM and the registry agree on one iD"
-- rule could never fire. (cwid, orcid, source) gives each mirror disjoint rows;
-- both delete passes were already scoped by `source`. `cwid` stays the leading
-- column, so the FK index is preserved. The table is empty on every environment
-- (both mirrors ship alongside this change), so there is nothing to backfill.
ALTER TABLE `orcid_candidate` DROP PRIMARY KEY,
    ADD PRIMARY KEY (`cwid`, `orcid`, `source`);
