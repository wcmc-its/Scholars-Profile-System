export const meta = {
  name: 'sponsor-gold-judge',
  description: 'Evidence-grounded LLM judge + adversarial verify → graded gold ideal[] per sponsor fixture',
  phases: [
    { title: 'Judge', detail: 'grade each candidate 0-3 from the evidence bundle' },
    { title: 'Verify', detail: 'adversarially refute the 3s, confirm the 0s' },
  ],
}

// args = [{ id, topic, bundlePath }, ...] — one per fixture. Evidence bundles are
// pre-retrieved JSON files (real, MeSH-independent-ish substance) the agents Read.

const GRADE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ideal: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cwid: { type: 'string' },
          grade: { type: 'integer', minimum: 0, maximum: 3 },
          confidence: { type: 'string', enum: ['high', 'med', 'low'] },
          rationale: { type: 'string' },
        },
        required: ['cwid', 'grade', 'confidence', 'rationale'],
      },
    },
  },
  required: ['ideal'],
}

const RUBRIC = `GRADE (0-3): 3 = the person you'd name first, work centers on THIS topic. 2 = strong, genuinely on-topic. 1 = marginal/tangential but not wrong. 0 = FALSE POSITIVE, matches the words but really a different domain.

HOW TO WEIGH EVIDENCE (never grade on any single number):
1. \`overview\` (human bio) + \`title\`/role are STRONGEST. A stated program directorship or research focus ON the topic => likely 3; an off-topic role (e.g. orthopedic surgery) => low.
2. Substance: \`openalex.topTopicalWorks\` titles + \`openalex.topics\` + \`areas\` = what they ACTUALLY work on.
3. \`meshTagged.focusPct\` = % of their pubs tagged with the topic. HIGH => specialist; LOW (<~5%) + off-topic role => incidental/false positive.
4. \`openalex.citations\` = general stature, SECONDARY. A focused specialist with FEW citations (junior, or a rare niche) can STILL be 3. Never let citations earned in an OFF-topic area inflate a grade.

DISAMBIGUATION GUARD: \`openalex\` is name-matched and may be the WRONG same-name person. If openalex.topics/topTopicalWorks CONTRADICT the Scholars title/overview/meshTagged (e.g. OA=cancer genomics but 75% of pubs MeSH-tagged the topic + clinical title), treat OA as a probable name collision (esp. sameNameCount>1 and topicalWorkCount=0) and grade from the Scholars-side signals.`

// args may arrive as a JSON string depending on how it was passed — parse defensively.
const FIXTURES = typeof args === 'string' ? JSON.parse(args) : args
if (!Array.isArray(FIXTURES)) throw new Error('args must be an array of {id,topic,bundlePath}')

const results = await pipeline(
  FIXTURES,
  // stage 1 — judge
  (fx) => agent(
    `You grade how well each Weill Cornell scholar matches a research-funding sponsor's TOPIC. Read the evidence file ${fx.bundlePath} (a JSON array of scholar evidence bundles).

SPONSOR TOPIC: "${fx.topic}"

${RUBRIC}

Grade EVERY scholar in the file. Return {ideal:[{cwid, grade, confidence, rationale}]} — rationale <=25 words naming the deciding evidence. This is the whole graded pool for one fixture.`,
    { label: `judge:${fx.id}`, phase: 'Judge', schema: GRADE_SCHEMA }
  ).then((j) => ({ ...fx, judged: (j && j.ideal) || [] })),

  // stage 2 — adversarial verify (refute the 3s, confirm the 0s)
  (fx) => agent(
    `You are a SKEPTICAL verifier auditing another judge's sponsor-match grades. Read the evidence file ${fx.bundlePath}.

SPONSOR TOPIC: "${fx.topic}"

The judge's grades: ${JSON.stringify(fx.judged)}

For EACH scholar:
- If graded 3: try to REFUTE "leading expert on this topic". If the evidence (role/overview, on-topic works, focus%) does not clearly support name-first expertise, DEMOTE (to 2 or 1) and say why. A high citation count in an OFF-topic area is NOT support.
- If graded 0: confirm they are genuinely off-domain; if the evidence actually shows real topical work, PROMOTE.
- Watch for OpenAlex name-collisions the judge may have trusted or over-corrected (sameNameCount>1, topics contradicting the Scholars profile).
- Otherwise keep the grade.

${RUBRIC}

Return the FINAL adjusted {ideal:[{cwid, grade, confidence, rationale}]} for ALL scholars (rationale reflects the verified call).`,
    { label: `verify:${fx.id}`, phase: 'Verify', schema: GRADE_SCHEMA }
  ).then((v) => ({ id: fx.id, topic: fx.topic, ideal: (v && v.ideal) || fx.judged })),
)

return results.filter(Boolean)
