-- Issue #5 — postdoctoral mentor self-FK on scholar.

-- AlterTable
ALTER TABLE `scholar` ADD COLUMN `postdoctoral_mentor_cwid` VARCHAR(32) NULL;

-- CreateIndex
CREATE INDEX `scholar_postdoctoral_mentor_cwid_idx` ON `scholar`(`postdoctoral_mentor_cwid`);

-- AddForeignKey
ALTER TABLE `scholar`
  ADD CONSTRAINT `scholar_postdoctoral_mentor_cwid_fkey`
  FOREIGN KEY (`postdoctoral_mentor_cwid`) REFERENCES `scholar`(`cwid`)
  ON DELETE SET NULL ON UPDATE CASCADE;
