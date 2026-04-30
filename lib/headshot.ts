const BASE =
  process.env.SCHOLARS_HEADSHOT_BASE ??
  "https://directory.weill.cornell.edu/api/v1/person/profile";

export function identityImageEndpoint(cwid: string): string {
  return `${BASE}/${cwid}.png?returnGenericOn404=false`;
}
