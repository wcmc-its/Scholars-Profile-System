/**
 * #866 — the dark-by-default flag readers introduced for the internal-viewer
 * features: the network-signal gate (UC-A enabler) and the roster-CSV email
 * column gate (UC-B). Both follow the strict `=== "on"` convention, so every
 * other value — unset, "off", casing variants, "true" — keeps the feature dark.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isInternalViewerNetworkSignalOn } from "@/lib/auth/viewer-flags";
import { isScholarListExportEmailEnabled } from "@/lib/export/scholar-export-flags";

describe("isInternalViewerNetworkSignalOn (#866)", () => {
  const original = process.env.INTERNAL_VIEWER_NETWORK_SIGNAL;
  beforeEach(() => {
    delete process.env.INTERNAL_VIEWER_NETWORK_SIGNAL;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.INTERNAL_VIEWER_NETWORK_SIGNAL;
    else process.env.INTERNAL_VIEWER_NETWORK_SIGNAL = original;
  });

  it("defaults to false when the env is unset (ships dark)", () => {
    expect(isInternalViewerNetworkSignalOn()).toBe(false);
  });

  it("is true only for exactly 'on'", () => {
    process.env.INTERNAL_VIEWER_NETWORK_SIGNAL = "on";
    expect(isInternalViewerNetworkSignalOn()).toBe(true);
  });

  it("is false for any value that is not 'on' (incl. casing variants and 'true')", () => {
    process.env.INTERNAL_VIEWER_NETWORK_SIGNAL = "ON";
    expect(isInternalViewerNetworkSignalOn()).toBe(false);
    process.env.INTERNAL_VIEWER_NETWORK_SIGNAL = "off";
    expect(isInternalViewerNetworkSignalOn()).toBe(false);
    process.env.INTERNAL_VIEWER_NETWORK_SIGNAL = "true";
    expect(isInternalViewerNetworkSignalOn()).toBe(false);
    process.env.INTERNAL_VIEWER_NETWORK_SIGNAL = "";
    expect(isInternalViewerNetworkSignalOn()).toBe(false);
  });
});

describe("isScholarListExportEmailEnabled (#866 UC-B)", () => {
  const original = process.env.SCHOLAR_LIST_EXPORT_EMAIL;
  beforeEach(() => {
    delete process.env.SCHOLAR_LIST_EXPORT_EMAIL;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SCHOLAR_LIST_EXPORT_EMAIL;
    else process.env.SCHOLAR_LIST_EXPORT_EMAIL = original;
  });

  it("defaults to false when the env is unset (ships dark)", () => {
    expect(isScholarListExportEmailEnabled()).toBe(false);
  });

  it("is true only for exactly 'on'", () => {
    process.env.SCHOLAR_LIST_EXPORT_EMAIL = "on";
    expect(isScholarListExportEmailEnabled()).toBe(true);
  });

  it("is false for any value that is not 'on' (incl. casing variants and 'true')", () => {
    process.env.SCHOLAR_LIST_EXPORT_EMAIL = "ON";
    expect(isScholarListExportEmailEnabled()).toBe(false);
    process.env.SCHOLAR_LIST_EXPORT_EMAIL = "off";
    expect(isScholarListExportEmailEnabled()).toBe(false);
    process.env.SCHOLAR_LIST_EXPORT_EMAIL = "true";
    expect(isScholarListExportEmailEnabled()).toBe(false);
    process.env.SCHOLAR_LIST_EXPORT_EMAIL = "";
    expect(isScholarListExportEmailEnabled()).toBe(false);
  });
});
