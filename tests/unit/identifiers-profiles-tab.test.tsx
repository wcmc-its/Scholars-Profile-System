/**
 * The "Identifiers & Profiles" `/edit` rail item and its ORCID card.
 *
 * ORCID lived as a read-only row on Name & Title with a hand-off to ReCiter's
 * Manage Profile page, which only works on the campus network. It is now its own
 * owned tab where the scholar confirms the inferred iD or enters one; Name & Title
 * keeps a pointer. Ungated, like Honors: a scholar with nothing on file needs the
 * tab in order to add it.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { visibleAttrKeys } from "@/components/edit/edit-page";
import { OrcidCard } from "@/components/edit/orcid-card";
import { ProfileLinksCard } from "@/components/edit/profile-links-card";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

describe("visibleAttrKeys — Identifiers & Profiles rail item", () => {
  const ON = [
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    true,
  ] as const;
  it("with the flag on: its own rail key, right after Honors, on every writing surface", () => {
    for (const mode of ["self", "superuser", "comms_steward", "proxy", "unit-admin"] as const) {
      const keys = visibleAttrKeys(mode, ...ON);
      expect(keys.indexOf("identifiers-profiles")).toBe(keys.indexOf("honors") + 1);
    }
  });

  it("with the flag off (the default): absent — the tab, its write, and the suggestion share one kill switch", () => {
    expect(visibleAttrKeys("self", false)).not.toContain("identifiers-profiles");
    expect(visibleAttrKeys("superuser", false)).not.toContain("identifiers-profiles");
  });

  it("is not gated on a has-rows precondition: a scholar with nothing on file needs the tab to add it", () => {
    expect(visibleAttrKeys("self", ...ON)).toContain("identifiers-profiles");
  });
});

describe("OrcidCard", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    refresh.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("on file → the iD linked to orcid.org; Change reveals the input", () => {
    render(
      <OrcidCard
        cwid="abc1234"
        mode="self"
        scholarName="Ada"
        onFile="0000-0002-1825-0097"
        suggested={null}
      />,
    );
    const onFile = screen.getByTestId("orcid-on-file");
    expect(onFile.querySelector("a")?.getAttribute("href")).toBe(
      "https://orcid.org/0000-0002-1825-0097",
    );
    expect(screen.getByTestId("orcid-on-file-status").textContent).toBe("On file");
    expect(screen.queryByTestId("orcid-form")).toBeNull();
    fireEvent.click(screen.getByTestId("orcid-change"));
    expect(screen.getByTestId("orcid-form")).toBeTruthy();
  });

  it("suggested → 'Confirm this iD' POSTs the suggested iD with confirmedSuggestion; the pill flips to Confirmed", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, orcid: "0000-0002-1825-0097" }),
    });
    render(
      <OrcidCard
        cwid="abc1234"
        mode="self"
        scholarName="Ada"
        onFile={null}
        suggested={{
          orcid: "0000-0002-1825-0097",
          accepted: 1,
          evidence: [
            { source: "rpm_inferred", accepted: 1, rejected: 0 },
            { source: "orcid_email", accepted: 0, rejected: 0 },
          ],
        }}
      />,
    );
    expect(screen.getByTestId("orcid-suggested-status").textContent).toBe(
      "High confidence suggestion",
    );
    const why = screen.getByTestId("orcid-suggested-evidence");
    expect(why.querySelectorAll("li")).toHaveLength(2);
    expect(why.textContent).toContain("Matched on 1 of your accepted publications in ReCiter");
    expect(why.textContent).toContain("The ORCID registry record lists your WCM email");
    fireEvent.click(screen.getByTestId("orcid-confirm"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/orcid");
    expect(JSON.parse(init.body as string)).toEqual({
      cwid: "abc1234",
      orcid: "0000-0002-1825-0097",
      confirmedSuggestion: true,
    });
    // The card shows the saved iD without waiting for the refresh, and the
    // evidence it was confirmed on stays under it.
    expect(screen.getByTestId("orcid-on-file").textContent).toContain("0000-0002-1825-0097");
    expect(screen.getByTestId("orcid-on-file-status").textContent).toBe("Confirmed");
    const lines = [...screen.getByTestId("orcid-on-file-evidence").querySelectorAll("li")].map(
      (li) => li.textContent,
    );
    expect(lines[0]).toBe("Confirmed by you");
    expect(lines).toHaveLength(3);
  });

  it("on file → the evidence persists under the iD; Remove POSTs orcid: null and the card empties", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, orcid: null }),
    });
    render(
      <OrcidCard
        cwid="abc1234"
        mode="self"
        scholarName="Ada"
        onFile="0000-0002-1825-0097"
        onFileEvidence={[
          { source: "rpm_admin", accepted: 0, rejected: 0 },
          { source: "rpm_inferred", accepted: 12, rejected: 0 },
        ]}
        suggested={null}
      />,
    );
    const why = screen.getByTestId("orcid-on-file-evidence");
    expect(why.textContent).toContain("Entered in ReCiter Publication Manager");
    expect(why.textContent).toContain("Matched on 12 of your accepted publications in ReCiter");
    fireEvent.click(screen.getByTestId("orcid-remove"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      cwid: "abc1234",
      orcid: null,
      confirmedSuggestion: false,
    });
    expect(screen.queryByTestId("orcid-on-file")).toBeNull();
    expect(screen.getByTestId("orcid-form")).toBeTruthy();
  });

  it("on file + a DIFFERENT strong inference → both rows, each labelled; 'Replace with the suggested iD' swaps, 'Keep the iD on file' dismisses for the session", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, orcid: "0000-0002-9930-2193" }),
    });
    render(
      <OrcidCard
        cwid="abc1234"
        mode="self"
        scholarName="Ada"
        onFile="0000-0002-1825-0097"
        suggested={{
          orcid: "0000-0002-9930-2193",
          accepted: 4,
          evidence: [{ source: "rpm_inferred", accepted: 4, rejected: 0 }],
        }}
      />,
    );
    expect(screen.queryByTestId("orcid-suggested")).toBeNull();
    expect(screen.getByTestId("orcid-on-file").textContent).toContain("0000-0002-1825-0097");
    expect(screen.getByTestId("orcid-on-file-status").textContent).toBe("On file");
    const also = screen.getByTestId("orcid-also-suggested");
    expect(also.textContent).toContain("0000-0002-9930-2193");
    expect(screen.getByTestId("orcid-also-suggested-status").textContent).toBe(
      "High confidence suggestion",
    );
    expect(screen.getByTestId("orcid-remove").textContent).toBe("Remove both");
    // Keep → the competing row and its actions go; plain Change / Remove return.
    fireEvent.click(screen.getByTestId("orcid-keep-on-file"));
    expect(screen.queryByTestId("orcid-also-suggested")).toBeNull();
    expect(screen.getByTestId("orcid-change")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    cleanup();
    fetchMock.mockClear();
    render(
      <OrcidCard
        cwid="abc1234"
        mode="self"
        scholarName="Ada"
        onFile="0000-0002-1825-0097"
        suggested={{
          orcid: "0000-0002-9930-2193",
          accepted: 4,
          evidence: [{ source: "rpm_inferred", accepted: 4, rejected: 0 }],
        }}
      />,
    );
    fireEvent.click(screen.getByTestId("orcid-use-suggested"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      cwid: "abc1234",
      orcid: "0000-0002-9930-2193",
      confirmedSuggestion: true,
    });
    expect(screen.getByTestId("orcid-on-file").textContent).toContain("0000-0002-9930-2193");
    expect(screen.queryByTestId("orcid-also-suggested")).toBeNull();
  });

  it("superuser voice names the scholar by first name — second person is the editor", () => {
    render(
      <OrcidCard
        cwid="xyz9876"
        mode="superuser"
        scholarName="Grace Hopper"
        onFile={null}
        suggested={{
          orcid: "0000-0002-1694-233X",
          accepted: 91,
          evidence: [{ source: "rpm_inferred", accepted: 91, rejected: 2 }],
        }}
      />,
    );
    const sug = screen.getByTestId("orcid-suggested");
    expect(sug.textContent).toContain(
      "Matched on 91 of Grace's accepted publications in ReCiter, and on 2 Grace rejected",
    );
    expect(screen.getByText(/makes Grace's publication matching/)).toBeTruthy();
    expect(screen.getByTestId("orcid-confirm").textContent).toBe("Confirm this iD");
  });

  it("none → the input; a bad check digit is refused client-side without a request", async () => {
    render(
      <OrcidCard cwid="abc1234" mode="self" scholarName="Ada" onFile={null} suggested={null} />,
    );
    const input = screen.getByLabelText("ORCID iD");
    fireEvent.change(input, { target: { value: "0000-0002-1825-0098" } });
    fireEvent.click(screen.getByTestId("orcid-save"));
    expect(await screen.findByTestId("orcid-error")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("none → a typed URL form is normalized and POSTed; a 502 from the route is shown and nothing is marked saved", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ ok: false, error: "reciter_unavailable" }),
    });
    render(
      <OrcidCard cwid="abc1234" mode="self" scholarName="Ada" onFile={null} suggested={null} />,
    );
    fireEvent.change(screen.getByLabelText("ORCID iD"), {
      target: { value: "https://orcid.org/0000000218250097" },
    });
    fireEvent.click(screen.getByTestId("orcid-save"));
    expect(await screen.findByTestId("orcid-error")).toBeTruthy();
    expect(screen.getByTestId("orcid-error").textContent).toContain("ReCiter is unreachable");
    expect(
      JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string).orcid,
    ).toBe("0000-0002-1825-0097");
    expect(screen.queryByTestId("orcid-on-file")).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("ProfileLinksCard", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    refresh.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("fields show handles (stored URLs reduced), a pasted URL reduces on blur, Save is inert until a field differs and sends each handle with its prefix back on", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        value: JSON.stringify({
          linkedin: "https://www.linkedin.com/in/oelemento",
          x: "https://x.com/ada",
        }),
      }),
    });
    render(
      <ProfileLinksCard
        cwid="abc1234"
        mode="self"
        scholarName="Ada"
        initial={{ linkedin: "https://www.linkedin.com/in/oelemento" }}
        subsection
      />,
    );
    // Host prefix beside the label; the stored canonical URL shows as its handle.
    expect(screen.getByText("linkedin.com/in/")).toBeTruthy();
    const linkedin = screen.getByTestId("profile-link-linkedin") as HTMLInputElement;
    expect(linkedin.getAttribute("placeholder")).toBe("handle");
    expect(linkedin.value).toBe("oelemento");
    const save = screen.getByTestId("profile-links-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByTestId("profile-links-hint").textContent).toBe("No changes yet");
    // A pasted full URL into the X field reduces to the handle on blur.
    const x = screen.getByTestId("profile-link-x") as HTMLInputElement;
    fireEvent.change(x, { target: { value: "https://twitter.com/ada?s=21" } });
    expect(save.disabled).toBe(false);
    expect(screen.getByTestId("profile-links-hint").textContent).toBe("Unsaved changes");
    fireEvent.blur(x);
    expect(x.value).toBe("ada");
    // Re-pasting the stored value is not a change.
    fireEvent.change(linkedin, { target: { value: "linkedin.com/in/oelemento/" } });
    fireEvent.blur(linkedin);
    expect(linkedin.value).toBe("oelemento");
    fireEvent.click(save);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).value).toEqual({
      linkedin: "linkedin.com/in/oelemento",
      x: "x.com/ada",
      bluesky: "",
      googleScholar: "",
      researchGate: "",
    });
    expect(x.value).toBe("ada");
    expect(screen.getByTestId("profile-links-hint").textContent).toBe("Saved just now");
    expect(save.disabled).toBe(true);
  });
});
