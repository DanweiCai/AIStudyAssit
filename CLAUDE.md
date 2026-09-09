# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

**Pre-implementation.** The repo contains three specs and nothing else — no code, no build tooling, no `docker-compose.yml`. The commands below do not exist yet; they are what T-001/T-002 must create.

Work is picked up from `docs/TASKS.md`, starting at T-001.

**Deployment scope: local, single-user** (`REQ §2.4`, decided 2026-09-08). `docker compose` is the only target — there is no hosted environment. T-006 is a seeded dev user behind a fixed `.env` token, not an auth system; but `user_id` and query-layer scoping stay in the schema so multi-user remains a resolver swap. Input-facing security (content-type sniffing, SSRF guards, no-training-on-user-content) is **not** relaxed by this.

## The three specs and their precedence

| Doc | Answers | Cadence |
|---|---|---|
| `docs/REQUIREMENTS.md` | *what and why* — `FR-*` / `NFR-*` IDs, personas, artifact quality bars, data model, release phases | slow |
| `docs/TECHNICAL_DESIGN.md` | *how* — API contract, job state machine, artifact JSON Schemas, grounding validation, model strategy, cost arithmetic, eval harness | with the implementation |
| `docs/TASKS.md` | *in what order* — 62 tasks with dependencies, spec refs, and mechanically checkable acceptance criteria | continuously |

[`docs/WALKTHROUGH.md`](docs/WALKTHROUGH.md) is a **derived** teaching doc — one PDF traced end to end through all four services. Not a spec: it cites the three above and loses to them on any disagreement. Update it when the flow it describes changes.

Requirement IDs are defined only in `REQUIREMENTS.md`; the other two cite them as `REQ §x` / `TD §x`. **On contradiction, requirements win on *what*, design wins on *how*, and the contradiction gets logged rather than quietly resolved.** One contradiction is live on purpose: `TD §7.5` prices the free tier written into `REQ NFR-COST-2` at an unviable $5.55/user/month (tracked as T-134). Do not "fix" it by editing one side.

Read the sections a task cites before writing code for it. When the specs are silent on something you need, append to the Open Items table at the bottom of `docs/TASKS.md` — never invent spec.

## Planned stack and commands (once T-001/T-002 land)

Monorepo: `apps/api` (FastAPI), `apps/worker` (Celery), `apps/web` (Next.js), `packages/schemas` (JSON Schema).

```bash
docker compose up          # Postgres, Redis, MinIO
pytest                     # backend tests; pytest path::test_name for one
ruff check . && mypy --strict .
cd apps/web && vitest       # vitest run -t "name" for one
```

Python 3.12+, SQLAlchemy 2.0 + Alembic, `anthropic` Python SDK, PyMuPDF / python-pptx / python-docx / trafilatura for parsing. TypeScript strict on the frontend. Full selection table with rationale: `docs/TASKS.md` § Stack — Selected.

## Architecture

Four deployable units, split along scaling and failure-isolation lines (`TD §1`): **API** (auth, CRUD, job submission, SSE fan-out), **ingest worker** (parse → normalize → chunk), **generation worker** (retrieve → prompt → LLM → validate → persist), and **audio worker** — a separate pool specifically because a 12-minute overview occupies a worker for minutes while a study guide takes seconds.

Six artifacts are generated from a user's uploaded sources: Audio Overview, Study Guide, Briefing Document, FAQ Sheet, Timeline Guide, Mind Map.

### Two decisions that are cheap now and a rewrite later

**1. `packages/schemas/*.json` is the single source of truth across the language boundary.** Each artifact schema is the contract in three places at once — the LLM's `output_config.format`, the `Artifact.content` JSONB shape, and the renderer's input type. Pydantic models and TS types are *generated* from it and committed; CI fails on a stale diff (T-005). Hand-editing a generated Pydantic model to "just add a field" makes the LLM contract and the renderer silently disagree, surfacing as a mysteriously empty section in a user's study guide.

**2. `GenerationJob` in Postgres is the job record; Celery is only an executor** (T-008). Celery's result backend does not model the leases, `attempt` counts, or `cancelling` state that `TD §3.1` requires, and building on it yields job status that is unqueryable after a worker restart.

### Grounding is the product

Every factual claim traces to a citation in the user's own sources. Four layers (`TD §5.1`) — prompt, labeled context, schema (`minItems: 1` on citation arrays), and post-generation validation. Only the fourth is adversarial: it assumes the first three failed.

`TD §5.3`'s degradation policy is per-element and differs by artifact — a Study Guide key point is retained with `uncited: true`, a briefing `key_facts` item is dropped, a FAQ item with an unverifiable quote is removed entirely, and audio fails wholesale on any unresolvable turn. On top of that sits an artifact-level `resolution_rate` gate (≥0.95 ship / retry / fail). **T-114 owns this and is the highest-risk task on the critical path — build it before the renderers**, since retrofitting degraded-state rendering into a UI that assumes complete artifacts is a rewrite.

Verbatim quote checking runs against `Chunk.text_normalized`, precomputed at ingest by the 7-step normalization ladder in `TD §5.4` (NFKC, soft hyphens, dehyphenation, quote/dash folding, whitespace collapse). Case and punctuation are preserved — a quote that changes case is a misquote.

### Prompt cache ordering is a cost mechanism

`TD §6.4`: system prompt = role + grounding rules, then the source corpus (cache breakpoint), then the artifact-specific spec in `messages`. Putting the spec *before* the breakpoint invalidates the cache on every artifact and forfeits a ~3× cost difference. Per-artifact **model** mixing is measured at **+14%** (two corpus cache writes) and is rejected — `effort` is the free per-artifact lever; model tier is all-or-nothing per notebook and gated on eval evidence (T-406).

## Cross-cutting rules

These apply to every task (`docs/TASKS.md` § Cross-Cutting Rules):

- **No fabricated grounding.** Any path producing user-visible factual content routes through the T-113/T-114 validators — no exception for "internal" artifacts.
- **Model IDs come from config**, never a string literal, never date-suffixed.
- **Every money-spending endpoint is idempotent** — both layers: `Idempotency-Key` replay *and* server-side in-flight fingerprint dedup. Without the second, a double-click bills twice.
- **Every long operation is a job.** No synchronous request holds a connection open for an LLM call.
- **Every artifact records provenance** — sources, model, prompt template version, schema version, trace ID.
- **Silent truncation is a bug.** If output was capped, sampled, or dropped, `warnings[]` tells the user.
- **User content is never used for training.**
- **Stream every LLM call.**

## Anthropic API specifics (`TD §6.2`)

Stale priors get each of these wrong on Opus 5:

- `budget_tokens` is **removed** — returns 400. Depth is `output_config.effort`. Use `thinking: {type: "adaptive"}`.
- Structured output is `output_config.format`, not the deprecated top-level `output_format`.
- Assistant prefill is **removed** — format control comes from the schema and system prompt.
- Opus 5 has a 1M context window, so the entire 500K-token notebook cap fits in one request; hierarchical summarization is a cost optimization, not a correctness requirement (T-217 decides whether to build it at all).
- Verify `usage.cache_read_input_tokens` is non-zero in staging. Zero across repeated generations means something is silently invalidating the prefix — a timestamp in the system prompt, unsorted `source_ids`, or a varying tool list — which is a cost incident with no error signal.

## Task hygiene

**[`docs/WORKFLOW.md`](docs/WORKFLOW.md) is the binding procedure for all coding work** — one task → one branch (`task/T-XXX-slug`) → one PR, with the full local gate run and every acceptance criterion individually verified before the PR opens. Invoke it with the `/task` skill (`/task T-104`, or bare `/task` to take the next eligible task).

Update the Status column in `docs/TASKS.md` (`TODO` → `WIP` → `DONE`/`BLOCKED`) in the same PR as the work. A task is done when its acceptance criteria pass, not when the code is written. If a task cannot be completed as specified, stop and report why rather than substituting an adjacent implementation. Never report a gate as passing when it was skipped.
