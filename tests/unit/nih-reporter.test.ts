import { describe, expect, it } from "vitest";
import { nihReporterPiUrl, nihReporterProjectUrl } from "@/lib/nih-reporter";

describe("nihReporterPiUrl", () => {
  it("builds a /search/-/projects URL with the pi_profile_ids query param", () => {
    expect(nihReporterPiUrl(10502557)).toBe(
      "https://reporter.nih.gov/search/-/projects?pi_profile_ids=10502557",
    );
  });
});

describe("nihReporterProjectUrl", () => {
  it("builds a /project-details URL keyed by appl_id", () => {
    expect(nihReporterProjectUrl(11034567)).toBe(
      "https://reporter.nih.gov/project-details/11034567",
    );
  });
});
