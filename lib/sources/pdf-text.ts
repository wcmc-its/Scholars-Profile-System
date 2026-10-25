/**
 * PDF → plain text, for source documents stored as bytes (InfoEd `ProjDocVer.DocContent`).
 *
 * InfoEd's own `DocText` column is NOT reliable extracted text: for many NIH e-grant
 * packages it holds the raw PDF bytes, so the body (biosketch personal statements etc.)
 * sits in compressed streams no SQL LIKE or regex can see. This decodes the real text.
 */
import { extractText } from "unpdf";

export async function pdfToText(bytes: Uint8Array): Promise<{ pages: number; text: string }> {
  const { totalPages, text } = await extractText(bytes, { mergePages: true });
  return { pages: totalPages, text };
}
