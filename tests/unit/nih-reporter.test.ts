import { describe, expect, it } from "vitest";
import { nihReporterPiUrl, nihReporterProjectUrl } from "@/lib/nih-reporter";

describe("nihReporterPiUrl", () => {
  it("returns the click-through proxy URL keyed by cwid", () => {
    expect(nihReporterPiUrl({ cwid: "ole2001" })).toBe(
      "/api/nih-portfolio?cwid=ole2001",
    );
  });

  it("URL-encodes cwid characters that need it", () => {
    expect(nihReporterPiUrl({ cwid: "abc/def" })).toBe(
      "/api/nih-portfolio?cwid=abc%2Fdef",
    );
  });

  it("returns the proxy URL keyed by profile_id when cwid isn't available", () => {
    expect(nihReporterPiUrl({ profileId: 10502557 })).toBe(
      "/api/nih-portfolio?profile_id=10502557",
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
