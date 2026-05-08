/**
 * Parse a grant's funder + award number into a display-ready eyebrow line.
 *
 * Examples:
 *   parseFunderEyebrow("NIH",  "R01 NS123456") -> "NIH/NINDS · R01 NS123456"
 *   parseFunderEyebrow("NIH",  "R01 CA456789") -> "NIH/NCI · R01 CA456789"
 *   parseFunderEyebrow("NIH",  "U01 AI234567") -> "NIH/NIAID · U01 AI234567"
 *   parseFunderEyebrow("NIH",  null)            -> "NIH"
 *   parseFunderEyebrow("NSF",  "IIS-2123456")  -> "NSF · IIS-2123456"
 *   parseFunderEyebrow("ACS",  "RSG-21-001")   -> "ACS · RSG-21-001"
 *
 * NIH institute lookup uses the 2-letter activity code prefix on the serial
 * number (NS = NINDS, CA = NCI, etc.). When the funder is NIH but the
 * institute can't be parsed, falls back to "NIH · {awardNumber}".
 */

import { NIH_INSTITUTE_BY_PREFIX } from "@/lib/nih-ic-prefixes";

export function parseFunderEyebrow(
  funder: string | null | undefined,
  awardNumber: string | null | undefined,
): string {
  const f = (funder ?? "").trim();
  const aw = (awardNumber ?? "").trim();
  if (!f && !aw) return "";
  if (!aw) return f;
  if (!f) return aw;

  const isNih = /^nih\b/i.test(f);
  if (isNih) {
    // Match "R01 NS123456" / "R01NS123456" / "1R01NS123456-01A1"
    const m = aw.match(/^(?:[1-9])?\s*([A-Z]\d{2})\s*([A-Z]{2})\s*(\d{4,})/i);
    if (m) {
      const mechanism = m[1].toUpperCase();
      const prefix = m[2].toUpperCase();
      const serial = m[3];
      const inst = NIH_INSTITUTE_BY_PREFIX[prefix];
      if (inst) {
        return `NIH/${inst} · ${mechanism} ${prefix}${serial}`;
      }
    }
    return `NIH · ${aw}`;
  }
  return `${f} · ${aw}`;
}
