export const FIXTURE_CWID = "abc1234";

export const EXPECTED_HEADSHOT_BASE =
  "https://directory.weill.cornell.edu/api/v1/person/profile";

export const EXPECTED_HEADSHOT_URL =
  "https://directory.weill.cornell.edu/api/v1/person/profile/abc1234.png?returnGenericOn404=false";

// Minimal scholar shape matching ScholarPayload fields the tests need.
// Tests should pass through Prisma mocks or stub the DB read; the fixture is
// only the input/output reference, not a Prisma row.
export const fixtureScholar = {
  cwid: FIXTURE_CWID,
  slug: "jane-doe",
  preferredName: "Jane Doe",
  fullName: "Jane Q. Doe",
  primaryTitle: "Associate Professor of Medicine",
  primaryDepartment: "Medicine",
  email: null,
  overview: null,
};
