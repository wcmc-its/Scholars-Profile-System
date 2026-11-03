# SPS Security Review Runbook

> **Procedure only.** This doc says how to run a security review of the Scholars Profile System (SPS):
> which scanners run on their own, which ones a person runs and how often, and how to triage and close
> out what they find. It holds no findings. This repo is public, so findings, resource names, account
> ids and raw scanner output stay in the private working area (`~/Dropbox/Projects/Scholars-Profile-System/`).

## 1. What runs automatically

These run without anyone starting them. Nothing here blocks a merge except dependency review.

| Scanner | When it runs | Where results appear |
|---|---|---|
| **CodeQL** (GitHub default setup: JavaScript/TypeScript, Python, Actions) | On pushes and PRs to `master`, and weekly | Security tab, Code scanning, tool `CodeQL`. Visible to maintainers only. |
| **Dependency review** (`.github/workflows/dependency-review.yml`) | Every PR to `master` | A PR check. It fails a PR that adds a high or critical vulnerability in a runtime dependency. Dev-only dependencies are reported, not blocked. |
| **Dependabot** (`.github/dependabot.yml`) | Weekly version updates; security updates as advisories land | Grouped PRs (Actions, root npm, `cdk/` npm), and alerts under Security tab, Dependabot. |
| **Secret scanning** with push protection | Every push | Push protection rejects a push that contains a known secret format. Alerts are under Security tab, Secret scanning. |
| **Checkov** (`.github/workflows/security-scan.yml`) | Weekly (Monday), on any push to `master` touching `cdk/**`, `Dockerfile` or the workflow itself, and by manual dispatch | Security tab, Code scanning, tool `checkov`. Report-only. |

Checkov scans the synthesized CloudFormation for both envs plus the Dockerfile. The workflow discards
Checkov's stdout on purpose: workflow logs on this public repo are public, and Checkov prints every
finding to stdout even when asked for SARIF. Any scanner added to CI must follow the same rule: write
SARIF to code scanning and print nothing.

Check the Security tab when you start a review. Anything open there is an input to sections 3 to 6.

## 2. Cadence

| Review | How often | Section |
|---|---|---|
| Prowler AWS baseline | Quarterly | §3 |
| OWASP ZAP baseline (passive) against staging | Quarterly | §4 |
| OWASP ASVS Level 2 self-assessment refresh | Yearly, and after any change to authentication, session handling, cryptography or data export | §5 |
| Checkov alert triage | Whenever new alerts appear (the weekly run is the trigger) | §6 |
| Close the loop | After each of the above | §7 |

Run Prowler and ZAP in the same quarter so the posture page update (§7) covers both.

## 3. Prowler (AWS account baseline)

Prowler is read-only. It calls describe, list and get APIs and changes nothing.

### Credentials

Use `<read-only audit role>`: a role or profile with the AWS-managed `SecurityAudit` and `ViewOnlyAccess`
policies and nothing else. Do not run Prowler with an administrator key. If the credentials you have
are broader than read-only, stop and get a read-only role first.

Confirm who you are before starting:

```bash
AWS_PAGER="" aws sts get-caller-identity --profile <read-only audit profile>
```

### Run

Install Prowler into a throwaway virtualenv in your scratch directory, not into the repo:

```bash
python3 -m venv /tmp/prowler-venv
/tmp/prowler-venv/bin/pip install --quiet prowler

OUT=~/Dropbox/Projects/Scholars-Profile-System/prowler-$(date +%Y-%m-%d)
mkdir -p "$OUT"

/tmp/prowler-venv/bin/prowler aws \
  --profile <read-only audit profile> \
  --region us-east-1 \
  --output-formats csv html json-ocsf \
  --output-directory "$OUT" \
  2>&1 | tee "$OUT/run.log"
```

Record the Prowler version in the triage notes; check ids and counts shift between releases.

### Outputs

The output folder follows `~/Dropbox/Projects/Scholars-Profile-System/prowler-YYYY-MM-DD/` and holds:

- `prowler-output-<account>-<timestamp>.csv`: semicolon-delimited, one row per check and resource. This is the file to filter.
- `prowler-output-<account>-<timestamp>.html`: the browsable report.
- `prowler-output-<account>-<timestamp>.ocsf.json`: machine-readable, for diffing against the last run.
- `compliance/`: one CSV per framework Prowler maps to.
- `run.log`: the console summary.
- `TRIAGE.md`: your notes (below).

None of these files go into the repo.

### Triage rules

1. **Filter to SPS first.** The AWS account is shared with other teams' systems, so most FAIL rows are
   not SPS's. Filter the CSV on `STATUS=FAIL`, then keep rows whose `RESOURCE_UID`, `RESOURCE_NAME` or
   `RESOURCE_TAGS` identify SPS: names starting `sps-` or `scholars-`, and resources tagged with an
   `aws:cloudformation:stack-name` of one of the `Sps-*` stacks in `cdk/bin/sps-infra.ts`. Account-level
   checks (root, IAM password policy, GuardDuty, CloudTrail) have no SPS resource; review them once and
   route them per rule 4.

   ```bash
   python3 -I - "$OUT"/prowler-output-*.csv <<'EOF'
   import csv, sys
   rows = csv.DictReader(open(sys.argv[1]), delimiter=";")
   for r in rows:
       if r["STATUS"] != "FAIL":
           continue
       hay = " ".join([r["RESOURCE_UID"], r["RESOURCE_NAME"], r["RESOURCE_TAGS"]]).lower()
       if "sps-" in hay or "scholars-" in hay:
           print(r["SEVERITY"], r["CHECK_ID"], r["RESOURCE_NAME"], sep="\t")
   EOF
   ```

2. **Check every critical and high SPS row by hand** before calling it real or a false positive.
   "Secrets in code" and "secrets in image" checks in particular match on patterns; open the matched
   file and look.

3. **Skip the known-noise classes.** These are hardening defaults, not exposure. Note the count and move on:
   - ECS task definitions without a read-only root filesystem. Prowler counts every revision ever registered.
   - Secrets Manager secrets without a customer-managed KMS key, rotation or a resource policy.
   - SNS topics, CloudWatch log groups and similar without a customer-managed KMS key.
   - IAM roles without confused-deputy conditions on service trust policies that AWS or CDK generates.
   - The same classes Checkov flags and §6 has already accepted. Keep the two triages consistent.

4. **Route other teams' findings to their owners.** A finding on a resource SPS does not own goes to
   that system's owner, not into the SPS backlog. Send it privately (email or their tracker), not as an
   issue on this public repo.

5. **Escalate GuardDuty findings to ITS Security.** Any active (unarchived) GuardDuty finding, whatever
   resource it names, goes to ITS Security right away. Do not investigate or archive it yourself first.

6. **Compare with the last run.** New FAIL rows on SPS resources since the previous quarter are the
   main thing to look at. A finding that was triaged as accepted last time does not need a new write-up.

Write the result into `TRIAGE.md` in the run folder, in four groups: needs a human now, real and worth
fixing (with owner), checked and false positive, and noise.

## 4. OWASP ZAP baseline against staging

The baseline scan is **passive only**. ZAP spiders the site for a short time and inspects the responses
(headers, cookies, CSP, information leaks). It sends no attack payloads and submits no forms.

### Before you run

- **Run from the WCM network** (on campus or on the VPN). The staging edge only admits WCM addresses,
  so a scan from elsewhere sees only the block page.
- **Stay well under the edge WAF rate limit.** The WAF rate rule allows 5,000 requests per 5 minutes per
  IP (`cdk/lib/edge-stack.ts`), and the scan shares your IP with your own browsing. The command below
  caps the spider at 1 minute and 1 thread, which keeps the whole scan to a small fraction of the limit.
  Do not raise the thread count or the spider time. If ZAP starts seeing `429` responses, stop the run.
- Docker must be running.

### Run

```bash
OUT=~/Dropbox/Projects/Scholars-Profile-System/zap-$(date +%Y-%m-%d)
mkdir -p "$OUT"

docker run --rm -v "$OUT":/zap/wrk/:rw -t ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py \
    -t https://<staging-host>/ \
    -m 1 \
    -z "-config spider.thread=1" \
    -r zap-baseline.html \
    -J zap-baseline.json \
    -w zap-baseline.md \
  2>&1 | tee "$OUT/run.log"
```

`-m 1` is the spider time in minutes. The exit code is non-zero when ZAP raises warnings or failures;
that is expected and does not mean the run broke.

The baseline does not log in, so it covers the public site and the login redirect, not the `/edit`
console behind SSO. That is acceptable for the quarterly pass.

### Triage

- Read `zap-baseline.md` first. Each alert has a rule id, a risk level and the URLs it fired on.
- Compare header and cookie alerts with the intended policy before calling them findings: CSP is
  described in [`ADR-007`](./ADR-007-csp-script-src-strategy.md), and session cookie attributes in
  [`ADR-013`](./ADR-013-session-revocation.md).
- Alerts on CloudFront or WAF responses (the block page, `429`, cached error pages) are about the edge,
  not the app. Check whether the app's own responses carry the same issue before filing.
- Write `TRIAGE.md` in the run folder with the same four groups as Prowler.

### Why active scans need ITS sign-off

Do not run `zap-full-scan.py`, an active scan, or any fuzzer against staging or prod without written
sign-off from ITS Security. An active scan:

- sends attack payloads (SQL injection, XSS, path traversal) that ITS monitoring will see as a real attack;
- can submit forms and call write endpoints, changing data, and staging shares some upstream services
  with prod;
- will trip the WAF and can get the scanning IP blocked, which affects other people on that address;
- runs against network equipment and an AWS account that other teams share.

A penetration test or active scan is scheduled through ITS Security, with an agreed scope, window and
source IP.

## 5. ASVS refresh as a diff

The ASVS self-assessment is a CSV of OWASP ASVS Level 2 requirements, one row per requirement, with
these columns:

| Column | Content |
|---|---|
| `req_id` | ASVS id, e.g. `V1.1.1` |
| `level` | ASVS level of the requirement (1 or 2) |
| `chapter` | ASVS chapter name |
| `requirement` | The requirement text |
| `status` | `met`, `partial`, `not_met`, `na` or `unknown` |
| `evidence` | Semicolon-separated `path:line` citations into this repo |
| `note` | Why the status was given, and the gap if any |

Each assessment lives in `~/Dropbox/Projects/Scholars-Profile-System/asvs-YYYY-MM-DD/` with the CSV,
the ASVS source JSON it was assessed against, and a `BASE_COMMIT` file holding the `origin/master`
commit the evidence was read from. (If an older folder has no `BASE_COMMIT`, use
`git rev-list -1 --before=<assessment date> origin/master`.)

A refresh does not start from scratch. It re-checks only what could have changed.

1. **Start from the last CSV.** Copy it into a new dated folder and write the current
   `git rev-parse origin/master` into that folder's `BASE_COMMIT`.

2. **Find the rows whose evidence changed.** List the files changed since the last assessment's commit,
   then select every row that cites one of them:

   ```bash
   git fetch origin
   git diff --name-only "$(cat <last-folder>/BASE_COMMIT)" origin/master > /tmp/asvs-changed.txt

   python3 -I - <new-folder>/asvs-l2-assessment.csv /tmp/asvs-changed.txt <<'EOF'
   import csv, sys
   changed = set(open(sys.argv[2]).read().split())
   for r in csv.DictReader(open(sys.argv[1])):
       files = {c.strip().split(":")[0] for c in r["evidence"].split(";") if c.strip()}
       if files & changed:
           print(r["req_id"], r["status"], ", ".join(sorted(files & changed)), sep="\t")
   EOF
   ```

   Re-assess each selected row: read the current code at the cited files, update `status`, `evidence`
   (line numbers move) and `note`.

3. **Re-assess rows touched by the trigger.** For an off-cycle refresh after an auth, session, crypto or
   data-export change, also re-assess every row in the matching ASVS chapters, even if its cited files
   did not change. New code can satisfy or break a requirement without touching the old evidence.

4. **Add new requirements.** If OWASP has published a new ASVS version, diff its requirement ids against
   the CSV's `req_id` column and assess the new or reworded ones. Keep the source JSON of the version
   you assessed against in the folder.

5. **Revisit `unknown` and `not_met` rows.** Check whether any `not_met` row has been fixed since, and try
   to resolve every `unknown`.

6. **Spot-check by hand.** Rows are often drafted with AI help, so a person who did not draft them
   checks a sample: about 20 rows, weighted toward `met` (the status most costly to get wrong), and
   including every row whose status changed in this refresh. Record who checked which rows in the folder.

7. **Save** the CSV, the source JSON, `BASE_COMMIT` and a short `CHANGES.md` (rows changed, with old and
   new status) in the new dated folder. Nothing from the assessment goes into this repo.

## 6. Checkov alert hygiene

The weekly Checkov run can raise new alerts when Checkov adds checks, even with no change on our side.
Keep the open-alert list down to things nobody has looked at yet.

- **Triage each new alert** in the Security tab (Code scanning, tool `checkov`) into one of three outcomes:
  real fix, false positive, or accepted won't-fix. Map the alert back to its CDK construct
  (`cdk/lib/*.ts`) before deciding.
- **Real fix:** open an issue, or fix it directly in a PR. The alert closes on the next scan after the
  fix lands on `master`.
- **False positive:** dismiss the alert in code scanning as "False positive" with a one-line reason.
- **Accepted won't-fix:** add the check id to the skip list in the Checkov config file, with a comment
  giving the reason. That config file, not alert dismissals, is the record of what SPS has accepted, and
  it applies to future alerts of the same class. Keep each reason specific to SPS (for example, which
  resources are affected and why the default is enough), and don't cite an ADR unless the ADR actually
  makes that decision.
- Prefer skipping a check for specific resources over skipping it globally when only some resources
  justify it.
- Review the skip list once a year, at the ASVS refresh, and remove entries whose reason no longer holds.

## 7. Closing the loop

After each review:

1. **Update the SPS security posture page.** Change the status of each scanner and review (last run date,
   counts at a summary level) and the open-items list. It is not linked from this repo; the SPS team
   can share it.
2. **Open issues for real SPS findings** on this repo, with a title and description that state the fix,
   not the exposure ("Restrict ingress on X to Y", not a description of what an attacker could reach).
   Leave out resource ids, hostnames, IPs, account ids and scanner output.
3. **Send other teams' findings to their owners** privately (§3 rule 4), and GuardDuty findings to ITS
   Security (§3 rule 5).
4. **Keep detailed findings out of this public repo.** Triage notes, raw scanner output, ASVS CSVs and
   anything naming a specific weakness stay in the dated folders under
   `~/Dropbox/Projects/Scholars-Profile-System/`. Before pushing any change that came out of a review,
   check the diff for account ids, hostnames, IPs and IAM user names.
5. **Record decisions.** A finding accepted as a design decision (not just a hardening default) gets an
   ADR, as [`ADR-013`](./ADR-013-session-revocation.md) and [`ADR-014`](./ADR-014-saml-inresponseto-not-validated.md)
   do for session revocation and SAML `InResponseTo`.
