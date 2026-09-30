# scripts/bulk-data-rule/ pipeline image (containerization design, 2026-08-14
# — see ~/Dropbox/Projects/Bulk Data Rule/2026-08-14-pipeline-containerization-design.md).
#
# Runs the DB-write path only: extract_databanks -> scan2 -> preprint_extend -> attribute
# (WRITE_DATASET_DEPOSIT=1). .xlsx deliverable generation (build_outputs.py/build_people.py)
# and the standalone mesh_sensitive.py/coauthor_affil.py steps stay analyst-local, against
# downloaded row data — not run in this image (design decision #1).
#
# One-off manually-triggered `ecs run-task`, never a scheduled step (design's Non-goals) —
# no CI/deploy pipeline builds this; pushed by hand to the dedicated scholars-bulk-data-rule-<env>
# ECR repo when the pipeline itself changes.
FROM python:3.13-slim

# awscli: the entrypoint's provenance sync (aws s3 sync) to curationBackupBucket.
# curl: reads the ECS task metadata endpoint for the running image's digest.
RUN apt-get update && apt-get install -y --no-install-recommends awscli curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Only the DB-write-path scripts + the modules they import — build_outputs.py, build_people.py,
# mesh_sensitive.py, coauthor_affil.py are analyst-local-only (design decision #1) and deliberately
# not copied in.
COPY catalog.py taxonomy.py datacite.py snapshot.py extract_databanks.py scan2.py preprint_extend.py attribute.py ./
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# S-Index scope for this pilot (README's own "S-Index scope (department pilot)" section) — set
# here, not left to the operator, so a bare run-task can't silently fall back to the much larger
# original Bulk Data Rule landscape scope (caught and redone once already this session per the
# design doc's own Status section). ECS task overrides can still change it per-run if ever needed.
ENV PILOT_DEPARTMENT="Systems and Computational Biomedicine"
ENV WRITE_DATASET_DEPOSIT=1

# Every script's OUT = os.path.expanduser("~/Dropbox/Projects/Bulk Data Rule/data") — there's no
# such analyst home in a container. Redirecting HOME instead of editing any of the 4 scripts keeps
# every one of them (and the entrypoint's own s3 sync target) agreeing on the same writable path.
ENV HOME=/app

# Baked at build/push time (docker build --build-arg GIT_SHA=$(git rev-parse HEAD) ...) — part of
# the run-manifest the entrypoint writes (design decision #1's provenance layer).
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA

ENTRYPOINT ["./entrypoint.sh"]
