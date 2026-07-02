import * as fs from "node:fs";
import * as path from "node:path";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AppStack } from "../lib/app-stack";
import { EdgeStack } from "../lib/edge-stack";
import { NetworkStack } from "../lib/network-stack";
import { makeFixture } from "./test-utils";

interface BuildResult {
  template: Template;
  stack: EdgeStack;
}

function buildEdgeStack(
  envName: "staging" | "prod",
  options?: { customDomain?: string; certArn?: string; allowedCidrs?: string },
): BuildResult {
  const fixture = makeFixture(envName);
  if (options?.customDomain) {
    fixture.app.node.setContext("edgeCustomDomain", options.customDomain);
  }
  if (options?.certArn) {
    fixture.app.node.setContext("edgeCertArn", options.certArn);
  }
  if (options?.allowedCidrs) {
    fixture.app.node.setContext("edgeAllowedCidrs", options.allowedCidrs);
  }
  const network = new NetworkStack(fixture.app, `Sps-Network-${envName}`, {
    env: fixture.env,
    envConfig: fixture.envConfig,
  });
  const app = new AppStack(fixture.app, `Sps-App-${envName}`, {
    env: fixture.env,
    envConfig: fixture.envConfig,
    vpc: network.vpc,
  });
  const stack = new EdgeStack(fixture.app, `Sps-Edge-${envName}`, {
    env: fixture.env,
    envConfig: fixture.envConfig,
    deployRoleArn: app.deployRole.roleArn,
  });
  return { template: Template.fromStack(stack), stack };
}

// Same allow-set used across the AppStack / DataStack synth-time guards
// (Footgun #5 / #6, PRs #401/#402). Re-applied here so CloudFront / S3 /
// ResponseHeadersPolicy descriptions can't smuggle a banned character past
// `cdk synth`.
const EC2_DESCRIPTION_ALLOWED = /^[a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]+$/;

// ---------------------------------------------------------------------------
// #490 / #624 synth-time guard.
//
// A Next.js route that reads the query string at the SSR origin -- a server
// `page.tsx` awaiting `searchParams`, or a `route.ts` reading it -- MUST have a
// CloudFront behavior that forwards the query string to the origin. Without one
// it falls to the default Managed-CachingOptimized behavior (cache policy
// QueryString=none), so CloudFront strips `?q` before the origin AND caches one
// query-less response for every request. #490 broke `/api/search`; #624 broke
// the `/search` page the same way. Client components using `useSearchParams()`
// read the URL in the browser after hydration and are unaffected -- excluded.
//
// The Next app tree is two levels up from cdk/test/.
const APP_DIR = path.resolve(__dirname, "../../app");

// Documented backlog (#634): routes that read the query string with no
// forwarding behavior when this guard landed. The guard RATCHETS -- a NEW
// uncovered route fails the test. ALL 12 baseline routes were fixed in #634
// (Group A -> CachingDisabled + AllViewer; the cacheable Group B pages ->
// custom query-keyed cache policy), so this baseline is now EMPTY. Any route
// that reads `searchParams` without a forwarding behavior now fails the test
// outright. Do not re-add entries here to "unblock" a break -- give the route
// a real behavior in edge-stack.ts instead.
const KNOWN_UNCOVERED_QUERY_ROUTES: ReadonlySet<string> = new Set([]);

// #634 Group B -- the CACHEABLE pages whose behaviors use the custom
// query-keyed cache policy (per-query cache key, cookies stripped) instead of
// CachingDisabled + AllViewer. Everything else among the additional behaviors
// is uncacheable.
const QUERY_KEYED_PATTERNS: ReadonlySet<string> = new Set([
  "/scholars/*",
  "/departments/*",
  "/centers/*",
  "/topics/*/scholars",
  "/methods/*/*/scholars",
]);

// The exact query-string allow-list on the custom cache policy: the union of
// params the Group B pages read (/scholars/* -> mentees-sort; dept/center/
// division -> page/tab/sort; topics/*/scholars -> q/role/page).
const QUERY_KEYED_ALLOWLIST = [
  "mentees-sort",
  "page",
  "tab",
  "sort",
  "q",
  "role",
] as const;

/** Map an app route file to its URL path: drop the route-group `(...)` segments
 *  and the `page`/`route` filename; collapse `[dynamic]` segments to `*`. */
function routePatternFor(file: string): string {
  const rel = path
    .relative(APP_DIR, file)
    .replace(/\\/g, "/")
    .replace(/\/(page|route)\.(t|j)sx?$/, "");
  const segs = rel.split("/").filter((s) => s && !/^\(.*\)$/.test(s));
  return "/" + segs.map((s) => (/^\[.*\]$/.test(s) ? "*" : s)).join("/");
}

/** Server `page.tsx` / `route.ts` files that read `searchParams` (excluding
 *  `'use client'` components, whose `useSearchParams()` is browser-side). */
function findServerQueryDependentRoutes(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/^(page|route)\.(t|j)sx?$/.test(ent.name)) continue;
      const src = fs.readFileSync(p, "utf8");
      if (/^\s*['"]use client['"]/m.test(src)) continue;
      if (!/\bsearchParams\b/.test(src)) continue;
      out.push(routePatternFor(p));
    }
  };
  walk(dir);
  return [...new Set(out)];
}

/** Server `route.ts` files exporting a MUTATING handler (POST/PUT/PATCH/
 *  DELETE). These need a CloudFront behavior that allows the method: the
 *  default cacheable behavior allows only GET/HEAD/OPTIONS, so an uncovered
 *  mutating route is 403'd at the edge before the origin ever sees it. Sibling
 *  of the query-string guard above (route handlers cannot be `'use client'`,
 *  so no exclusion is needed). */
function findServerMutatingRoutes(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/^route\.(t|j)sx?$/.test(ent.name)) continue;
      const src = fs.readFileSync(p, "utf8");
      if (!/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b/.test(src)) {
        continue;
      }
      out.push(routePatternFor(p));
    }
  };
  walk(dir);
  return [...new Set(out)];
}

/** A CloudFront PathPattern (exact, or trailing-`*` prefix glob) covers a route. */
function behaviorCovers(pattern: string, route: string): boolean {
  return pattern.endsWith("*")
    ? route.startsWith(pattern.slice(0, -1))
    : route === pattern;
}

describe("EdgeStack", () => {
  describe("prod", () => {
    const { template } = buildEdgeStack("prod");

    it("matches the snapshot", () => {
      expect(template.toJSON()).toMatchSnapshot();
    });

    it("every server route reading the query string has a query-forwarding behavior (#490 / #624 guard)", () => {
      // Sanity: we're scanning the real app tree, not silently passing on an
      // empty walk.
      expect(fs.existsSync(APP_DIR)).toBe(true);
      const dist = (
        Object.values(
          template.findResources("AWS::CloudFront::Distribution"),
        )[0].Properties as Record<string, unknown>
      ).DistributionConfig as Record<string, unknown>;
      const behaviorPatterns = (
        dist.CacheBehaviors as Array<Record<string, unknown>>
      ).map((b) => b.PathPattern as string);

      const routes = findServerQueryDependentRoutes(APP_DIR);
      expect(routes.length).toBeGreaterThan(0);

      // A route reading the query string that is neither forwarded by a behavior
      // nor a documented #634 baseline entry is a new #490/#624-class break.
      const newlyUncovered = routes.filter(
        (r) =>
          !KNOWN_UNCOVERED_QUERY_ROUTES.has(r) &&
          !behaviorPatterns.some((p) => behaviorCovers(p, r)),
      );
      expect(newlyUncovered).toEqual([]);

      // Ratchet hygiene: once a baseline route gets a forwarding behavior, drop
      // it from KNOWN_UNCOVERED. Fails loudly so the backlog can't go stale.
      const staleBaseline = [...KNOWN_UNCOVERED_QUERY_ROUTES].filter((r) =>
        behaviorPatterns.some((p) => behaviorCovers(p, r)),
      );
      expect(staleBaseline).toEqual([]);
    });

    it("every server route with a mutating handler has a behavior that allows the method (POST 403 guard)", () => {
      // Sibling of the query-string guard: a route.ts exporting POST/PUT/PATCH/
      // DELETE that is not covered by an ALLOW_ALL behavior falls to the
      // default cacheable behavior (GET/HEAD/OPTIONS only) and is 403'd at the
      // edge before reaching the origin. This bit /api/csp-report,
      // /api/nih-resolve, /api/feedback/submit, and the POST /api/export/*
      // route (caught fixing #634).
      expect(fs.existsSync(APP_DIR)).toBe(true);
      const dist = (
        Object.values(
          template.findResources("AWS::CloudFront::Distribution"),
        )[0].Properties as Record<string, unknown>
      ).DistributionConfig as Record<string, unknown>;
      const behaviors = dist.CacheBehaviors as Array<Record<string, unknown>>;
      // Only behaviors whose AllowedMethods include POST forward a mutation.
      // The default behavior is GET/HEAD/OPTIONS and is intentionally excluded.
      const postBehaviorPatterns = behaviors
        .filter((b) => (b.AllowedMethods as string[]).includes("POST"))
        .map((b) => b.PathPattern as string);

      const mutatingRoutes = findServerMutatingRoutes(APP_DIR);
      expect(mutatingRoutes.length).toBeGreaterThan(0);

      const uncovered = mutatingRoutes.filter(
        (r) => !postBehaviorPatterns.some((p) => behaviorCovers(p, r)),
      );
      expect(uncovered).toEqual([]);
    });

    describe("Resource counts (the plan's § Acceptance criteria)", () => {
      it("creates exactly one CloudFront distribution and two response-headers policies", () => {
        template.resourceCountIs("AWS::CloudFront::Distribution", 1);
        // Two policies: `sps-security-headers-*` (HSTS, applied to assets +
        // uncacheable + Group B) and `sps-html-headers-*` (HSTS + a
        // `max-age=0, must-revalidate` Cache-Control override, applied to the
        // HTML default behavior so a document never outlives a deploy).
        template.resourceCountIs(
          "AWS::CloudFront::ResponseHeadersPolicy",
          2,
        );
      });

      it("creates two S3 buckets (access-logs target + static-asset origin)", () => {
        // LogsBucket (CloudFront standard logs) + StaticAssetsBucket
        // (/_next/static/* S3 origin, #700).
        template.resourceCountIs("AWS::S3::Bucket", 2);
      });

      it("enables CloudFront additional metrics (one monitoring subscription)", () => {
        // publishAdditionalMetrics: true -- backs the dashboard OriginLatency
        // panel (ObservabilityStack). Synthesizes a MonitoringSubscription.
        template.resourceCountIs("AWS::CloudFront::MonitoringSubscription", 1);
      });
    });

    describe("Distribution behaviors (acceptance #2..#8)", () => {
      const distributions = (): Array<Record<string, unknown>> =>
        Object.values(
          template.findResources("AWS::CloudFront::Distribution"),
        ).map((r) => r.Properties as Record<string, unknown>);

      it("has one default behavior plus thirty-three additional cache behaviors (acceptance #2)", () => {
        const props = distributions()[0];
        const dc = props.DistributionConfig as Record<string, unknown>;
        const defaultBehavior = dc.DefaultCacheBehavior as Record<string, unknown>;
        const cacheBehaviors = dc.CacheBehaviors as Array<Record<string, unknown>>;
        expect(defaultBehavior).toBeDefined();
        // 24 prior behaviors + the `/_next/static/*` long-cache behavior + the
        // two #824 method routes (/api/methods/*/*/publications, /methods/*/*/scholars)
        // + the #866 `/api/profile/*` internal-viewer reveal behavior
        // + the #974 Phase 2 `/api/units/*/*/members` method-facet route
        // + the #967 `/api/scholar/*/method-exemplar` representative-paper hover
        // + the two GrantRecs Phase 2 matcher routes
        // (/api/scholars/*/opportunities, /api/opportunities/*/researchers)
        // + the GrantRecs slice-3 browse list (/api/opportunities)
        // + the SEARCH_EVIDENCE_ROWS `/api/scholar/*/grants` funding-row fetcher.
        expect(cacheBehaviors).toHaveLength(34);
      });

      it("evaluates additional behaviors in the spec-defined order (static first, then uncacheable, then #634 query-keyed)", () => {
        const props = distributions()[0];
        const dc = props.DistributionConfig as Record<string, unknown>;
        const cacheBehaviors = dc.CacheBehaviors as Array<Record<string, unknown>>;
        const paths = cacheBehaviors.map((b) => b.PathPattern as string);
        expect(paths).toEqual([
          // -- Immutable build assets (long-cache, CachingOptimized) ------
          "/_next/static/*",
          // -- Uncacheable (CachingDisabled + AllViewer) ------------------
          "/api/edit*",
          "/api/impersonation*",
          "/edit*",
          "/api/auth/*",
          "/api/revalidate*",
          "/api/health/*",
          "/api/analytics",
          "/api/export/*",
          // Mutating POST routes that fell to the default GET-only behavior
          // (-> 403 at the edge); now ALLOW_ALL.
          "/api/csp-report",
          "/api/nih-resolve",
          "/api/feedback/submit",
          // `/api/search*` -- query-string-dependent dynamic GET; must not hit
          // the cacheable default (which strips `?q=` and caches). See edge-stack.ts.
          "/api/search*",
          // `/search*` -- the search PAGE has the same query-string-strip failure
          // mode as the API (#624); without this behavior CloudFront drops `?q`
          // and the page renders the query-less "browse all" default for every
          // search. See edge-stack.ts.
          "/search*",
          // #634 Group A -- dynamic query-string routes that must never cache.
          "/api/directory/people",
          "/api/nih-portfolio",
          "/api/scholars/*/popover-context",
          // #967 method-badge representative-paper hover -- reads `?family=`.
          "/api/scholar/*/method-exemplar",
          // Funding-row representative grants (SEARCH_EVIDENCE_ROWS) -- reads `?q=`.
          "/api/scholar/*/grants",
          "/api/topics/*/publications",
          "/api/methods/*/*/publications",
          // #974 Phase 2 dept/division method-facet roster -- reads `?method=`;
          // AllViewer forwards it past the cacheable default's allow-list.
          "/api/units/*/*/members",
          // #866 internal-viewer reveal -- uncacheable so a sensitive-family
          // reveal is never cached + served to another viewer.
          "/api/profile/*",
          "/about/feedback",
          // The two co-pub export routes MUST precede `/scholars/*` below:
          // CloudFront is first-match-wins in list order and `/scholars/*`
          // (a `*` glob spanning slashes) would otherwise swallow them and
          // cache the download.
          "/scholars/*/co-pubs/export",
          "/scholars/*/co-pubs/*/export",
          // GrantRecs Phase 2 matcher routes -- forward "Grants for me" (reads
          // sort/weights/limit) + reverse "Find researchers" (admin, reads
          // sort/stageLens/limit). AllViewer forwards the query past the
          // cacheable default's allow-list. Precede `/scholars/*` (Group B).
          "/api/scholars/*/opportunities",
          "/api/opportunities/*/researchers",
          // GrantRecs slice 3 -- opportunity browse list (admin, reads
          // q/includeGrantsGov/limit). The `/*/researchers` glob does not cover
          // the bare collection path, so it needs its own exact behavior.
          "/api/opportunities",
          // -- #634 Group B -- query-keyed CACHEABLE pages (custom policy) --
          "/scholars/*",
          "/departments/*",
          "/centers/*",
          "/topics/*/scholars",
          "/methods/*/*/scholars",
        ]);
      });

      it("default behavior uses the custom RSC-aware cache policy (acceptance #3)", () => {
        const props = distributions()[0];
        const dc = props.DistributionConfig as Record<string, unknown>;
        const defaultBehavior = dc.DefaultCacheBehavior as Record<string, unknown>;
        // No longer Managed-CachingOptimized: a stack-local policy that mirrors
        // it but keys on the RSC headers so App Router soft navigation works.
        // CDK references it by logical id (a `Ref`); resolve `sps-default-rsc-*`.
        const policies = template.findResources("AWS::CloudFront::CachePolicy");
        const defaultPolicyLogicalId = Object.entries(policies).find(
          ([, r]) =>
            (
              (r.Properties as Record<string, unknown>)
                .CachePolicyConfig as Record<string, unknown>
            ).Name === "sps-default-rsc-prod",
        )?.[0];
        expect(defaultPolicyLogicalId).toBeDefined();
        expect(defaultBehavior.CachePolicyId).toEqual({
          Ref: defaultPolicyLogicalId,
        });
      });

      it("uncacheable behaviors use Managed-CachingDisabled; #634 Group B uses the custom query-keyed policy (acceptance #3)", () => {
        const props = distributions()[0];
        const dc = props.DistributionConfig as Record<string, unknown>;
        const cacheBehaviors = dc.CacheBehaviors as Array<Record<string, unknown>>;
        // The custom cache policy is a stack-local resource; CDK references it
        // by logical id (a `Ref`), not the managed-policy UUID. Three custom
        // policies now exist (default RSC-aware + query-keyed + search-API
        // compressible); resolve each by name.
        const customPolicyLogicalId = Object.entries(
          template.findResources("AWS::CloudFront::CachePolicy"),
        ).find(
          ([, r]) =>
            (
              (r.Properties as Record<string, unknown>)
                .CachePolicyConfig as Record<string, unknown>
            ).Name === "sps-query-keyed-prod",
        )?.[0];
        const searchPolicyLogicalId = Object.entries(
          template.findResources("AWS::CloudFront::CachePolicy"),
        ).find(
          ([, r]) =>
            (
              (r.Properties as Record<string, unknown>)
                .CachePolicyConfig as Record<string, unknown>
            ).Name === "sps-search-nostore-compress-prod",
        )?.[0];
        expect(searchPolicyLogicalId).toBeDefined();
        for (const behavior of cacheBehaviors) {
          const path = behavior.PathPattern as string;
          if (path === "/_next/static/*") {
            // Immutable build assets -- Managed-CachingOptimized id (long TTL,
            // respects the origin's `immutable, max-age=1y`).
            expect(behavior.CachePolicyId).toBe(
              "658327ea-f89d-4fab-a63d-7e88639e58f6",
            );
          } else if (QUERY_KEYED_PATTERNS.has(path)) {
            // #634 Group B -- custom `sps-query-keyed-*` policy (a Ref).
            expect(behavior.CachePolicyId).toEqual({ Ref: customPolicyLogicalId });
          } else if (path === "/api/search*") {
            // Custom no-store-but-compressible policy: CachingDisabled TTLs
            // (0/0/1s) plus gzip/brotli support so `compress: true` fires on
            // the large search JSON -- Managed-CachingDisabled hard-codes the
            // Accept-Encoding flags off.
            expect(behavior.CachePolicyId).toEqual({
              Ref: searchPolicyLogicalId,
            });
          } else {
            // Managed-CachingDisabled id.
            expect(behavior.CachePolicyId).toBe(
              "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
            );
          }
        }
      });

      it("uncacheable behaviors use Managed-AllViewer; #634 Group B has NO origin request policy (cookies stripped) (acceptance #4)", () => {
        const props = distributions()[0];
        const dc = props.DistributionConfig as Record<string, unknown>;
        const cacheBehaviors = dc.CacheBehaviors as Array<Record<string, unknown>>;
        // #866 -- the two internal-viewer behaviors use a stack-local origin
        // request policy (ALL_VIEWER + CloudFront-Viewer-Address), referenced by
        // logical id (a `Ref`), not the Managed-AllViewer UUID. Resolve it by name.
        const internalViewerOrpLogicalId = Object.entries(
          template.findResources("AWS::CloudFront::OriginRequestPolicy"),
        ).find(
          ([, r]) =>
            (
              (r.Properties as Record<string, unknown>)
                .OriginRequestPolicyConfig as Record<string, unknown>
            ).Name === "sps-internal-viewer-prod",
        )?.[0];
        expect(internalViewerOrpLogicalId).toBeDefined();
        const INTERNAL_VIEWER_ORP_PATHS = new Set([
          "/api/profile/*",
          "/api/export/*",
        ]);
        for (const behavior of cacheBehaviors) {
          const path = behavior.PathPattern as string;
          if (path === "/_next/static/*" || QUERY_KEYED_PATTERNS.has(path)) {
            // `/_next/static/*` (immutable assets) and Group B (highest-traffic
            // pages) must NOT forward cookies -- it would fragment the cache.
            expect(behavior.OriginRequestPolicyId).toBeUndefined();
          } else if (INTERNAL_VIEWER_ORP_PATHS.has(path)) {
            // #866 internal-viewer ORP (forwards CloudFront-Viewer-Address) -- a Ref.
            expect(behavior.OriginRequestPolicyId).toEqual({
              Ref: internalViewerOrpLogicalId,
            });
          } else {
            // Managed-AllViewer id.
            expect(behavior.OriginRequestPolicyId).toBe(
              "216adef6-5c7f-47e4-b989-5492eafa07d3",
            );
          }
        }
      });

      it("default behavior has NO origin request policy (acceptance #5 -- prevents cookie leak)", () => {
        const props = distributions()[0];
        const dc = props.DistributionConfig as Record<string, unknown>;
        const defaultBehavior = dc.DefaultCacheBehavior as Record<string, unknown>;
        expect(defaultBehavior.OriginRequestPolicyId).toBeUndefined();
      });

      it("ALB origin is HTTP-only on port 80; static-asset S3 origin uses OAC (acceptance #6, #700)", () => {
        const props = distributions()[0];
        const dc = props.DistributionConfig as Record<string, unknown>;
        const ods = dc.Origins as Array<Record<string, unknown>>;
        // Two origins now: the ALB (custom, fallback) + the static-asset S3
        // bucket (OAC, primary of the /_next/static/* origin group, #700).
        expect(ods).toHaveLength(2);
        const albOrigin = ods.find((o) => o.CustomOriginConfig !== undefined);
        const config = albOrigin?.CustomOriginConfig as Record<string, unknown>;
        expect(config.OriginProtocolPolicy).toBe("http-only");
        expect(config.HTTPPort).toBe(80);
        // The S3 origin is OAC-backed: it carries an OriginAccessControlId and
        // (since it's a bucket) no CustomOriginConfig.
        const s3Origin = ods.find((o) => o.CustomOriginConfig === undefined);
        expect(s3Origin?.OriginAccessControlId).toBeDefined();
        expect(s3Origin?.S3OriginConfig).toBeDefined();
      });

      it("origin sends an X-Origin-Verify custom header (acceptance #7)", () => {
        const props = distributions()[0];
        const dc = props.DistributionConfig as Record<string, unknown>;
        const ods = dc.Origins as Array<Record<string, unknown>>;
        const origin = ods[0];
        const customHeaders =
          (origin?.OriginCustomHeaders as Array<{ HeaderName?: string; HeaderValue?: unknown }>) ??
          [];
        const verify = customHeaders.find((h) => h.HeaderName === "X-Origin-Verify");
        expect(verify).toBeDefined();
        // The header value is a CFN dynamic reference; CDK emits the
        // FRIENDLY-NAME form (`{{resolve:secretsmanager:<name>:SecretString:::}}`)
        // via SecretValue.secretsManager(name). The secret value itself never
        // appears in the template.
        const serialized = JSON.stringify(verify?.HeaderValue);
        expect(serialized).toMatch(/\{\{resolve:secretsmanager:/);
        expect(serialized).toContain(
          "scholars/prod/edge/origin-shared-secret",
        );
        // Guard the #431-blocker-#5 footgun that broke the first Edge deploy:
        // Secret.fromSecretNameV2(...).secretValue emits a PARTIAL-ARN
        // reference Secrets Manager rejects at deploy (ResourceNotFound). The
        // friendly-name form must contain NO ARN.
        expect(serialized).not.toContain("arn:aws:secretsmanager");
      });

      it("default + every additional behavior redirects HTTP to HTTPS (acceptance #8)", () => {
        const props = distributions()[0];
        const dc = props.DistributionConfig as Record<string, unknown>;
        const defaultBehavior = dc.DefaultCacheBehavior as Record<string, unknown>;
        expect(defaultBehavior.ViewerProtocolPolicy).toBe("redirect-to-https");
        const cacheBehaviors = dc.CacheBehaviors as Array<Record<string, unknown>>;
        for (const behavior of cacheBehaviors) {
          expect(behavior.ViewerProtocolPolicy).toBe("redirect-to-https");
        }
      });

      it("default behavior allows GET/HEAD/OPTIONS; writer/auth/etc behaviors allow ALL methods", () => {
        const props = distributions()[0];
        const dc = props.DistributionConfig as Record<string, unknown>;
        const defaultBehavior = dc.DefaultCacheBehavior as Record<string, unknown>;
        const defaultMethods = (defaultBehavior.AllowedMethods as string[]).sort();
        expect(defaultMethods).toEqual(["GET", "HEAD", "OPTIONS"]);
        const cacheBehaviors = dc.CacheBehaviors as Array<Record<string, unknown>>;
        // Per the spec table: /api/edit*, /api/auth/*, /api/revalidate*,
        // /api/analytics need POST; CloudFront's enum collapses to ALLOW_ALL
        // for any of those. The GET-only routes (/edit/*, /api/health/*,
        // /api/export/*) stay on GET/HEAD/OPTIONS. /edit* covers the bare
        // /edit self-editor route too (not just /edit/<cwid>).
        const byPath = new Map<string, string[]>();
        for (const b of cacheBehaviors) {
          byPath.set(
            b.PathPattern as string,
            (b.AllowedMethods as string[]).slice().sort(),
          );
        }
        const allMethods = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];
        const ghOptions = ["GET", "HEAD", "OPTIONS"];
        expect(byPath.get("/api/edit*")).toEqual(allMethods);
        expect(byPath.get("/edit*")).toEqual(ghOptions);
        expect(byPath.get("/api/auth/*")).toEqual(allMethods);
        expect(byPath.get("/api/revalidate*")).toEqual(allMethods);
        expect(byPath.get("/api/health/*")).toEqual(ghOptions);
        expect(byPath.get("/api/analytics")).toEqual(allMethods);
        // `/api/export/*` is a POST handler (publications export); ALLOW_ALL.
        expect(byPath.get("/api/export/*")).toEqual(allMethods);
        // Mutating POST routes that previously 403'd at the GET-only default.
        expect(byPath.get("/api/csp-report")).toEqual(allMethods);
        expect(byPath.get("/api/nih-resolve")).toEqual(allMethods);
        expect(byPath.get("/api/feedback/submit")).toEqual(allMethods);
        expect(byPath.get("/api/search*")).toEqual(ghOptions);
        expect(byPath.get("/search*")).toEqual(ghOptions);
        // #634 -- every Group A dynamic route and Group B cacheable page is
        // a read-only GET/HEAD/OPTIONS surface (form POSTs go to separate
        // already-covered /api/* routes).
        for (const p of [
          "/api/directory/people",
          "/api/nih-portfolio",
          "/api/scholars/*/popover-context",
          // #967 method-badge representative-paper hover -- GET-only read.
          "/api/scholar/*/method-exemplar",
          // Funding-row representative grants (SEARCH_EVIDENCE_ROWS) -- GET-only read.
          "/api/scholar/*/grants",
          "/api/topics/*/publications",
          "/api/methods/*/*/publications",
          // #866 internal-viewer reveal -- GET-only read.
          "/api/profile/*",
          // #974 Phase 2 org-unit method-facet members feed (plain allViewer,
          // GET-only) -- #991 locks its method set the same way as the siblings.
          "/api/units/*/*/members",
          "/about/feedback",
          "/scholars/*/co-pubs/export",
          "/scholars/*/co-pubs/*/export",
          "/scholars/*",
          "/departments/*",
          "/centers/*",
          "/topics/*/scholars",
          "/methods/*/*/scholars",
        ]) {
          expect(byPath.get(p)).toEqual(ghOptions);
        }
      });
    });

    describe("#668 error-response caching (§4)", () => {
      const customErrorResponses = (): Array<Record<string, unknown>> => {
        const dist = Object.values(
          template.findResources("AWS::CloudFront::Distribution"),
        )[0].Properties as Record<string, unknown>;
        const dc = dist.DistributionConfig as Record<string, unknown>;
        return (dc.CustomErrorResponses as Array<Record<string, unknown>>) ?? [];
      };

      it("caches 404 for 60s and passes the origin 404 through unchanged (no soft-404)", () => {
        const r404 = customErrorResponses().find((e) => e.ErrorCode === 404);
        expect(r404).toBeDefined();
        expect(r404?.ErrorCachingMinTTL).toBe(60);
        // No ResponseCode / ResponsePagePath: CloudFront preserves the origin's
        // 404 status + body. A cached 404 must STAY a 404, never become a 200.
        expect(r404?.ResponseCode).toBeUndefined();
        expect(r404?.ResponsePagePath).toBeUndefined();
      });

      it("never caches a 5xx -- every 5xx declares ErrorCachingMinTTL 0 (ratchet)", () => {
        const byCode = new Map(
          customErrorResponses().map((e) => [e.ErrorCode as number, e]),
        );
        for (const code of [500, 502, 503, 504]) {
          const r = byCode.get(code);
          expect(r).toBeDefined();
          expect(r?.ErrorCachingMinTTL).toBe(0);
        }
        // Ratchet: NO 5xx custom error response may carry a non-zero TTL. Guards
        // a future edit from accidentally pinning a transient origin 5xx at the
        // edge (a 10s blip would otherwise become a multi-minute outage).
        const cachedFiveXx = customErrorResponses().filter(
          (e) =>
            (e.ErrorCode as number) >= 500 &&
            (e.ErrorCachingMinTTL as number) !== 0,
        );
        expect(cachedFiveXx).toEqual([]);
      });
    });

    describe("#634 query-keyed cache policy (Group B)", () => {
      const policyConfig = (): Record<string, unknown> => {
        const policies = template.findResources(
          "AWS::CloudFront::CachePolicy",
        );
        // Multiple custom policies exist (default RSC-aware, search-API
        // compressible, this one). Select the query-keyed policy by name.
        const cfgs = Object.values(policies).map(
          (e) =>
            (e.Properties as Record<string, unknown>)
              .CachePolicyConfig as Record<string, unknown>,
        );
        const queryKeyed = cfgs.find((c) => c.Name === "sps-query-keyed-prod");
        expect(queryKeyed).toBeDefined();
        return queryKeyed as Record<string, unknown>;
      };

      it("synthesizes exactly one custom cache policy, env-named", () => {
        const cfg = policyConfig();
        expect(cfg.Name).toBe("sps-query-keyed-prod");
      });

      it("includes ONLY the allow-listed query params in the cache key (not ALL)", () => {
        const cfg = policyConfig();
        const params = cfg.ParametersInCacheKeyAndForwardedToOrigin as Record<
          string,
          unknown
        >;
        const qs = params.QueryStringsConfig as Record<string, unknown>;
        expect(qs.QueryStringBehavior).toBe("whitelist");
        const items = (qs.QueryStrings as string[]).slice().sort();
        expect(items).toEqual([...QUERY_KEYED_ALLOWLIST].sort());
      });

      it("does NOT key on cookies; keys on the RSC headers (soft-nav) only", () => {
        const cfg = policyConfig();
        const params = cfg.ParametersInCacheKeyAndForwardedToOrigin as Record<
          string,
          unknown
        >;
        const cookies = params.CookiesConfig as Record<string, unknown>;
        const headers = params.HeadersConfig as Record<string, unknown>;
        expect(cookies.CookieBehavior).toBe("none");
        // RSC header keying so App Router soft navigation TO a Group B page
        // returns the Flight payload, not a cached HTML document.
        expect(headers.HeaderBehavior).toBe("whitelist");
        expect((headers.Headers as string[]).slice().sort()).toEqual(
          ["Next-Router-Prefetch", "RSC"].sort(),
        );
        // Accept-Encoding negotiation stays on so gzip/br are served.
        expect(params.EnableAcceptEncodingGzip).toBe(true);
        expect(params.EnableAcceptEncodingBrotli).toBe(true);
      });

      it("mirrors Managed-CachingOptimized TTLs (1s / 1d / 1y)", () => {
        const cfg = policyConfig();
        expect(cfg.MinTTL).toBe(1);
        expect(cfg.DefaultTTL).toBe(86400);
        expect(cfg.MaxTTL).toBe(31536000);
      });
    });

    describe("search-API no-store-but-compressible cache policy", () => {
      const policyConfig = (): Record<string, unknown> => {
        const cfgs = Object.values(
          template.findResources("AWS::CloudFront::CachePolicy"),
        ).map(
          (e) =>
            (e.Properties as Record<string, unknown>)
              .CachePolicyConfig as Record<string, unknown>,
        );
        const cfg = cfgs.find(
          (c) => c.Name === "sps-search-nostore-compress-prod",
        );
        expect(cfg).toBeDefined();
        return cfg as Record<string, unknown>;
      };

      it("keeps never-cache semantics: TTLs 0/0/1s so the origin's Cache-Control governs", () => {
        // maxTtl 1s only because CloudFront rejects the Accept-Encoding flags
        // at maxTtl 0; defaultTtl 0 means a header-less response is not
        // cached, so this is compression-enabling, not cache-enabling.
        const cfg = policyConfig();
        expect(cfg.MinTTL).toBe(0);
        expect(cfg.DefaultTTL).toBe(0);
        expect(cfg.MaxTTL).toBe(1);
      });

      it("enables gzip + brotli (the point -- Managed-CachingDisabled hard-codes them off)", () => {
        const params = policyConfig()
          .ParametersInCacheKeyAndForwardedToOrigin as Record<string, unknown>;
        expect(params.EnableAcceptEncodingGzip).toBe(true);
        expect(params.EnableAcceptEncodingBrotli).toBe(true);
      });

      it("keys on the full query string, never cookies or headers", () => {
        const params = policyConfig()
          .ParametersInCacheKeyAndForwardedToOrigin as Record<string, unknown>;
        expect(
          (params.QueryStringsConfig as Record<string, unknown>)
            .QueryStringBehavior,
        ).toBe("all");
        expect(
          (params.CookiesConfig as Record<string, unknown>).CookieBehavior,
        ).toBe("none");
        expect(
          (params.HeadersConfig as Record<string, unknown>).HeaderBehavior,
        ).toBe("none");
      });
    });

    describe("default RSC-aware cache policy (App Router soft navigation)", () => {
      const defaultCacheConfig = (): Record<string, unknown> => {
        const policies = template.findResources(
          "AWS::CloudFront::CachePolicy",
        );
        const cfgs = Object.values(policies).map(
          (e) =>
            (e.Properties as Record<string, unknown>)
              .CachePolicyConfig as Record<string, unknown>,
        );
        const def = cfgs.find((c) => c.Name === "sps-default-rsc-prod");
        expect(def).toBeDefined();
        return def as Record<string, unknown>;
      };

      it("synthesizes the env-named default policy alongside the query-keyed + search ones", () => {
        // Three custom policies: default RSC-aware, #634 query-keyed, and the
        // search-API no-store-but-compressible policy.
        template.resourceCountIs("AWS::CloudFront::CachePolicy", 3);
        expect(defaultCacheConfig().Name).toBe("sps-default-rsc-prod");
      });

      it("keys on the RSC headers so soft navigation returns the Flight payload", () => {
        const params = defaultCacheConfig()
          .ParametersInCacheKeyAndForwardedToOrigin as Record<string, unknown>;
        const headers = params.HeadersConfig as Record<string, unknown>;
        expect(headers.HeaderBehavior).toBe("whitelist");
        expect((headers.Headers as string[]).slice().sort()).toEqual(
          ["Next-Router-Prefetch", "RSC"].sort(),
        );
      });

      it("does not key on cookies or the query string (mirrors Managed-CachingOptimized)", () => {
        const params = defaultCacheConfig()
          .ParametersInCacheKeyAndForwardedToOrigin as Record<string, unknown>;
        const cookies = params.CookiesConfig as Record<string, unknown>;
        const qs = params.QueryStringsConfig as Record<string, unknown>;
        expect(cookies.CookieBehavior).toBe("none");
        expect(qs.QueryStringBehavior).toBe("none");
        expect(params.EnableAcceptEncodingGzip).toBe(true);
        expect(params.EnableAcceptEncodingBrotli).toBe(true);
      });

      it("clamps the edge TTL to 60s so HTML cannot outlive a deploy (min 0 / default 60 / max 60)", () => {
        // The load-bearing change: force-static HTML ships `s-maxage=31536000`,
        // and `MaxTTL` is the ceiling CloudFront honors, so that bogus year
        // collapses to 60s -- a rotated-chunk break self-corrects in <=60s
        // instead of persisting for up to a year. `MinTTL` 0 so a no-store page
        // is never force-cached. Immutable `/_next/static/*` is unaffected (its
        // own CachingOptimized behavior).
        const cfg = defaultCacheConfig();
        expect(cfg.MinTTL).toBe(0);
        expect(cfg.DefaultTTL).toBe(60);
        expect(cfg.MaxTTL).toBe(60);
      });
    });

    describe("/_next/static/* immutable-asset behavior (HTML/asset cache split)", () => {
      const staticBehavior = (): Record<string, unknown> => {
        const dist = Object.values(
          template.findResources("AWS::CloudFront::Distribution"),
        )[0].Properties as Record<string, unknown>;
        const dc = dist.DistributionConfig as Record<string, unknown>;
        const b = (dc.CacheBehaviors as Array<Record<string, unknown>>).find(
          (x) => x.PathPattern === "/_next/static/*",
        );
        expect(b).toBeDefined();
        return b as Record<string, unknown>;
      };

      it("uses Managed-CachingOptimized (long TTL, respects origin immutable) with cookies stripped", () => {
        const b = staticBehavior();
        expect(b.CachePolicyId).toBe("658327ea-f89d-4fab-a63d-7e88639e58f6");
        expect(b.OriginRequestPolicyId).toBeUndefined();
        expect((b.AllowedMethods as string[]).slice().sort()).toEqual([
          "GET",
          "HEAD",
          "OPTIONS",
        ]);
        expect(b.ViewerProtocolPolicy).toBe("redirect-to-https");
      });

      it("does NOT use the HTML no-store headers policy (assets stay browser-cacheable)", () => {
        // Assets must keep their `immutable` browser caching -- only the HTML
        // default behavior gets the `max-age=0, must-revalidate` override.
        const htmlPolicyLogicalId = Object.entries(
          template.findResources("AWS::CloudFront::ResponseHeadersPolicy"),
        ).find(
          ([, r]) =>
            (
              (r.Properties as Record<string, unknown>)
                .ResponseHeadersPolicyConfig as Record<string, unknown>
            ).Name === "sps-html-headers-prod",
        )?.[0];
        expect(htmlPolicyLogicalId).toBeDefined();
        expect(staticBehavior().ResponseHeadersPolicyId).not.toEqual({
          Ref: htmlPolicyLogicalId,
        });
      });
    });

    describe("HTML default behavior never outlives a deploy (Cache-Control override)", () => {
      it("the default behavior uses the sps-html-headers-* policy", () => {
        const dist = Object.values(
          template.findResources("AWS::CloudFront::Distribution"),
        )[0].Properties as Record<string, unknown>;
        const dc = dist.DistributionConfig as Record<string, unknown>;
        const defaultBehavior = dc.DefaultCacheBehavior as Record<string, unknown>;
        const htmlPolicyLogicalId = Object.entries(
          template.findResources("AWS::CloudFront::ResponseHeadersPolicy"),
        ).find(
          ([, r]) =>
            (
              (r.Properties as Record<string, unknown>)
                .ResponseHeadersPolicyConfig as Record<string, unknown>
            ).Name === "sps-html-headers-prod",
        )?.[0];
        expect(htmlPolicyLogicalId).toBeDefined();
        expect(defaultBehavior.ResponseHeadersPolicyId).toEqual({
          Ref: htmlPolicyLogicalId,
        });
      });

      it("the HTML headers policy overrides viewer Cache-Control to max-age=0, must-revalidate and keeps HSTS", () => {
        template.hasResourceProperties(
          "AWS::CloudFront::ResponseHeadersPolicy",
          {
            ResponseHeadersPolicyConfig: Match.objectLike({
              Name: "sps-html-headers-prod",
              SecurityHeadersConfig: Match.objectLike({
                StrictTransportSecurity: Match.objectLike({
                  IncludeSubdomains: true,
                  Override: true,
                }),
              }),
              CustomHeadersConfig: Match.objectLike({
                Items: Match.arrayWith([
                  Match.objectLike({
                    Header: "Cache-Control",
                    Value: "public, max-age=0, must-revalidate",
                    Override: true,
                  }),
                ]),
              }),
            }),
          },
        );
      });
    });

    describe("static-asset S3 origin + origin-group failover (#700)", () => {
      const distConfig = (): Record<string, unknown> => {
        const dist = Object.values(
          template.findResources("AWS::CloudFront::Distribution"),
        )[0].Properties as Record<string, unknown>;
        return dist.DistributionConfig as Record<string, unknown>;
      };

      it("private static bucket with BlockPublicAccess ALL and a 14-day lifecycle on _next/static/", () => {
        template.hasResourceProperties("AWS::S3::Bucket", {
          PublicAccessBlockConfiguration: Match.objectLike({
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          }),
          LifecycleConfiguration: Match.objectLike({
            Rules: Match.arrayWith([
              Match.objectLike({
                Prefix: "_next/static/",
                ExpirationInDays: 14,
                Status: "Enabled",
              }),
            ]),
          }),
        });
      });

      it("creates exactly one Origin Access Control for the S3 origin", () => {
        template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
      });

      it("the /_next/static/* behavior targets an origin group that fails over S3 -> ALB on 403/404", () => {
        const dc = distConfig();
        const groups = dc.OriginGroups as Record<string, unknown>;
        const items = groups.Items as Array<Record<string, unknown>>;
        expect(items).toHaveLength(1);
        const group = items[0];
        const failover = group.FailoverCriteria as Record<string, unknown>;
        const codes = (failover.StatusCodes as Record<string, unknown>)
          .Items as number[];
        expect(codes.slice().sort()).toEqual([403, 404]);
        // The static behavior must route through the origin GROUP, not a bare
        // origin -- that is what gives the ALB fallback.
        const groupId = group.Id as string;
        const staticBehavior = (
          dc.CacheBehaviors as Array<Record<string, unknown>>
        ).find((b) => b.PathPattern === "/_next/static/*");
        expect(staticBehavior?.TargetOriginId).toBe(groupId);
      });

      it("grants the deploy role prefix-scoped s3:PutObject (additive, NO DeleteObject)", () => {
        // Find the static bucket's policy by the _next/static/ prefix it
        // references; assert it grants PutObject and never DeleteObject (the
        // sync is additive so old hashes survive -- granting delete would
        // defeat the point and is least-privilege-wrong).
        const policies = Object.values(
          template.findResources("AWS::S3::BucketPolicy"),
        ).map((r) => JSON.stringify((r.Properties as Record<string, unknown>).PolicyDocument));
        const staticPolicy = policies.find((p) => p.includes("_next/static/*"));
        expect(staticPolicy).toBeDefined();
        expect(staticPolicy).toContain("s3:PutObject");
        expect(staticPolicy).not.toContain("s3:DeleteObject");
      });

      it("exports the StaticAssetsBucketName output for the deploy sync", () => {
        template.hasOutput("StaticAssetsBucketName", {});
      });
    });

    describe("Response headers + logging", () => {
      it("response-headers policy has a non-empty HSTS section (D6 -- B21 layers more on top)", () => {
        template.hasResourceProperties(
          "AWS::CloudFront::ResponseHeadersPolicy",
          {
            ResponseHeadersPolicyConfig: Match.objectLike({
              Name: "sps-security-headers-prod",
              SecurityHeadersConfig: Match.objectLike({
                StrictTransportSecurity: Match.objectLike({
                  AccessControlMaxAgeSec: Match.anyValue(),
                  IncludeSubdomains: true,
                  Override: true,
                }),
              }),
            }),
          },
        );
      });

      it("standard logging is enabled and points at the stack-owned bucket with cf/${env}/ prefix", () => {
        template.hasResourceProperties("AWS::CloudFront::Distribution", {
          DistributionConfig: Match.objectLike({
            Logging: Match.objectLike({
              Bucket: Match.anyValue(),
              Prefix: "cf/prod/",
            }),
          }),
        });
      });

      it("S3 logs bucket enforces BlockPublicAccess and BucketOwnerPreferred for CloudFront log delivery", () => {
        template.hasResourceProperties("AWS::S3::Bucket", {
          PublicAccessBlockConfiguration: Match.objectLike({
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          }),
          OwnershipControls: Match.objectLike({
            Rules: Match.arrayWith([
              Match.objectLike({ ObjectOwnership: "BucketOwnerPreferred" }),
            ]),
          }),
        });
      });
    });

    describe("Custom domain bootstrap two-step (acceptance #13)", () => {
      it("with neither context flag set, the distribution has no alias and no custom ACM cert (acceptance #13)", () => {
        const props = Object.values(
          template.findResources("AWS::CloudFront::Distribution"),
        )[0]?.Properties as Record<string, unknown> | undefined;
        const dc = props?.DistributionConfig as Record<string, unknown>;
        expect(dc.Aliases).toBeUndefined();
        // CDK omits ViewerCertificate entirely (CloudFront defaults to its
        // own cert) when no certificate is attached. Either undefined or an
        // object lacking AcmCertificateArn is acceptable; what must NOT
        // appear is a reference to a custom certificate.
        const cert = dc.ViewerCertificate as Record<string, unknown> | undefined;
        if (cert !== undefined) {
          expect(cert.AcmCertificateArn).toBeUndefined();
        }
      });
    });
  });

  describe("staging", () => {
    const { template } = buildEdgeStack("staging");

    it("matches the snapshot", () => {
      expect(template.toJSON()).toMatchSnapshot();
    });

    it("the X-Origin-Verify header value points at the staging secret name", () => {
      const props = Object.values(
        template.findResources("AWS::CloudFront::Distribution"),
      )[0]?.Properties as Record<string, unknown> | undefined;
      const dc = props?.DistributionConfig as Record<string, unknown>;
      const ods = dc.Origins as Array<Record<string, unknown>>;
      const customHeaders =
        (ods[0]?.OriginCustomHeaders as Array<{ HeaderName?: string; HeaderValue?: unknown }>) ??
        [];
      const verify = customHeaders.find((h) => h.HeaderName === "X-Origin-Verify");
      const serialized = JSON.stringify(verify?.HeaderValue);
      expect(serialized).toContain(
        "scholars/staging/edge/origin-shared-secret",
      );
    });

    it("standard logging prefix is env-prefixed (cf/staging/)", () => {
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: Match.objectLike({
          Logging: Match.objectLike({ Prefix: "cf/staging/" }),
        }),
      });
    });
  });

  describe("custom domain enabled (acceptance #14)", () => {
    const STUB_CERT =
      "arn:aws:acm:us-east-1:123456789012:certificate/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const { template } = buildEdgeStack("prod", {
      customDomain: "scholars.weill.cornell.edu",
      certArn: STUB_CERT,
    });

    it("attaches the alias when -c edgeCustomDomain and -c edgeCertArn are both set", () => {
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: Match.objectLike({
          Aliases: Match.arrayWith(["scholars.weill.cornell.edu"]),
        }),
      });
    });

    it("attaches the ACM certificate (ViewerCertificate references the stub ARN)", () => {
      const props = Object.values(
        template.findResources("AWS::CloudFront::Distribution"),
      )[0]?.Properties as Record<string, unknown> | undefined;
      const dc = props?.DistributionConfig as Record<string, unknown>;
      const cert = dc.ViewerCertificate as Record<string, unknown>;
      expect(cert.AcmCertificateArn).toBe(STUB_CERT);
      expect(cert.SslSupportMethod).toBe("sni-only");
    });
  });

  describe("temporary front-end IP allowlist (#461)", () => {
    it("with no -c edgeAllowedCidrs: no WebACL, distribution unrestricted", () => {
      const { template } = buildEdgeStack("staging");
      template.resourceCountIs("AWS::WAFv2::WebACL", 0);
      template.resourceCountIs("AWS::WAFv2::IPSet", 0);
      const dist = Object.values(
        template.findResources("AWS::CloudFront::Distribution"),
      )[0]?.Properties as Record<string, unknown> | undefined;
      const dc = dist?.DistributionConfig as Record<string, unknown>;
      expect(dc.WebACLId).toBeUndefined();
    });

    describe("with -c edgeAllowedCidrs set", () => {
      const { template } = buildEdgeStack("staging", {
        allowedCidrs: "140.251.0.0/16,157.139.0.0/16",
      });

      it("creates an IPSet (CLOUDFRONT scope) holding exactly the WCM CIDRs", () => {
        template.resourceCountIs("AWS::WAFv2::IPSet", 1);
        const ipset = Object.values(
          template.findResources("AWS::WAFv2::IPSet"),
        )[0]?.Properties as Record<string, unknown>;
        expect(ipset.Scope).toBe("CLOUDFRONT");
        expect(ipset.Addresses).toEqual([
          "140.251.0.0/16",
          "157.139.0.0/16",
        ]);
      });

      it("defaults to ALLOW and drops non-WCM at priority 0 (so managed rules can inspect WCM traffic)", () => {
        template.resourceCountIs("AWS::WAFv2::WebACL", 1);
        const acl = Object.values(
          template.findResources("AWS::WAFv2::WebACL"),
        )[0]?.Properties as Record<string, unknown>;
        expect(acl.Scope).toBe("CLOUDFRONT");
        // Inverted from default-BLOCK: a terminating allow-wcm short-circuited
        // evaluation, so managed rules never saw WCM requests. Now default
        // ALLOW + a priority-0 block-non-wcm rule, and WCM traffic falls
        // through to the inspection rules.
        expect(acl.DefaultAction).toHaveProperty("Allow");
        const rules = acl.Rules as Array<Record<string, unknown>>;
        const block = rules.find((r) => r.Name === "block-non-wcm");
        expect(block?.Priority).toBe(0);
        expect(block?.Action).toHaveProperty("Block");
        const stmt = JSON.stringify(block?.Statement);
        expect(stmt).toContain("NotStatement");
        expect(stmt).toContain("IPSetReferenceStatement");
      });

      it("layers AWS managed rule groups (SQLi/known-bad/common) in COUNT mode", () => {
        const acl = Object.values(
          template.findResources("AWS::WAFv2::WebACL"),
        )[0]?.Properties as Record<string, unknown>;
        const rules = acl.Rules as Array<Record<string, unknown>>;
        const managed = rules.filter((r) =>
          JSON.stringify(r.Statement ?? {}).includes("ManagedRuleGroupStatement"),
        );
        const names = managed
          .map((r) => JSON.stringify(r.Statement))
          .join(",");
        expect(names).toContain("AWSManagedRulesCommonRuleSet");
        expect(names).toContain("AWSManagedRulesKnownBadInputsRuleSet");
        expect(names).toContain("AWSManagedRulesSQLiRuleSet");
        // Observe-only: every managed group overrides to Count (no enforcement
        // until the metrics prove no false positives on real WCM traffic).
        for (const r of managed) {
          expect(r.OverrideAction).toHaveProperty("Count");
          expect(r.Action).toBeUndefined();
        }
      });

      it("adds a per-IP rate-based rule in COUNT mode", () => {
        const acl = Object.values(
          template.findResources("AWS::WAFv2::WebACL"),
        )[0]?.Properties as Record<string, unknown>;
        const rules = acl.Rules as Array<Record<string, unknown>>;
        const rate = rules.find((r) =>
          JSON.stringify(r.Statement ?? {}).includes("RateBasedStatement"),
        );
        expect(rate).toBeDefined();
        expect(rate?.Action).toHaveProperty("Count");
      });

      it("attaches the WebACL to the distribution (WebACLId set)", () => {
        const dist = Object.values(
          template.findResources("AWS::CloudFront::Distribution"),
        )[0]?.Properties as Record<string, unknown>;
        const dc = dist.DistributionConfig as Record<string, unknown>;
        expect(dc.WebACLId).toBeDefined();
      });

      // Synth-time guard for a deploy-only constraint: WAFv2 IPSet/WebACL
      // Description must match ^[\w+=:#@/\-,.][\w+=:#@/\-,.\s]+[\w+=:#@/\-,.]$
      // -- no parens, no semicolons. cdk synth accepts anything; only the AWS
      // create validates it (it rolled back the first #461 deploy).
      it("every WAFv2 IPSet/WebACL Description satisfies the AWS charset", () => {
        const WAFV2_DESCRIPTION = /^[\w+=:#@/\-,.][\w+=:#@/\-,.\s]+[\w+=:#@/\-,.]$/;
        const violations: string[] = [];
        for (const type of ["AWS::WAFv2::IPSet", "AWS::WAFv2::WebACL"]) {
          for (const [id, r] of Object.entries(template.findResources(type))) {
            const desc = (r.Properties as Record<string, unknown>)
              .Description as string | undefined;
            if (typeof desc === "string" && !WAFV2_DESCRIPTION.test(desc)) {
              violations.push(`${id}: ${JSON.stringify(desc)}`);
            }
          }
        }
        expect(violations).toEqual([]);
      });
    });
  });

  describe("Footgun #3 -- env-prefix guard", () => {
    // Account 665083158573 hosts both staging and prod. Every named
    // CloudFront resource in this stack must carry the env literal so the
    // two stacks coexist. The S3 logs bucket name is CFN-generated (no
    // Name property) so it inherits the stack-name prefix and is not
    // asserted by this guard; the Distribution itself has no Name
    // property and is asserted by Comment + log prefix.
    const { template } = buildEdgeStack("prod");
    const ENV = "prod";

    it("ResponseHeadersPolicy Name carries the env literal", () => {
      const policies = template.findResources(
        "AWS::CloudFront::ResponseHeadersPolicy",
      );
      for (const resource of Object.values(policies)) {
        const cfg = resource.Properties?.ResponseHeadersPolicyConfig as
          | Record<string, unknown>
          | undefined;
        expect(typeof cfg?.Name).toBe("string");
        expect((cfg?.Name as string).includes(ENV)).toBe(true);
      }
    });

    it("Distribution Comment carries the env literal", () => {
      const distributions = template.findResources(
        "AWS::CloudFront::Distribution",
      );
      for (const resource of Object.values(distributions)) {
        const dc = resource.Properties?.DistributionConfig as
          | Record<string, unknown>
          | undefined;
        expect(typeof dc?.Comment).toBe("string");
        expect((dc?.Comment as string).includes(ENV)).toBe(true);
      }
    });

    it("CloudFront standard log prefix carries the env literal", () => {
      const distributions = template.findResources(
        "AWS::CloudFront::Distribution",
      );
      for (const resource of Object.values(distributions)) {
        const dc = resource.Properties?.DistributionConfig as
          | Record<string, unknown>
          | undefined;
        const logging = dc?.Logging as { Prefix?: string } | undefined;
        expect(typeof logging?.Prefix).toBe("string");
        expect((logging?.Prefix as string).includes(ENV)).toBe(true);
      }
    });
  });

  describe("Footgun #5 -- EC2/AWS property character-set safety", () => {
    const { template } = buildEdgeStack("prod");

    it("CloudFront Distribution Comment is ASCII-safe", () => {
      const distributions = template.findResources(
        "AWS::CloudFront::Distribution",
      );
      const violations: string[] = [];
      for (const [id, resource] of Object.entries(distributions)) {
        const dc = resource.Properties?.DistributionConfig as
          | Record<string, unknown>
          | undefined;
        const comment = dc?.Comment as string | undefined;
        if (
          typeof comment === "string" &&
          !EC2_DESCRIPTION_ALLOWED.test(comment)
        ) {
          const bad = [...comment].filter(
            (c) => !EC2_DESCRIPTION_ALLOWED.test(c),
          );
          violations.push(
            `${id}: ${JSON.stringify(comment)} -- banned chars: ${JSON.stringify(bad.join(""))}`,
          );
        }
      }
      expect(violations).toEqual([]);
    });

    it("CloudFront ResponseHeadersPolicy Comment is ASCII-safe", () => {
      const policies = template.findResources(
        "AWS::CloudFront::ResponseHeadersPolicy",
      );
      const violations: string[] = [];
      for (const [id, resource] of Object.entries(policies)) {
        const cfg = resource.Properties?.ResponseHeadersPolicyConfig as
          | Record<string, unknown>
          | undefined;
        const comment = cfg?.Comment as string | undefined;
        if (
          typeof comment === "string" &&
          !EC2_DESCRIPTION_ALLOWED.test(comment)
        ) {
          const bad = [...comment].filter(
            (c) => !EC2_DESCRIPTION_ALLOWED.test(c),
          );
          violations.push(
            `${id}: ${JSON.stringify(comment)} -- banned chars: ${JSON.stringify(bad.join(""))}`,
          );
        }
      }
      expect(violations).toEqual([]);
    });
  });
});
