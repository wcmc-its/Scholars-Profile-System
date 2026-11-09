/**
 * Matcha targeted messages — "the pitch": a 2–3 sentence plain summary of what the partner is
 * looking for, written for the "Email individually" review queue. The officer edits it before use.
 *
 * The model reads the search's stored ask (the paste, its concepts, the requester) but must never
 * quote it: the paste may be confidential. The deterministic `postCheckPitch` then strips what the
 * prompt forbids and a regex can see (email addresses, phone numbers, URLs, dollar amounts) and
 * caps the length. Not persisted server-side (see the route).
 */
import { generateText } from "ai";
import { bedrockClient } from "@/lib/llm/client";
import { bedrockCallOptions, modelAcceptsTemperature } from "@/lib/llm/models";
import type { MatchaConcept } from "@/lib/api/matcha-contract";
import { briefModelId } from "@/lib/api/matcha-brief";

/** The hard cap after the post-check (the prompt asks for ≤ 70). */
export const PITCH_MAX_WORDS = 90;
/** The paste handed to the model is cut here (a long RFP adds cost, not meaning). */
const PITCH_ASK_CHARS = 12_000;
const PITCH_MAX_TOKENS = 400;
const PITCH_TIMEOUT_MS = 60_000;

export const PITCH_SYSTEM_PROMPT = [
  "You write ONE short paragraph for a technology-transfer officer's email to a university",
  "researcher. The paragraph tells the researcher, in plain language, what an industry partner is",
  "looking for, so the researcher can decide whether to talk.",
  "",
  "Rules:",
  "- 2 to 3 sentences, at most 70 words. Plain prose, no lists, no headings, no quotation marks.",
  "- Summarize in your own words. NEVER quote or closely copy the source text: it may be confidential.",
  "- Never include contact details, names of individual people, email signatures, phone numbers,",
  "  web addresses, dollar amounts, budgets or other financial terms.",
  "- Leave out anything the source marks as confidential, proprietary, internal or not for distribution.",
  '- If a REQUESTER is given, you may name that organization. If not, say "the partner" and never',
  "  name or hint at any company, sponsor or organization.",
  "- Do not mention the researcher, the officer, Weill Cornell or this email. Describe the partner's",
  "  interest only (the problem, the kind of expertise or collaboration they want).",
  "- Also write a SUBJECT line for the email, at most 10 words: who is asking (the REQUESTER, or",
  '  "Industry partner" when none is given), the kind of opportunity and the topic in lowercase,',
  '  e.g. "Example Society pilot funding: sleep medicine research". No quotation marks.',
  "",
  "Output exactly two lines:",
  "SUBJECT: <the subject>",
  "PITCH: <the paragraph>",
].join("\n");

export function buildPitchPrompt(input: {
  description: string;
  requester: string | null;
  concepts: readonly Pick<MatchaConcept, "term">[];
}): string {
  return [
    `REQUESTER: ${input.requester?.trim() || "(none: do not name any organization)"}`,
    "",
    "CONCEPTS THE ASK IS ABOUT:",
    ...(input.concepts.length > 0 ? input.concepts.map((c) => `- ${c.term}`) : ["- (none listed)"]),
    "",
    "THE PARTNER'S ASK (source text; summarize, never quote):",
    "<ASK>",
    input.description.slice(0, PITCH_ASK_CHARS),
    "</ASK>",
  ].join("\n");
}

const EMAIL_RE = /[^\s@<>()]+@[^\s@<>()]+\.[A-Za-z]{2,}/g;
// Sentence punctuation after a link stays with the sentence.
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()]*[^\s<>().,;:!?]/gi;
// 10+ digit runs with the usual separators: (212) 555-0100, +1 212.555.0100, 212-555-0100.
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\b\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const DOLLAR_RE = /(?:US)?\$\s?\d(?:[\d,.]*\d)?(?:\s?(?:[kKmMbB]\b|million|billion|thousand))?/g;

/**
 * Deterministic clean-up of a drafted pitch: email addresses, URLs, phone numbers and dollar
 * amounts removed; whitespace collapsed; then at most `PITCH_MAX_WORDS` words, cut back to the
 * last whole sentence inside the cap when there is one.
 */
export function postCheckPitch(raw: string): string {
  let t = raw
    .replace(EMAIL_RE, "")
    .replace(URL_RE, "")
    .replace(PHONE_RE, "")
    .replace(DOLLAR_RE, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .trim();
  const words = t.split(" ").filter(Boolean);
  if (words.length > PITCH_MAX_WORDS) {
    t = words.slice(0, PITCH_MAX_WORDS).join(" ");
    const end = Math.max(t.lastIndexOf(". "), t.lastIndexOf("! "), t.lastIndexOf("? "));
    t = /[.!?]$/.test(t) ? t : end > 0 ? t.slice(0, end + 1) : t;
  }
  return t;
}

/** Longest subject kept, in words. */
export const SUBJECT_MAX_WORDS = 14;

/** The model's two labelled lines → `{ subject, pitch }`, both post-checked. Unlabelled output
 *  is all pitch with no subject (the email then falls back to the template subject). */
export function parsePitchOutput(raw: string): { subject: string; pitch: string } {
  const subjectMatch = /^\s*SUBJECT:\s*(.+)$/im.exec(raw);
  const pitchMatch = /^\s*PITCH:\s*([\s\S]+)$/im.exec(raw);
  const subject = subjectMatch
    ? postCheckPitch(subjectMatch[1].replace(/["“”]/g, ""))
        .split(" ")
        .slice(0, SUBJECT_MAX_WORDS)
        .join(" ")
        .replace(/[.]$/, "")
    : "";
  const pitch = postCheckPitch(pitchMatch ? pitchMatch[1] : raw.replace(/^\s*SUBJECT:.*$/im, ""));
  return { subject, pitch };
}

/** Draft the pitch and subject (Sonnet, low effort) and post-check them. Throws on a Bedrock
 *  failure. */
export async function generatePitch(input: {
  description: string;
  requester: string | null;
  concepts: readonly Pick<MatchaConcept, "term">[];
}): Promise<{ subject: string; pitch: string }> {
  const modelId = briefModelId();
  const { text } = await generateText({
    model: bedrockClient()(modelId),
    system: PITCH_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildPitchPrompt(input) }],
    maxOutputTokens: PITCH_MAX_TOKENS,
    abortSignal: AbortSignal.timeout(PITCH_TIMEOUT_MS),
    ...(modelAcceptsTemperature(modelId) ? { temperature: 0.3 } : {}),
    ...bedrockCallOptions(modelId, { effort: "low" }),
  });
  return parsePitchOutput(text);
}

// ── Per-person lines ─────────────────────────────────────────────────────────

/** At most this many evidence bullets per message. */
export const LINES_MAX_BULLETS = 3;
/** A bullet longer than this is not a bullet and is dropped. */
export const LINES_BULLET_MAX_WORDS = 20;
/** The idea sentence is cut back to this many words. */
export const LINES_IDEA_MAX_WORDS = 25;

export const LINES_SYSTEM_PROMPT = [
  "You write two short parts of a technology-transfer officer's email TO one university researcher,",
  "from a brief the officer's tool wrote ABOUT that researcher in the third person.",
  "",
  "1. BULLETS: 2 or 3 short fragments (at most 15 words each) giving the concrete facts from the",
  "   brief that make this researcher a fit: trials, cohorts, methods, measures, findings. They sit",
  '   under the heading "Why I thought of you:", so they address the reader implicitly: write',
  '   "Nine clinical trials, including pilot randomized designs", never the researcher\'s name,',
  '   "he", "she", "they" or "Dr.". "Your" is fine. No trailing periods.',
  '2. IDEA: one sentence (at most 20 words) naming one thing to discuss, written to follow "One idea',
  '   to discuss:", e.g. "caregiver coaching in cardiac rehabilitation."',
  "",
  "Rules:",
  "- Use only facts stated in the brief. Never invent numbers, names or results.",
  '- Sound like a person, not a database: never write "on record", "match", "matched", "score",',
  '  "brief" or "the tool".',
  "- Never include email addresses, phone numbers, web addresses or dollar amounts.",
  '- Output JSON only: {"bullets": ["...", "..."], "idea": "..."}',
].join("\n");

export type EmailLinesInput = {
  name: string;
  role: string;
  angle: string;
  why: string;
  topics: readonly string[];
  methods: readonly string[];
  trialCount: number;
};

export function buildLinesPrompt(input: EmailLinesInput): string {
  return [
    `RESEARCHER (never name them in the output): ${input.name}`,
    "",
    "BRIEF:",
    input.role ? `Role: ${input.role}` : null,
    input.angle ? `Partnership angle: ${input.angle}` : null,
    input.why ? `Why a fit: ${input.why}` : null,
    input.topics.length > 0
      ? `Discussion topics:\n${input.topics.map((t) => `- ${t}`).join("\n")}`
      : null,
    input.methods.length > 0 ? `Methods and data: ${input.methods.join("; ")}` : null,
    input.trialCount > 0 ? `Clinical trials: ${input.trialCount}` : null,
  ]
    .filter((l): l is string => l != null)
    .join("\n");
}

/** A text's words, lowercased (letters, apostrophes and hyphens kept inside a word). */
function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}'-]+/gu) ?? [];
}

/** Words that would name the researcher in the third person: the name's words of 3+ letters. */
function nameWords(name: string): Set<string> {
  return new Set(words(name).filter((w) => w.length >= 3));
}

const THIRD_PERSON_RE = /\b(?:he|she|his|her|hers|him|Dr\.)(?=\s|$|[,.;:])/i;

/**
 * Deterministic clean-up of the model's JSON: contact details and amounts stripped (as the pitch),
 * bullets without trailing periods, any part that names the researcher or uses he/she/Dr. dropped
 * (the third-person leak this step exists to remove), at most `LINES_MAX_BULLETS` bullets of at
 * most `LINES_BULLET_MAX_WORDS` words, and the idea cut to `LINES_IDEA_MAX_WORDS` words with a
 * closing period. Unparseable output ⇒ nothing.
 */
export function postCheckEmailLines(
  raw: string,
  name: string,
): { bullets: string[]; idea: string } {
  const json = /\{[\s\S]*\}/.exec(raw)?.[0];
  let parsed: { bullets?: unknown; idea?: unknown } = {};
  try {
    parsed = json ? (JSON.parse(json) as typeof parsed) : {};
  } catch {
    parsed = {};
  }
  const named = nameWords(name);
  const leaks = (t: string) => words(t).some((w) => named.has(w)) || THIRD_PERSON_RE.test(t);
  const bullets = (Array.isArray(parsed.bullets) ? parsed.bullets : [])
    .filter((b): b is string => typeof b === "string")
    .map((b) =>
      postCheckPitch(b)
        .replace(/^[-•*]\s*/, "")
        .replace(/[.;]+$/, ""),
    )
    .filter((b) => b && !leaks(b) && b.split(" ").length <= LINES_BULLET_MAX_WORDS)
    .slice(0, LINES_MAX_BULLETS);
  let idea = typeof parsed.idea === "string" ? postCheckPitch(parsed.idea) : "";
  const words = idea.split(" ").filter(Boolean);
  if (words.length > LINES_IDEA_MAX_WORDS) idea = words.slice(0, LINES_IDEA_MAX_WORDS).join(" ");
  idea = idea.replace(/[,;:\s]+$/, "");
  if (idea && !/[.!?]$/.test(idea)) idea += ".";
  if (leaks(idea)) idea = "";
  // Follows "One idea to discuss:", so it starts lowercase unless it opens on an acronym/name.
  if (/^[A-Z][a-z]/.test(idea)) idea = idea[0].toLowerCase() + idea.slice(1);
  return { bullets, idea };
}

/** Draft one researcher's bullets and idea from their brief (Sonnet, low effort). */
export async function generateEmailLines(
  input: EmailLinesInput,
): Promise<{ bullets: string[]; idea: string }> {
  const modelId = briefModelId();
  const { text } = await generateText({
    model: bedrockClient()(modelId),
    system: LINES_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildLinesPrompt(input) }],
    maxOutputTokens: PITCH_MAX_TOKENS,
    abortSignal: AbortSignal.timeout(PITCH_TIMEOUT_MS),
    ...(modelAcceptsTemperature(modelId) ? { temperature: 0.3 } : {}),
    ...bedrockCallOptions(modelId, { effort: "low" }),
  });
  return postCheckEmailLines(text, input.name);
}
