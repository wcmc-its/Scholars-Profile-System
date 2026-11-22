-- CreateIndex
-- scholar.orcid is looked up by value (bulk-confirm's per-pair "who already holds this
-- iD" count, ORCID queue checks) and had no index: a full scan of scholar per pair.
-- Additive; InnoDB builds it online.
CREATE INDEX `scholar_orcid_idx` ON `scholar`(`orcid`);
