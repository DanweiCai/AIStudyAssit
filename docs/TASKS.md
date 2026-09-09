# AI Study Assistant — Implementation Task List

**Project:** AIStudyAssit
**Version:** 0.1
**Date:** 2026-08-24
**Specs:** [`REQUIREMENTS.md`](./REQUIREMENTS.md) · [`TECHNICAL_DESIGN.md`](./TECHNICAL_DESIGN.md)

---

## How to Use This Document

This is an execution list for an AI coding agent (or a human) working through the build in order.

**Rules for the executing agent:**

1. **Work tasks in dependency order.** A task's `Depends on` must be `DONE` before starting it. Tasks with no unmet dependencies can run in parallel.
2. **Read the referenced spec sections before writing code.** Each task cites `REQ §x` (requirements) or `TD §x` (technical design). The spec is authoritative; this list is a sequencing aid, not a substitute.
3. **A task is done when its acceptance criteria pass** — not when the code is written. Every criterion is written to be mechanically checkable.
4. **Do not silently expand scope.** If a task cannot be completed as specified, stop and report why rather than substituting an adjacent implementation.
5. **Update the status column** as you go: `TODO` → `WIP` → `DONE` / `BLOCKED`.
6. **Never invent spec.** If the specs are silent or contradictory on something you need, add it to [Open Items](#open-items-discovered-during-implementation) at the bottom and ask.

**Task ID scheme:** `T-<phase><nn>`. Phase 0 = foundations, 1–4 = the release phases in `REQ §12`.

---

## Stack — Selected

`TECHNICAL_DESIGN.md` specifies stack *constraints*; these are the selections. **Python backend, TypeScript frontend** (confirmed 2026-08-24). Stack-specific tasks are marked 🔧.

| Layer | Selection | Why |
|---|---|---|
| Backend language | Python 3.12+ | The document-parsing ecosystem is materially better here — PyMuPDF, python-pptx, python-docx, and trafilatura are more mature than the Node equivalents, and ingestion fidelity (FR-ING-1..5) is a P0 risk |
| API | FastAPI + Uvicorn | Native async for SSE and streaming; Pydantic models generated from the §4 schemas |
| Workers | Celery + Redis | Mature, durable, well-understood retry and routing. **See the caveat below** |
| DB | Postgres 16 + SQLAlchemy 2.0 + Alembic | JSONB for `Artifact.content` |
| Object storage | S3-compatible (MinIO locally) | Originals, MP3s, trace blobs |
| LLM | `anthropic` Python SDK, `claude-opus-5` | TD §6 |
| Parsing | PyMuPDF (PDF), python-pptx, python-docx, trafilatura (web) | TD §8.5 constraints |
| Frontend | Next.js (App Router) + TypeScript | |
| Vector store | Deferred to Phase 2 | REQ FR-PROC-4 is P1 |

### Two consequences of the split — both are real work, not paperwork

**1. The schemas now cross a language boundary. Do not hand-maintain both sides.**

`packages/schemas/*.json` (JSON Schema) is the single source of truth. Three consumers generate *from* it:

```
packages/schemas/*.json  ──┬──▶ Pydantic models      (datamodel-code-generator)  → backend validation
                           ├──▶ TypeScript types     (json-schema-to-typescript) → frontend rendering
                           └──▶ output_config.format (passed verbatim)           → the LLM contract
```

Generation runs in CI and the result is committed; **a PR where generated types are stale fails the build.** The moment someone hand-edits a Pydantic model to "just add a field," the LLM contract and the renderer silently disagree, and the failure surfaces as a mysteriously empty section in a user's study guide. T-005 owns this.

**2. Celery's task state is not the job record.**

`TD §3.1` specifies a state machine with leases, attempt counts, and a `cancelling` state. Celery's result backend does not model that, and building on it produces a system where job status is unqueryable after a worker restart. **`GenerationJob` in Postgres is the source of truth**; Celery is an executor that reads and writes that row. T-008 owns this distinction — getting it wrong is a Phase 2 rewrite.

---

## Phase 0 — Foundations

Nothing user-facing ships here. The goal is that Phase 1 tasks can be executed without stopping to make infrastructure decisions.

| ID | Task | Depends on | Status |
|---|---|---|---|
| T-001 🔧 | **Repo scaffold and tooling** — monorepo: `apps/api` (FastAPI), `apps/worker` (Celery), `apps/web` (Next.js), `packages/schemas` (JSON Schema). Python: `uv` or Poetry, `ruff`, `mypy --strict`, `pytest`. Web: TypeScript strict, ESLint, Prettier, Vitest. `.env.example` naming every variable. | — | WIP |
| T-002 🔧 | **Docker Compose dev environment** — Postgres, Redis, MinIO. One `docker compose up` gives a working local stack for both the Python services and the web app. | T-001 | TODO |
| T-003 | **CI pipeline** — Python (ruff, mypy, pytest) and web (eslint, tsc, vitest) on every PR, **plus a check that generated schema types are not stale** (T-005). No deploy yet. | T-001, T-005 | TODO |
| T-004 🔧 | **Database schema v1** — SQLAlchemy 2.0 models + Alembic migration for `User`, `Notebook`, `Source`, `Chunk`, `Artifact`, `GenerationJob` per `REQ §9`. Include `deleted_at`, `parent_artifact_id`, `trace_id`, `content_schema_version`, `text_normalized`. Omit `Embedding` (Phase 2). | T-002 | TODO |
| T-005 🔧 | **Schema pipeline — single source of truth across the language boundary** — author the six `TD §4` schemas as JSON Schema in `packages/schemas`. Generate Pydantic models (`datamodel-code-generator`) and TS types (`json-schema-to-typescript`); commit both. Same files feed `output_config.format`. **Add the CI staleness check** — regenerate and fail if the diff is non-empty. This task is load-bearing for the whole build; see the stack note above. | T-001 | TODO |
| T-006 | **Single-user context** — seed one dev user in the initial migration; `Authorization: Bearer` middleware resolving a fixed `.env` token to that user. Every route still requires a user, and isolation is still enforced **at the query layer, not the handler layer**, so multi-user later is a swap of the resolver rather than a migration. No signup, login UI, passwords, or OAuth. (`REQ §2.4`; `NFR-SEC-1` deferred) | T-004 | TODO |
| T-007 | **Error envelope and error-code registry** — the `{error: {code, message, details}}` shape from `TD §2.1`, with every code from `TD §2.3` defined in one enum. | T-001 | TODO |
| T-008 🔧 | **Job queue harness** — Celery + Redis executing against a **Postgres-owned `GenerationJob` row** implementing the `TD §3.1` state machine: 10-minute lease, exponential backoff, `attempt` tracking, `cancelling` state, and the retryable/terminal classification from `TD §3.3`. Do **not** use Celery's result backend as the job record — see the stack note. Test: kill a worker mid-job and confirm the job returns to `queued` with `attempt` incremented. | T-002, T-004 | TODO |
| T-009 | **Trace record writer** — the `TD §9.1` structure, blobs to object storage, 30-day TTL. Wired into the job harness so every job emits one. (`REQ NFR-OBS-1/2`) | T-008 | TODO |
| T-010 🔧 | **Anthropic client wrapper** (`anthropic` Python SDK) — model IDs from config (never hardcoded, never date-suffixed), `thinking={"type":"adaptive"}`, `output_config` carrying `effort` and `format`, **streaming via `client.messages.stream()`**, and a most-specific-first exception chain (`NotFoundError` → `RateLimitError` → `APIStatusError` → `APIConnectionError`) feeding the T-008 retryable/terminal split. Records `usage` including `cache_read_input_tokens` into the trace. Note: `budget_tokens` and assistant prefill are removed on Opus 5 — both return 400. | T-001, T-009 | TODO |

**Phase 0 exit:** `docker compose up` brings the stack up; `pytest` and `vitest` are green; generated Pydantic and TS types are in sync with `packages/schemas`; a stub job can be enqueued and observed through every state in `TD §3.1` including worker-death recovery; a trace record lands in object storage.

---

## Phase 1 — Ingest → Study Guide → Read

Target: `REQ §12 Phase 1`. A user uploads a PDF and gets a citation-backed study guide within the NFR-PERF-8 budget.

### Ingestion

| ID | Task | Depends on | Status |
|---|---|---|---|
| T-101 | **Notebook CRUD** — `POST/GET/PATCH/DELETE /v1/notebooks` per `TD §2.2`. Soft delete. Cursor pagination. | T-006, T-007 | TODO |
| T-102 | **Source upload endpoint** — multipart and JSON variants per `TD §2.3`. Content-type **sniffed, not trusted from the extension** (`REQ NFR-SEC-5`). Enforces the `TD §2.3` error codes. Returns `202 {source, job}`. | T-101, T-008 | TODO |
| T-103 | **Limit enforcement** — 50 MB/file, 50 sources, 500K tokens per notebook, with the token cap as the binding check (`REQ FR-ING-10`). Distinct error codes per limit. | T-102 | TODO |
| T-104 🔧 | **PDF text extraction** (PyMuPDF) — text with page numbers preserved, reading order correct on multi-column layouts. Emits the common document representation. (`REQ FR-ING-1`) | T-008 | TODO |
| T-105 | **Pasted-text ingestion** — title + raw text as a source. (`REQ FR-ING-6`) | T-008 | TODO |
| T-106 | **Text normalization** — the 7-step pipeline from `TD §5.4`. Populates `Chunk.text_normalized` at ingest. Unit-tested against a fixture set containing ligatures, soft hyphens, hyphenated line breaks, smart quotes, and multi-column whitespace. | T-001 | TODO |
| T-107 | **Semantic chunking** — 800–1200 tokens, ~15% overlap, respects section boundaries. Every chunk carries a locator `{page, char_range}`. (`REQ FR-PROC-2/3`) | T-104, T-106 | TODO |
| T-108 | **Ingest worker** — orchestrates parse → normalize → chunk → persist, with per-stage progress. Partial failure isolation: one bad source does not block others (`REQ NFR-REL-4`). | T-104, T-105, T-107 | TODO |
| T-109 | **Content-hash dedup** — reject duplicate uploads within a notebook with `duplicate_source`. (`REQ FR-PROC-7`) | T-108 | TODO |

### Generation

| ID | Task | Depends on | Status |
|---|---|---|---|
| T-110 | **Prompt template system** — versioned templates with the 6-part structure from `REQ §10.4`. Template version recorded on every artifact and trace. Cache breakpoint placed per `TD §6.4` (corpus before spec — **verify `cache_read_input_tokens` is non-zero**). | T-010 | TODO |
| T-111 | **Study Guide prompt + generation** — schema from `TD §4.2`, quality bar from `REQ §6.2`. | T-110, T-005 | TODO |
| T-112 | **Briefing Document prompt + generation** — schema from `TD §4.3`, quality bar from `REQ §6.3`. | T-110, T-005 | TODO |
| T-113 | **Citation resolution validator** — the 3-step check in `TD §5.2`. Repairs drifted locators, flags unresolvable chunk references. | T-107, T-005 | TODO |
| T-114 | **Degradation policy engine** — per-element actions from the `TD §5.3` table, the artifact-level rate gate (0.95 / 0.80 thresholds), corrective-retry prompt, and `warnings[]` on completion. **This is the single most important correctness component in the build.** | T-113 | TODO |
| T-115 | **Generation worker** — retrieve scope → assemble → call model → validate → degrade → persist. Uses only `ready` sources and records which were skipped (`REQ FR-GEN-10`). | T-111, T-112, T-114 | TODO |
| T-116 | **Artifact endpoints** — `POST/GET/DELETE` per `TD §2.4`, plus `/regenerate` creating a new artifact with `parent_artifact_id` set. | T-115, T-101 | TODO |
| T-117 | **Two-layer idempotency** — `Idempotency-Key` replay (24h) **and** server-side in-flight fingerprint dedup, per `TD §2.4`. Both layers required; a test must cover the double-click case specifically. (`REQ FR-GEN-9`) | T-116 | TODO |
| T-118 | **Job status + SSE endpoints** — `GET /v1/jobs/{id}`, `DELETE` (cancel), `GET /events` with `Last-Event-ID` replay. Polling must converge independently of the stream (`TD §2.5`). | T-008 | TODO |
| T-119 | **Cancellation semantics** — abort the in-flight provider request, mark `cancelled`, **refund quota** (`TD §3.2`). | T-118, T-115 | TODO |

### Client

| ID | Task | Depends on | Status |
|---|---|---|---|
| T-120 🔧 | **App shell** — no auth screens under the single-user scope (`REQ §2.4`) | T-006 | TODO |
| T-121 🔧 | **Notebook list and detail views** | T-101, T-120 | TODO |
| T-122 🔧 | **Upload UI** — drag-and-drop, multi-file, per-source progress and status, actionable error messages mapped from the `TD §2.3` codes. (`REQ FR-ING-7/8/9`) | T-102, T-121 | TODO |
| T-123 🔧 | **Generation trigger + progress UI** — non-blocking, elapsed and estimated remaining time, never a bare indeterminate spinner (`REQ NFR-UX-6`). Consumes the SSE stream, falls back to polling. | T-118, T-121 | TODO |
| T-124 🔧 | **Study Guide renderer** — outline, hidden-then-revealed model answers, glossary. Uncited claims rendered with the subdued marker from `TD §5.3`. | T-111, T-121 | TODO |
| T-125 🔧 | **Briefing renderer** | T-112, T-121 | TODO |
| T-126 🔧 | **Citation chips + source jump** — click a citation → open the source at its locator with the range highlighted. Backed by `GET /v1/sources/{id}/chunks`. (`REQ FR-QA-3`) | T-124, T-125 | TODO |
| T-127 🔧 | **Warnings surface** — render `warnings[]` from job completion ("2 items removed: sources could not be verified"). Never let a degraded artifact look complete. | T-114, T-123 | TODO |
| T-128 | **Markdown export** — `GET /v1/artifacts/{id}/export?format=md` + copy-to-clipboard. (`REQ FR-EXP-1/6`) | T-116 | TODO |
| T-129 🔧 | **Issue reporting UI** — `POST /v1/artifacts/{id}/report` with `claim_path`, wired to the trace ID. (`REQ NFR-ACC-5`, `NFR-OBS-3`) | T-116, T-124 | TODO |

### Phase 1 hardening

| ID | Task | Depends on | Status |
|---|---|---|---|
| T-130 | **Golden corpus v1** — 12 documents (subset of the `TD §8.1` 40), with human-authored reference outputs for Study Guide and Briefing. Include at least 2 adversarial documents. | T-111, T-112 | TODO |
| T-131 | **Automated eval suite** — the `TD §8.2` gating metrics for the two Phase 1 artifacts. Runs in CI on prompt/model changes. Use the Batch API to keep run cost near `TD §8.4` figures. | T-130, T-003 | TODO |
| T-132 | **Cost telemetry** — per-job, per-user, per-notebook token and dollar tracking from the trace `usage` fields. Dashboard showing cost/artifact and cache hit rate. (`REQ NFR-COST-1`) | T-009 | TODO |
| T-133 | **Rate limiting and quotas** — the `REQ NFR-SEC-7` limits and `NFR-COST-2` quotas. Quota charged on success only. **See T-134 first.** **[local-v1: enforcement deferred (`REQ §2.4`); build the counters behind a disabled flag so T-134 still has data to reason about.]** | T-132 | TODO |
| T-134 | **Resolve the free-tier contradiction** — `TD §7.5` shows the requirements' drafted tier (30 text + 3 audio) costs ~$5.55/user/month and recommends 10 text + 1 audio. Validate against Phase 1 real cost telemetry, then amend `REQ NFR-COST-2`. **Product decision, not an engineering one.** | T-132 | TODO |
| T-135 | **Deletion cascade test** — a deletion request (notebook, source, or the whole user) purges sources, chunks, artifacts, **and trace blobs**. Traces live in a different bucket and are the most likely thing to be missed (`TD §9.2`). Explicit test required. | T-009, T-006 | TODO |

**Phase 1 exit:** `REQ §12 Phase 1` exit criteria met — upload a PDF, get a correct citation-backed study guide within NFR-PERF-8 (< 3 min p95). Eval suite green. Cost per artifact measured against `TD §7.3`.

---

## Phase 2 — Full Text Artifacts and Chat

| ID | Task | Depends on | Status |
|---|---|---|---|
| T-201 🔧 | **PPTX extraction** (python-pptx) — per-slide text, titles, speaker notes; slide-number locators. (`REQ FR-ING-2`) | T-108 | TODO |
| T-202 🔧 | **DOCX extraction** (python-docx) — text with heading hierarchy; heading locators. (`REQ FR-ING-3`) | T-108 | TODO |
| T-203 | **TXT/Markdown ingestion** (`REQ FR-ING-4`) | T-108 | TODO |
| T-204 🔧 | **URL ingestion** (trafilatura) — fetch + article extraction, boilerplate stripping. **Server-rendered HTML only**; `requires_javascript` error for SPA shells; paywall detection. (`REQ FR-ING-5/5a`) | T-108 | TODO |
| T-205 | **SSRF protection** — public HTTP(S) only, block private/link-local/metadata ranges, validate after every redirect hop. (`REQ NFR-SEC-6`) | T-204 | TODO |
| T-206 | **Embedding pipeline + vector store** — first genuine consumer arrives with chat. Includes the `Embedding` entity from `REQ §9` and re-embed handling on model change. (`REQ FR-PROC-4`) | T-107 | TODO |
| T-207 | **RAG retrieval** — chunk retrieval scoped by notebook and source selection, metadata filtering. | T-206 | TODO |
| T-208 🔧 | **Verbatim quote validator** — the `TD §5.4` match ladder: normalized substring → 0.95 Levenshtein (`rapidfuzz`) → fail. Metric on the fuzzy-fallback rate; if it exceeds 5%, the extractor is the problem, not the model. | T-106 | TODO |
| T-209 | **FAQ Sheet generation** — schema `TD §4.4`. Failed quote ⇒ **drop the whole Q&A item**. (`REQ §6.4`) | T-208, T-115 | TODO |
| T-210 | **Timeline generation** — schema `TD §4.5`, including the `sort_key` / `display_date` split and cross-source `conflicts`. (`REQ §6.5`, `FR-TL-11/12`) | T-115 | TODO |
| T-211 | **Grounded Q&A chat** — SSE streaming, citations emitted **after** the text once validated, explicit "the sources do not address this". (`REQ FR-QA-1..6`, `TD §2.6`) | T-207, T-113 | TODO |
| T-212 | **Multi-source scoping** — `source_ids` selection on generation; cross-source merge semantics for Timeline and Mind Map. (`REQ FR-NB-5`) | T-209, T-210 | TODO |
| T-213 🔧 | **FAQ, Timeline, and chat renderers** — accordion FAQ, vertical timeline with uncertainty markers, chat with citation chips. | T-209, T-210, T-211 | TODO |
| T-214 🔧 | **PDF and DOCX export** — library-based (`python-docx` for DOCX, ReportLab or WeasyPrint for PDF) per `TD §10 D6`; avoids a headless browser in the deployment. (`REQ FR-EXP-2/3`) | T-128 | TODO |
| T-215 | **Notebook search** (`REQ FR-NB-6`) | T-206 | TODO |
| T-216 | **Golden corpus to 40 documents** — full `TD §8.1` composition including the 8-document adversarial subset; extend eval coverage to all four text artifacts. | T-131 | TODO |
| T-217 | **Decide D7** — measure the share of notebooks over 200K tokens; build hierarchical summarization only if the data justifies it (`TD §6.3`, `§10 D7`). | T-132 | TODO |

**Phase 2 exit:** all P0 requirements met; citation resolution > 95% on the full golden corpus.

---

## Phase 3 — Visual and Audio

| ID | Task | Depends on | Status |
|---|---|---|---|
| T-301 | **TTS vendor bake-off** — 3 vendors, blind A/B on two-host naturalness, cost entered into `TD §7.1`. Resolves **D1/Q1/Q9**. Do this **before** T-303. | T-216 | TODO |
| T-302 | **Mind Map generation** — schema `TD §4.6` plus post-parse validation (acyclic, depth ≤ 4, ≤ 7 children). (`REQ §6.6`) | T-115 | TODO |
| T-303 🔧 | **Mind Map interactive renderer** — node-link, expand/collapse, pan/zoom, click-for-citations, PNG/SVG export. **Plus the equivalent text outline for screen readers** (`REQ NFR-UX-3`). | T-302 | TODO |
| T-304 | **Audio stage 1 — content planning** — themes and segment arc (`TD §4.7` `segments`). | T-115 | TODO |
| T-305 | **Audio stage 2 — script generation** — two-host dialogue per the `REQ §6.1` host design and quality bar. Turn-level citations for validation only, never spoken. | T-304 | TODO |
| T-306 | **Audio stage 3 — script validation** — grounding check (whole-artifact failure on any unresolvable turn, `TD §5.3`), length estimate, tone check. **Runs before any TTS spend.** | T-305, T-113 | TODO |
| T-307 | **Audio stage 4 — per-turn parallel TTS** — parallel synthesis is required to hit NFR-PERF-4's 5-minute p95 and makes segment-granular cancellation tractable (`TD §10 D4`). | T-301, T-306 | TODO |
| T-308 | **Audio stage 5 — assembly** — concatenate with natural pause spacing, level normalization, MP3 encode, store. | T-307 | TODO |
| T-309 | **Audio worker pool** — **separate pool from text generation**; a 12-minute overview must not starve study guides (`TD §1`). | T-308, T-008 | TODO |
| T-310 🔧 | **Audio player + transcript** — play/pause, seek, 0.75×–2× speed, transcript alongside, MP3 download. (`REQ FR-AUD-4/5/8`) | T-309 | TODO |
| T-311 | **Audio length presets and customization** — Short/Default/Long, focus topics, audience level, tone. (`REQ FR-AUD-6/7`) | T-305 | TODO |
| T-312 | **Audio eval** — blind A/B naturalness rating in the release gate (`TD §8.2`). | T-310 | TODO |

**Phase 3 exit:** audio overviews rated useful by > 70% of users who generate one.

---

## Phase 4 — Refinement

| ID | Task | Depends on | Status |
|---|---|---|---|
| T-401 | **Artifact version history** — lineage via `parent_artifact_id`, prior versions retained and viewable. (`REQ FR-GEN-6`) | T-116 | TODO |
| T-402 | **Prompt version migration UX** — "a newer version is available" affordance; never auto-regenerate. (`REQ §10.4`) | T-401 | TODO |
| T-403 | **Difficulty and length controls** across artifact types. (`REQ FR-SG-6`, `FR-BRF-6`) | T-115 | TODO |
| T-404 | **Accessibility audit + WCAG 2.1 AA remediation** — full keyboard nav, screen-reader passes, mind-map text equivalent. (`REQ NFR-UX-1..3`) | T-303, T-310 | TODO |
| T-405 | **Performance optimization** — hit every `REQ §7.1` p95 target under realistic concurrency. | T-132 | TODO |
| T-406 | **Cost optimization pass** — evaluate the `TD §7.7` levers. The live question is a **wholesale switch to `claude-sonnet-5`** (~40%/notebook); per-artifact mixing is already rejected as cache-fragmenting (`TD §6.1.1`). Test Study Guide and Briefing first — they gate the answer (`TD §6.1.2`). **Model downgrades require eval evidence first**; do not ship a cheaper model and learn about the regression from user reports. | T-216, T-132 | TODO |
| T-407 | **Cache TTL decision (D2)** — measure real inter-generation gaps; choose extended TTL vs the "generate all" batching affordance (`TD §6.4`). | T-132 | TODO |
| T-408 | **Load and failure testing** — provider outage, queue backpressure, worker death mid-job, partial source failure. | T-405 | TODO |

---

## Cross-Cutting Rules

These apply to every task, not to any one of them.

| # | Rule |
|---|---|
| X1 | **No fabricated grounding.** Any code path producing user-visible factual content routes through the T-113/T-114 validators. No exceptions for "internal" artifacts. |
| X2 | **Model IDs come from config.** Never a string literal in application code. Never append date suffixes. |
| X3 | **Every money-spending endpoint is idempotent.** If it calls a paid API, it needs a dedup story before it merges. |
| X4 | **Every long operation is a job.** No synchronous request holds a connection open for an LLM call. |
| X5 | **Every artifact records provenance** — sources, model, prompt template version, schema version, trace ID. |
| X6 | **Silent truncation is a bug.** If output was capped, sampled, or dropped, the user is told. |
| X7 | **User content is never used for training.** Enforce via provider API settings; assert it in tests where testable. |
| X8 | **Stream LLM calls.** Artifact outputs run to thousands of tokens; non-streaming at high `max_tokens` risks timeouts. |

---

## Critical Path

The shortest sequence to a demoable product:

```
T-001 → T-002 → T-004 → T-008 → T-010 → T-104 → T-107 → T-110
      → T-111 → T-113 → T-114 → T-115 → T-116 → T-124 → T-126
```

**T-114 (degradation policy) is the highest-risk task on this path.** It is the component that decides what a user sees when the model gets something wrong, and every other correctness guarantee in the product routes through it. Build it before the renderers, not after — retrofitting degraded-state rendering into a UI built to assume complete artifacts is a rewrite.

---

## Open Items Discovered During Implementation

Append here rather than guessing. Each entry: what is ambiguous, which task it blocks, and what you assumed to keep moving.

| # | Item | Blocks | Assumption made | Status |
|---|---|---|---|---|
| 1 | **Deployment scope: local, single-user.** Owner decision 2026-09-08. No hosted environment; `docker compose` is the only target. G8 and `NFR-SEC-1/2/7` deferred; T-006 reduced from an auth system to a seeded dev user; T-120 loses its auth screens; T-133 enforcement disabled. | — | `user_id` and query-layer scoping are **retained**, so restoring multi-user is a resolver swap rather than a schema migration. Quota *numbers* were deliberately left alone — the `TD §7.5` vs `NFR-COST-2` contradiction stays live for T-134. | RESOLVED — recorded in `REQ §2.4` |

---

## Summary

| Phase | Tasks | Focus |
|---|---|---|
| 0 — Foundations | 10 | Infrastructure, schemas, job harness, observability |
| 1 — Core loop | 35 | PDF → Study Guide + Briefing, validation, client, eval |
| 2 — Full text | 17 | All formats, FAQ, Timeline, chat, embeddings |
| 3 — Multi-modal | 12 | Mind Map, Audio pipeline |
| 4 — Refinement | 8 | Versioning, a11y, performance, cost |
| **Total** | **62** | |

Three tasks are decisions rather than code and should be scheduled deliberately: **T-134** (free-tier economics — product call), **T-301** (TTS vendor — blocks all of Phase 3), and **T-217** (whether hierarchical summarization is needed at all).

Two tasks carry outsized architectural risk for their size: **T-005** (the schema pipeline — the only thing keeping the LLM contract, the backend validator, and the renderer in agreement across the Python/TypeScript boundary) and **T-008** (job state owned by Postgres, not Celery). Both are cheap now and expensive to retrofit.
