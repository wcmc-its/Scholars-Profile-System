/**
 * Streaming SAX parser for NLM MeSH desc<year>.xml.
 *
 * The 2026 descriptor file is ~360 MB uncompressed (~30k DescriptorRecord
 * elements). In-memory XML parsing (xml2js, fast-xml-parser non-stream mode)
 * blows the heap; sax-stream avoids that by emitting events as bytes arrive.
 *
 * Returns an async iterator of ParsedDescriptor objects so the caller can
 * consume + upsert in batches without buffering the full corpus.
 *
 * NLM XML shape relevant to us:
 *   <DescriptorRecord>
 *     <DescriptorUI>D000001</DescriptorUI>
 *     <DescriptorName><String>Calcimycin</String></DescriptorName>
 *     <DateRevised><Year>2024</Year><Month>03</Month><Day>15</Day></DateRevised>
 *     <TreeNumberList>
 *       <TreeNumber>D03.633.100.221.173</TreeNumber>
 *     </TreeNumberList>
 *     <ConceptList>
 *       <Concept PreferredConceptYN="Y">
 *         <ScopeNote>...</ScopeNote>
 *         <TermList>
 *           <Term ...><String>Calcimycin</String></Term>
 *           <Term ...><String>A 23187</String></Term>
 *         </TermList>
 *       </Concept>
 *       <Concept PreferredConceptYN="N">
 *         <TermList>
 *           <Term ...><String>Antibiotic A23187</String></Term>
 *         </TermList>
 *       </Concept>
 *     </ConceptList>
 *   </DescriptorRecord>
 */
import { Readable } from "node:stream";
import sax from "sax";

export interface ParsedDescriptor {
  descriptorUi: string;
  name: string;
  /** All Term/String values across all Concepts, deduped, EXCLUDING `name`. */
  entryTerms: string[];
  treeNumbers: string[];
  /** ScopeNote of the preferred Concept (PreferredConceptYN="Y"); null otherwise. */
  scopeNote: string | null;
  /** ISO date string (YYYY-MM-DD) or null if absent / malformed. */
  dateRevised: string | null;
}

interface ParserState {
  descriptorUi: string;
  inDescriptorName: boolean;
  inPreferredConcept: boolean;
  inAnyConcept: boolean;
  preferredScopeNote: string;
  termStrings: string[];
  treeNumbers: string[];
  dateYear: string;
  dateMonth: string;
  dateDay: string;
}

function emptyState(): ParserState {
  return {
    descriptorUi: "",
    inDescriptorName: false,
    inPreferredConcept: false,
    inAnyConcept: false,
    preferredScopeNote: "",
    termStrings: [],
    treeNumbers: [],
    dateYear: "",
    dateMonth: "",
    dateDay: "",
  };
}

function buildDescriptor(s: ParserState, descriptorName: string): ParsedDescriptor | null {
  if (!s.descriptorUi || !descriptorName) return null;
  // Dedupe term strings case-insensitively, EXCLUDING the descriptor name.
  // Preserve the first-seen surface form (NLM order is meaningful: preferred
  // concept's preferred term comes first, which matches descriptorName).
  const seen = new Set<string>([descriptorName.toLowerCase()]);
  const entryTerms: string[] = [];
  for (const t of s.termStrings) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entryTerms.push(t);
  }
  const dateRevised =
    s.dateYear && s.dateMonth && s.dateDay
      ? `${s.dateYear}-${s.dateMonth.padStart(2, "0")}-${s.dateDay.padStart(2, "0")}`
      : null;
  return {
    descriptorUi: s.descriptorUi,
    name: descriptorName,
    entryTerms,
    treeNumbers: s.treeNumbers,
    scopeNote: s.preferredScopeNote ? s.preferredScopeNote.trim() : null,
    dateRevised,
  };
}

/**
 * Stream-parse a MeSH descriptor XML byte stream and yield one
 * ParsedDescriptor per `<DescriptorRecord>`.
 */
export async function* parseMeshXmlStream(
  source: Readable,
): AsyncGenerator<ParsedDescriptor> {
  // Buffered yield queue: SAX is event-driven, generator is pull-driven. We
  // bridge by pushing descriptors into a queue and resuming the generator's
  // Promise whenever new items arrive or the stream ends.
  const queue: ParsedDescriptor[] = [];
  let streamEnded = false;
  let streamError: Error | null = null;
  let resolveWaiter: (() => void) | null = null;

  const notify = () => {
    if (resolveWaiter) {
      const r = resolveWaiter;
      resolveWaiter = null;
      r();
    }
  };

  const parser = sax.createStream(true, {
    trim: true,
    normalize: false,
    lowercase: false,
    xmlns: false,
    position: false,
  });

  // Element path stack. We only care about leaf-text events under specific
  // ancestors, so a shallow array is enough — no need for a tree.
  const path: string[] = [];
  let state = emptyState();
  let descriptorName = "";
  let textBuffer = "";
  let depthDescriptor = -1; // path depth when entering DescriptorRecord; resets on close.

  const at = (...names: string[]): boolean => {
    if (path.length < names.length) return false;
    for (let i = 0; i < names.length; i++) {
      if (path[path.length - names.length + i] !== names[i]) return false;
    }
    return true;
  };

  parser.on("opentag", (node) => {
    path.push(node.name);
    textBuffer = "";

    if (node.name === "DescriptorRecord") {
      state = emptyState();
      descriptorName = "";
      depthDescriptor = path.length;
      return;
    }
    if (depthDescriptor < 0) return;

    if (node.name === "Concept") {
      state.inAnyConcept = true;
      const attrs = node.attributes as Record<string, string>;
      state.inPreferredConcept = attrs.PreferredConceptYN === "Y";
    } else if (node.name === "DescriptorName") {
      state.inDescriptorName = true;
    }
  });

  parser.on("text", (text) => {
    textBuffer += text;
  });

  parser.on("cdata", (cdata) => {
    textBuffer += cdata;
  });

  parser.on("closetag", (name) => {
    const text = textBuffer;
    textBuffer = "";

    if (depthDescriptor >= 0 && name === "String") {
      // DescriptorRecord > DescriptorName > String → descriptor name
      if (state.inDescriptorName && at("DescriptorName", "String")) {
        descriptorName = text;
      } else if (
        state.inAnyConcept &&
        at("Term", "String") &&
        text.length > 0
      ) {
        // Every Term/String anywhere in ConceptList contributes to entryTerms
        // (we dedupe + drop the descriptor name at finalize time).
        state.termStrings.push(text);
      }
    } else if (depthDescriptor >= 0 && name === "TreeNumber" && text.length > 0) {
      state.treeNumbers.push(text);
    } else if (depthDescriptor >= 0 && name === "ScopeNote" && state.inPreferredConcept) {
      // Only the preferred Concept's ScopeNote is the descriptor-level note.
      state.preferredScopeNote = text;
    } else if (depthDescriptor >= 0 && name === "DescriptorUI" && path.length === depthDescriptor + 1) {
      // Top-level DescriptorUI (direct child of DescriptorRecord) — NOT the
      // QualifierUI / ConceptUI / TermUI nested deeper in the record.
      state.descriptorUi = text;
    } else if (depthDescriptor >= 0 && path.length === depthDescriptor + 2) {
      // Direct children of DateRevised (Year, Month, Day).
      const parent = path[path.length - 2];
      if (parent === "DateRevised") {
        if (name === "Year") state.dateYear = text;
        else if (name === "Month") state.dateMonth = text;
        else if (name === "Day") state.dateDay = text;
      }
    }

    if (name === "DescriptorName") state.inDescriptorName = false;
    if (name === "Concept") {
      state.inAnyConcept = false;
      state.inPreferredConcept = false;
    }

    path.pop();

    if (name === "DescriptorRecord") {
      const built = buildDescriptor(state, descriptorName);
      depthDescriptor = -1;
      if (built) {
        queue.push(built);
        notify();
      }
    }
  });

  parser.on("error", (err) => {
    streamError = err instanceof Error ? err : new Error(String(err));
    notify();
  });
  parser.on("end", () => {
    streamEnded = true;
    notify();
  });

  source.on("error", (err) => {
    streamError = err instanceof Error ? err : new Error(String(err));
    notify();
  });

  source.pipe(parser);

  while (true) {
    if (streamError) throw streamError;
    if (queue.length > 0) {
      const next = queue.shift()!;
      yield next;
      continue;
    }
    if (streamEnded) return;
    await new Promise<void>((resolve) => {
      resolveWaiter = resolve;
    });
  }
}
