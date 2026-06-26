import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchPops, type PopsEnrichment } from "@/lib/edit/pops";

// Trimmed real aorlin payload (http://pops.weillcornell.org/providerbyshortname/aorlin.json,
// fetched 2026-06-26) plus two synthetic rows that exercise is_hidden + POPS string-booleans.
const AORLIN_PROFILE = {
  cwid: "ano9028",
  professional_suffixes: ["M.D."],
  npi_number: "1720138498",
  has_npi_number: true,
  board_certifications: [
    {
      board_name: "American Board of Ophthalmology",
      mapped_specialty: { id: 654, name: "Ophthalmology", is_primary_specialty: true },
    },
  ],
  training: [
    { id: "10058", training_type: "Residency", institution: "Scheie Eye Institute" },
    { id: "10062", training_type: "Internship", institution: "Scheie Eye Institute" },
    // Dropped: redundant with degrees.
    { id: "10066", training_type: "Medical School", institution: "Scheie Eye Institute" },
  ],
  degrees: [
    {
      id: "6990",
      degree_type: "M.D.",
      year_obtained: 2006,
      institution: "University of Pennsylvania School of Medicine",
      is_hidden: false,
    },
    {
      id: "6994",
      degree_type: "B.A.",
      year_obtained: 2002,
      institution: "University of Rochester",
      is_hidden: false,
    },
    // Synthetic: POPS string-boolean 'True' ⇒ excluded.
    { id: "9999", degree_type: "Ph.D.", year_obtained: 2010, institution: "Hidden U", is_hidden: "True" },
  ],
  appointments: [
    {
      id: "26094",
      title: "Associate Attending Ophthalmologist",
      institution: "NewYork-Presbyterian Hospital",
      termstartdate: "2020-01-01T00:00:00-0500",
      termenddate: "2026-06-30T00:00:00-0400",
      is_hidden: null,
    },
    // Synthetic: POPS string-boolean 'True' ⇒ excluded.
    {
      id: "26200",
      title: "Secret Appointment",
      institution: "Hidden Hospital",
      termstartdate: "2019-01-01T00:00:00-0500",
      termenddate: null,
      is_hidden: "True",
    },
  ],
  honors_and_awards:
    "<p><strong>January 2010</strong> Association of University Professors of Ophthalmology (AUPO) Residency Research Forum Award Recipient</p>",
  primary_specialties: [{ id: 654, name: "Ophthalmology", is_primary_specialty: true }],
};

function mockFetchJson(body: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      status,
      json: () => Promise.resolve(body),
    }),
  );
}

async function loadAorlin(): Promise<PopsEnrichment> {
  mockFetchJson({ providerProfile: AORLIN_PROFILE });
  const result = await fetchPops("aorlin");
  expect(result).not.toBeNull();
  return result!;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchPops mapper", () => {
  it("maps the cwid into the providerbyshortname URL", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fetchSpy);
    await fetchPops("aorlin");
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://pops.weillcornell.org/providerbyshortname/aorlin.json",
    );
  });

  it("maps board certifications to {board, specialty}", async () => {
    const pops = await loadAorlin();
    expect(pops.boardCertifications).toEqual([
      { board: "American Board of Ophthalmology", specialty: "Ophthalmology" },
    ]);
  });

  it("drops 'Medical School' training rows but keeps Residency/Internship", async () => {
    const pops = await loadAorlin();
    expect(pops.training).toEqual([
      { type: "Residency", institution: "Scheie Eye Institute" },
      { type: "Internship", institution: "Scheie Eye Institute" },
    ]);
    expect(pops.training.some((t) => t.type === "Medical School")).toBe(false);
  });

  it("coerces the string-boolean is_hidden and excludes hidden degrees", async () => {
    const pops = await loadAorlin();
    expect(pops.degrees).toEqual([
      { degree: "M.D.", year: "2006", institution: "University of Pennsylvania School of Medicine" },
      { degree: "B.A.", year: "2002", institution: "University of Rochester" },
    ]);
    expect(pops.degrees.some((d) => d.degree === "Ph.D.")).toBe(false);
  });

  it("excludes is_hidden='True' appointments and keeps ISO term dates", async () => {
    const pops = await loadAorlin();
    expect(pops.appointments).toEqual([
      {
        title: "Associate Attending Ophthalmologist",
        institution: "NewYork-Presbyterian Hospital",
        start: "2020-01-01T00:00:00-0500",
        end: "2026-06-30T00:00:00-0400",
      },
    ]);
  });

  it("splits the honors HTML into a leading date + award name", async () => {
    const pops = await loadAorlin();
    expect(pops.honors).toEqual([
      {
        date: "January 2010",
        name: "Association of University Professors of Ophthalmology (AUPO) Residency Research Forum Award Recipient",
      },
    ]);
  });

  it("maps npi and specialties", async () => {
    const pops = await loadAorlin();
    expect(pops.npi).toBe("1720138498");
    expect(pops.specialties).toEqual(["Ophthalmology"]);
  });
});

describe("fetchPops resilience (never throws into the CV path)", () => {
  it("returns null on a non-ok response (404)", async () => {
    mockFetchJson({}, false, 404);
    expect(await fetchPops("nobody")).toBeNull();
  });

  it("returns null when providerProfile is absent", async () => {
    mockFetchJson({});
    expect(await fetchPops("nobody")).toBeNull();
  });

  it("returns null on a network/parse error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect(await fetchPops("aorlin")).toBeNull();
  });

  it("falls back to the whole line when honors lack a leading date", async () => {
    mockFetchJson({
      providerProfile: { honors_and_awards: "<p>Lifetime Achievement, no date here</p>" },
    });
    const pops = await fetchPops("x");
    expect(pops?.honors).toEqual([{ date: null, name: "Lifetime Achievement, no date here" }]);
  });
});
