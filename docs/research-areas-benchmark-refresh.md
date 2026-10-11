# Research-area benchmark: publishing a new snapshot

How to refresh the comparison at [`/about/research-areas`](https://scholars.weill.cornell.edu/about/research-areas) and the numbers in the `/about#research-areas` paragraph.

The benchmark compares ReciterAI's research areas with WCM departments and divisions, the CARE Strategic Plan, NIH Institutes and Centers, and NIH RCDC categories. ReciterAI produces it; SPS only displays it. The method, prompts and code live in [`wcmc-its/ReciterAI` `docs/benchmark/`](https://github.com/wcmc-its/ReciterAI/tree/main/docs/benchmark). Read its README before rerunning anything.

## When to refresh

- Whenever ReciterAI's `taxonomy_version` changes (areas added, removed, renamed or redefined).
- Otherwise at least once a year, so the department list and the NIH RCDC categories and funding amounts stay current.

Never edit a published snapshot. A correction ships as a new snapshot with a new date and a change note. The old one stays viewable at `/about/research-areas/<date>`.

## Step 1. Rerun the benchmark (ReciterAI repo)

Work on a branch in a ReciterAI checkout. All paths below are relative to `docs/benchmark/`.

1. **Freeze the inputs.**
   - Frame A (departments and divisions): rerun `mapping/sps_probe_frame_a.ts` against SPS prod with `scripts/run-staging-probe.sh <file> prod` from an SPS checkout. It is read-only and returns aggregates only. Save the results into `inputs/frameA_*.csv`, `inputs/wcm_departments.csv` and `inputs/wcm_divisions.csv`.
   - `inputs/research_areas.csv`: export the current taxonomy (id, label, description).
   - `inputs/nih_rcdc_categories.csv`: the latest fiscal year from NIH RePORT's RCDC table. If the fiscal year changes, rename the `fy2025_amount_musd` column and the matching key in `export_json.py` and the page.
   - `inputs/nih_institutes_centers.csv`, `inputs/care_plan_items.csv`: update only if NIH or the plan has changed.
2. **Bump the snapshot.**
   - `crosswalk.py`: set `SNAPSHOT_DATE` to the freeze date (`YYYY-MM-DD`).
   - `export_json.py`: set `TAXONOMY_VERSION` if it changed, and write `CHANGE_NOTE` (one line: what moved since the last snapshot, such as taxonomy changes, reference list changes, or headline deltas).
   - Update the snapshot line at the top of the README.
3. **Rerun the blind mapping** for frames B, C1 and C2 with `mapping/blind_mapping.js`, then `mapping/gap_review.js`. These are Claude Code workflow scripts. They write `outputs/mapping_raw.json` and `outputs/gap_review.json`.
4. **Build the outputs:**
   ```bash
   python3 docs/benchmark/frame_a.py
   python3 docs/benchmark/frames_bc.py
   python3 docs/benchmark/crosswalk.py
   ```
5. **Do the spot check.** Draw the sample with `python3 docs/benchmark/spot_check_sample.py` (a seeded 10% of the final pairs; it refuses to overwrite a sample that already has reviews, so move the old one aside first). Fill in `reviewer_agrees` (`yes`/`no`) and `reviewer_note` for every row of `outputs/spot_check_sample.csv`. A `no` means the match or its relation type is wrong; say which in the note. Then set `SPOT_CHECK_METHOD` (`"human"` or `"automated"`), `SPOT_CHECK_REVIEWED_BY` and `SPOT_CHECK_REVIEWED_ON` in `export_json.py`. The page states which kind of review was done, so `automated` must never be recorded as `human`. Report the agreement rate in the README's spot-check paragraph.
6. **Export:**
   ```bash
   python3 docs/benchmark/export_json.py
   ```
   This writes `outputs/benchmark-<date>.json`, refreshes `benchmark-latest.json` and `research-areas-reference-crosswalk-latest.csv`, and adds the snapshot to `outputs/benchmark-index.json`. Before writing, it recomputes every headline number from the row-level data and stops with an `AssertionError` if any disagree. Fix the inputs; don't edit the JSON.
7. **Check the headlines against the README** (`python3 -c "import json;print(json.load(open('docs/benchmark/outputs/benchmark-latest.json'))['headline'])"`). If they moved, update the README's results table and prose to match.
8. Open a PR and merge it. The SPS page links to `blob/main`, so the dated crosswalk CSV must be on `main` before step 2 ships.

## Step 2. Import into SPS

From a fresh branch off `origin/master`:

```bash
git -C ~/Dropbox/GitHub/ReciterAI pull   # main, with the merged snapshot
scripts/import-benchmark.sh ~/Dropbox/GitHub/ReciterAI
git add data/benchmark/benchmark-<date>.json data/benchmark/index.json
```

The script copies every snapshot in ReciterAI's index plus the index itself. It fails if:
- an already-imported snapshot has changed (snapshots are immutable), or
- the newest snapshot's spot check isn't complete (it may not be published until it is).

No page code changes are needed. The new snapshot becomes the default at `/about/research-areas`, the previous one moves to `/about/research-areas/<old-date>` and appears in the snapshot picker, and the About paragraph picks up the new numbers and month.

**Code changes are needed only if:**
- `schema_version` was bumped (a breaking JSON change). Update the types in `lib/benchmark.ts` and the page component, and keep older snapshots rendering.
- The gaps changed shape. The gap explanations on the page (`LOWNOTE`, `NOIC`, `RCDCG` in `components/about/research-areas-benchmark.tsx`) were transcribed from the 2026-10-10 README. New ids fall into generic "Other" groups. If the README's gap analysis changed, update those constants.
- The About paragraph's wording no longer fits the numbers (for example, the CARE plan stops matching in full, or a frame's story changes). The sentence template is in `app/(public)/about/page.tsx`.

## Step 3. Verify

1. `npm run typecheck`, then open a PR. CI must be green.
2. After the staging deploy, check:
   - every headline number on `/about/research-areas` and in the `/about#research-areas` paragraph matches the ReciterAI README;
   - the snapshot picker lists every snapshot, older snapshots show the "This is the <date> snapshot" banner, and `/about/research-areas/<latest-date>` redirects to `/about/research-areas`;
   - area and department links resolve (a retired area or unit shows as plain text, which is expected for old snapshots);
   - the page has no horizontal page scroll at 390 px (the heatmap scrolls inside its own box).
3. Ask before merging, then deploy to prod as usual. The page is ISR (hourly), and a deploy starts a fresh cache.
