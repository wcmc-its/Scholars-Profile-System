/**
 * Issue #447 — OpenSearch client must authenticate in deployed environments.
 *
 * Production is an AWS OpenSearch domain with fine-grained access control +
 * the internal user database (cdk/lib/data-stack.ts), so the client sends
 * `Authorization: Basic` from OPENSEARCH_USER / OPENSEARCH_PASS over the
 * https OPENSEARCH_NODE endpoint. Local dev runs an unauthenticated docker
 * container, so auth is omitted when the credential vars are absent.
 */
import { describe, expect, it } from "vitest";
import { searchClientOptions } from "@/lib/search";

describe("searchClientOptions (#447)", () => {
  it("defaults to the local docker node with no auth when env is empty", () => {
    expect(searchClientOptions({})).toEqual({ node: "http://localhost:9200" });
  });

  it("uses OPENSEARCH_NODE without auth when only the node is set", () => {
    expect(
      searchClientOptions({ OPENSEARCH_NODE: "https://os.example.aws" }),
    ).toEqual({ node: "https://os.example.aws" });
  });

  it("adds basic auth when OPENSEARCH_USER and OPENSEARCH_PASS are both set", () => {
    expect(
      searchClientOptions({
        OPENSEARCH_NODE: "https://os.example.aws",
        OPENSEARCH_USER: "app-user",
        OPENSEARCH_PASS: "s3cret",
      }),
    ).toEqual({
      node: "https://os.example.aws",
      auth: { username: "app-user", password: "s3cret" },
    });
  });

  it("omits auth when only one of user/pass is present (incomplete credential)", () => {
    expect(
      searchClientOptions({
        OPENSEARCH_NODE: "https://os.example.aws",
        OPENSEARCH_USER: "app-user",
      }),
    ).toEqual({ node: "https://os.example.aws" });
    expect(
      searchClientOptions({
        OPENSEARCH_NODE: "https://os.example.aws",
        OPENSEARCH_PASS: "s3cret",
      }),
    ).toEqual({ node: "https://os.example.aws" });
  });
});
