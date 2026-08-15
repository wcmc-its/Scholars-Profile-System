import { MechanismAbbr } from "scholars-profile-system";

export function CommonCodes() {
  return (
    <ul className="flex flex-col gap-1.5 p-4 text-sm">
      <li>
        <MechanismAbbr code="R01" /> — Tumor-intrinsic drivers of checkpoint blockade resistance
      </li>
      <li>
        <MechanismAbbr code="K23" /> — Mentored patient-oriented career development award
      </li>
      <li>
        <MechanismAbbr code="U54" /> — Center for AI-enabled cancer diagnostics
      </li>
      <li>
        <MechanismAbbr code="T32" /> — Institutional training grant in translational immunology
      </li>
      <li>
        <MechanismAbbr code="P30" /> — Cancer center support grant
      </li>
    </ul>
  );
}

export function UnknownCodeFallback() {
  return (
    <div className="p-4 text-sm">
      Mechanism: <MechanismAbbr code="ZIA" />
    </div>
  );
}
