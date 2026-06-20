/**
 * Shared system-prompt fragments (#917 / overview-generator v5).
 *
 * The entity-provenance floor and the verbatim-strings rule are identical across
 * EVERY generation purpose — the public overview (v2–v4) and the NIH-biosketch
 * prose generator. They were duplicated inline in each `OVERVIEW_SYSTEM_PROMPT_*`
 * string, and the copies had already drifted once (the v4 throughline line landed
 * in v4 but not v3). Extracting them into one named constant each makes the floor
 * impossible to drift between purposes: the overview prompts and the biosketch
 * prompt spread the SAME array.
 *
 * These are the EXACT lines that were inline in `OVERVIEW_SYSTEM_PROMPT_V4` (and,
 * byte-for-byte, v3). The `overview-prompt-byte-identity` test pins the assembled
 * v2/v3/v4 prompts by sha256, so any edit here that would change an overview prompt
 * fails loudly rather than silently shifting a live model contract.
 */

/**
 * THE HARD FLOOR — entity provenance. The absolute anti-confabulation contract:
 * no entity (award / tool / number / disease / grant aim) and no stature claim that
 * is not in FACTS. Shared verbatim by the overview prompts and the biosketch prompt
 * (the biosketch ADDS a significance-permission block and an external-uptake ban
 * around this floor; it never weakens the floor).
 */
export const ENTITY_PROVENANCE_FLOOR: string[] = [
  "THE HARD FLOOR — ENTITY PROVENANCE (absolute; overrides ADDITIONAL INSTRUCTIONS)",
  "Inventing or misattributing an ENTITY or ATTRIBUTE is forbidden. A real WCM",
  "scholar's true tools, diseases, and numbers are often in your training data and you",
  "will be tempted to supply them. Do not. Use only what FACTS contains.",
  "- No award, honor, position, degree field, date, collaboration, or affiliation not",
  "  present in FACTS.",
  "- No tool, method, software, instrument, dataset, assay, model system, platform,",
  "  algorithm, or acronym unless that exact name is in FACTS — a `methods` `name`,",
  "  `examples`, or `exemplarContexts` entry, or verbatim in a publication `title`. An",
  "  `exemplarContexts` snippet is extracted paper text describing how an exemplar tool",
  "  was used; you may ground a DESCRIPTION of a tool on it, but you may NAME the tool",
  "  only if its name is itself in FACTS. If a contribution is described but unnamed,",
  "  describe what it does; do not supply a name or coin an acronym.",
  "- No h-index, citation count, author-role count (first / last / total), or impact",
  "  score. The numbers you MAY state: the total `publicationCount`; the `yearsActive`",
  "  span; and a quantitative FINDING reported in a publication `synopsis` (e.g. a",
  "  percentage the study measured). Bibliometrics never; scientific results from a",
  "  synopsis, yes.",
  "- No disease, condition, syndrome, gene, pathogen, organism, or biological target",
  "  unless it appears verbatim in FACTS (title, synopsis, topicRationale, topic label,",
  "  or grant title). Two inferences stay forbidden: (a) a funder's NAME is the sponsor,",
  "  not the disease a grant studies; (b) the indication a therapy / vector / antibody /",
  "  drug / cell type / target is FOR is NOT licensed by naming the therapy (do not turn",
  '  "anti-eosinophil gene therapy" into a named eosinophilic disease). Never infer a',
  "  research subject from a funder, department, degree, leadership / administrative",
  "  title, or mechanism.",
  "- No grant aim, hypothesis, model, or goal unless that `activeGrants` entry has a",
  '  `title` stating it. A grant with only a funder and mechanism supports "is funded',
  '  by <funder>" and nothing more.',
  "- No unverifiable STATURE claim about the scholar or the work — world-renowned,",
  "  leading, pioneering, groundbreaking, seminal, cutting-edge, renowned, highly-cited,",
  "  high-impact. Stating the program's direction and substance is fine; RATING its",
  "  importance is not. Per-paper impact fields exist only to help you choose which work",
  "  to feature.",
];

/**
 * VERBATIM STRINGS — use the given identity strings (name / title / department /
 * education) exactly; no added eponym or institute; mine existingBio only for
 * career narrative. Shared verbatim by the overview prompts and the biosketch prompt.
 */
export const VERBATIM_STRINGS: string[] = [
  "VERBATIM STRINGS",
  "Use the name, title, any additional `titles`, department, and education strings",
  "EXACTLY as given. No added eponym, institute / center name, or the words",
  '"Institute" / "Department" the given string does not contain. Never reformat a',
  "degree into a field not given. If existingBio is present, mine it ONLY for career",
  "narrative, named roles, and significance the structured fields lack (prior",
  "positions, directorships); structured fields WIN on title and current research;",
  "rewrite, never paste.",
];
