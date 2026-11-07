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
  "- Output the paragraph only.",
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

/** Draft the pitch (Sonnet, low effort) and post-check it. Throws on a Bedrock failure. */
export async function generatePitch(input: {
  description: string;
  requester: string | null;
  concepts: readonly Pick<MatchaConcept, "term">[];
}): Promise<string> {
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
  return postCheckPitch(text);
}
