-- Request record for the /edit/reports console's "Edit details" sheet: who
-- asked for a report, when, and a memo of what was asked for. Shown to report
-- editors only, never on the report. Additive and nullable (a report with no
-- row, or a row saved before this column, has no request record). DDL only
-- (#584: migrations never INSERT).

ALTER TABLE `report_meta`
    ADD COLUMN `requested_by` VARCHAR(200) NULL,
    ADD COLUMN `requested_on` DATE NULL,
    ADD COLUMN `request_memo` TEXT NULL;
