# Walkthrough — One PDF, End to End

**What this document is.** A single worked example traced through all four services, written for someone new to the codebase who wants to see *how the pieces fit* before reading the specs in full.

**What it is not.** Not a spec. Every shape and threshold here is derived from [`REQUIREMENTS.md`](./REQUIREMENTS.md) and [`TECHNICAL_DESIGN.md`](./TECHNICAL_DESIGN.md) and cited back to them. **If this document ever disagrees with those, they win and this is the bug.** Timings and file sizes are illustrative; the normative budget is `NFR-PERF-8` (< 3 min p95, < 90s median).

Scope assumed throughout: local, single-user (`REQUIREMENTS.md` §2.4).

---

## The example

A student uploads `Java-Collections.pdf` — 24 pages of course notes on the Java Collections Framework — and asks for a Study Guide.

## The cast

| Part | Lives in | Job | Rule it obeys |
|---|---|---|---|
| **Next.js** | `apps/web` | What the user sees and clicks | — |
| **FastAPI** | `apps/api` | Answer in milliseconds; never do slow work | X4 — every long operation is a job |
| **Celery** | `apps/worker` | Do the slow work in the background | X8 — stream every LLM call |
| **JSON Schema** | `packages/schemas` | Define what an artifact *is*, for all three of the above | — |

The single most important rule to internalize: **FastAPI is only ever allowed to do things that take milliseconds.** Everything slow — parsing, LLM calls, TTS — belongs to a worker. That one constraint explains most of the architecture.

---

# Act 1 — Ingesting the PDF

## Step 1 · Next.js sends the file

```http
POST /v1/notebooks/nb_01HQ4X.../sources
Content-Type: multipart/form-data
Authorization: Bearer <fixed dev token>      ← §2.4: resolves to the seeded dev user

<raw PDF bytes, 3.2 MB>
```

The `Authorization` header is required on every route even single-user, so the contract is unchanged the day real auth arrives (`TD §2`).

## Step 2 · FastAPI records and hands off — ~80 ms

Only fast work happens here:

1. Resolve the token to a user
2. **Sniff** the real content type — never trust the `.pdf` extension (`NFR-SEC-5`)
3. Check limits: 50 MB/file, 50 sources, 500K tokens per notebook — the token cap is the binding one (`FR-ING-10`)
4. Store the original in object storage (kept, so sources can be re-parsed after a parser fix)
5. Write two Postgres rows:

```
Source        id=src_01HQ5A...  status="queued"   token_count=null
GenerationJob id=job_01HQ5B...  type="ingest_source"  status="queued"  attempt=0
```

6. Enqueue a Celery task carrying `job_01HQ5B...`
7. Reply `202` (`TD §2.3`):

```json
{
  "source": { "id": "src_01HQ5A...", "title": "Java-Collections.pdf",
              "type": "pdf", "status": "queued",
              "token_count": null, "page_count": null },
  "job":    { "id": "job_01HQ5B...", "status": "queued", "progress": 0 }
}
```

Nothing has been read yet. `status: "queued"` and the `null` counts are the honest state.

> **Why the job row lives in Postgres, not Celery** (`TD §3.1`, T-008): Celery's result backend cannot model the 10-minute lease, the `attempt` counter, or the `cancelling` state. If the worker dies, the lease expires and this row returns to `queued` with `attempt` incremented. A job you cannot query after a restart is a job you have lost.

## Step 3 · Celery ingest worker — ~20 s

**3a. Parse** (PyMuPDF, `FR-ING-1` / T-104) — text with page numbers, correct reading order on multi-column layouts:

```
p.7 → "An ArrayList provides O(1) random access because it is backed by
       an array. A LinkedList requires O(n) traversal to reach an
       arbitrary index."
```

**3b. Normalize** (`TD §5.4` / T-106) — the same 7 steps applied here and later to any quote the model returns, so the two can be compared:

| Step | Fixes | Example |
|---|---|---|
| 1 NFKC | ligatures | `ﬁnal` → `final` |
| 2 strip soft hyphens / zero-width | invisible PDF junk | `back­ed` → `backed` |
| 3 dehyphenate line breaks | wrapped words | `develop-\nment` → `development` |
| 4 fold quotes | smart quotes | `"array"` → `"array"` |
| 5 fold dashes | en/em dashes | `O(1) – fast` → `O(1) - fast` |
| 6 collapse whitespace | column noise | `O(1)\n\n  random` → `O(1) random` |
| 7 trim | | |

Case and punctuation are **preserved** — a quote that changes case is a misquote. The result is stored as `Chunk.text_normalized` *at ingest*, so later quote-checking is a substring search rather than a transform run on every validation.

**3c. Chunk** (`FR-PROC-2/3` / T-107) — 800–1200 tokens, ~15% overlap, respecting section boundaries:

```
Chunk  id=chk_01HQ5C...
       source_id=src_01HQ5A...   sequence_index=12
       text="An ArrayList provides O(1) random access because..."
       text_normalized="An ArrayList provides O(1) random access because..."
       locator={ page: 7, char_range: [1420, 2280] }
       token_count=940
```

That `locator` is what later turns a citation into a clickable jump to page 7.

**Output:** ~30 chunk rows, and `Source` updated to `status="ready", page_count=24, token_count=28400`.

## Step 4 · Next.js watches it happen

The browser holds an SSE stream (`TD §2.5`):

```
event: progress
data: {"stage": "parsing", "progress": 0.3}

event: progress
data: {"stage": "chunking", "progress": 0.8}

event: completed
data: {"source_id": "src_01HQ5A...", "status": "ready"}
```

The stream is a **convenience, not the source of truth**. `GET /v1/jobs/{id}` is authoritative, and a client that misses the stream entirely still converges by polling — otherwise closing a laptop lid would lose the job.

**On screen:** `✓ Java-Collections.pdf — 24 pages, ready`

---

# Act 2 — Generating the Study Guide

## Step 5 · Next.js requests it

```http
POST /v1/notebooks/nb_01HQ4X.../artifacts
Idempotency-Key: 9f2c1a...

{ "type": "study_guide", "params": { "difficulty": "intermediate" } }
```

## Step 6 · FastAPI dedupes, records, hands off — ~80 ms

Two independent idempotency layers (`TD §2.4`, X3, T-117), because clients misbehave two different ways:

| Layer | Catches | Mechanism |
|---|---|---|
| `Idempotency-Key` header | network retries | identical key within 24h replays the original response |
| in-flight fingerprint | double-clicks, multiple tabs | `(notebook_id, type, sorted(source_ids), canonical(params))` already `queued`/`running` → return that job with `200` |

Without layer 2, a double-click bills the LLM twice. Without layer 1, a network retry does. Both are required.

Then: write `Artifact(status="queued")`, write `GenerationJob`, enqueue, reply `202`.

## Step 7 · Celery generation worker calls the model — ~90 s

**Prompt assembly, in this exact order** (`TD §6.4`):

```
SYSTEM   role + grounding rules
         "Every factual claim must cite a chunk below.
          Never use knowledge outside these sources."

         [chunk chk_01HQ5C... | p.7] An ArrayList provides O(1)...
         [chunk chk_01HQ5D... | p.8] HashMap offers average O(1)...
         ... all 30 chunks ...
━━━━━━━━ cache breakpoint ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MESSAGES artifact-specific spec
         "Produce an intermediate-difficulty study guide."
```

Ordering is a **cost mechanism**, not a style choice. The corpus sits before the breakpoint so it is written to cache once and re-read by every subsequent artifact in the notebook. Putting the artifact spec before the breakpoint invalidates the cache on every generation and forfeits roughly a 3× cost difference.

> Verify `usage.cache_read_input_tokens` is non-zero on the second generation (T-110). Zero across repeated generations is a cost incident **with no error signal** — usually a timestamp in the system prompt or unsorted `source_ids`.

**The schema goes along as a hard constraint** (`TD §4.2`, passed as `output_config.format`):

```json
{
  "required": ["overview","topics","short_answer_questions",
               "essay_questions","glossary"],
  "topics": { "minItems": 3, "maxItems": 12 },
  "Claim":  { "required": ["text","citations"],
              "citations": { "minItems": 1 } }
}
```

`minItems: 1` on citations is the schema-level half of grounding: the model is **structurally incapable** of returning a key point with zero citations. Not asked politely — the output format forbids it.

**What comes back:**

```json
{
  "overview": "This guide covers the Java Collections Framework, focusing on
               List and Map implementations and their performance tradeoffs.",
  "topics": [{
    "title": "List Implementations",
    "summary": "ArrayList and LinkedList differ in access and insertion cost.",
    "key_points": [{
      "text": "ArrayList gives O(1) random access because it is array-backed.",
      "citations": [{ "source_id": "src_01HQ5A...",
                      "chunk_id":  "chk_01HQ5C...",
                      "locator":   "p. 7" }]
    }]
  }],
  "short_answer_questions": [{
    "question": "When would you choose LinkedList over ArrayList?",
    "model_answer": { "text": "...", "citations": [...] },
    "difficulty": "intermediate"
  }],
  "glossary": [{
    "term": "ArrayList",
    "definition": { "text": "A resizable array implementation of List.",
                    "citations": [...] }
  }]
}
```

## Step 8 · Validation assumes the model lied

Layers 1–3 of grounding (prompt, labeled context, schema) are cooperative. **This layer is adversarial** — it exists because the first three can all be satisfied by a confident fabrication.

**8a. Resolve every citation** (`TD §5.2` / T-113):

```
1. does chunk_id exist?                          → no  = unresolvable
2. does it belong to a source in this job scope? → no  = unresolvable
3. does the locator match the stored locator?    → no  = repairable
                                                          (overwrite, log metric)
```

Locator drift is cosmetic — the chunk reference is what matters.

**8b. Degrade per element** (`TD §5.3` / T-114). The action **differs by artifact and by field**:

| Artifact | Element | Action |
|---|---|---|
| Study Guide | `key_point`, `model_answer`, glossary `definition` | **Retain**, set `uncited: true` |
| Briefing | `key_facts` item | **Drop** — an uncited statistic is worse than none |
| FAQ | item whose `supporting_quote` fails | **Drop the whole Q&A item** |
| Timeline | `entry` | **Drop** — an uncited event corrupts the chronology |
| Mind Map | `node` | Retain, mark `uncited` |
| Audio | `turn` | **Fail the whole artifact** — you cannot render half a sentence of speech in grey |

Say the model emitted a key point citing `chk_01HQ9Z...`, an ID that does not exist. Ours is a Study Guide, so it is retained and flagged:

```json
{ "text": "Java 21 added virtual threads to collections.",
  "citations": [],
  "uncited": true }
```

> `uncited` is set **by the validator only**. The model must never set it (`TD §4.1`).

**8c. Artifact-level gate** — `resolution_rate = resolved / total`:

```
≥ 0.95              → ship, with warnings for anything dropped
0.80 – 0.95         → retry once with a corrective prompt naming the failures
< 0.80              → retry immediately (do not ship a mostly-fabricated artifact)
after 2 retries     → fail the job with `grounding_failed`
```

29 of 30 citations resolved = 0.967 → ships, with a warning.

## Step 9 · Persist with provenance

```
Artifact  id=art_01HQ6D...
          status="ready"
          content={ ...the JSON above... }        ← JSONB, validated against §4.2
          source_ids=[src_01HQ5A...]
          model_version="claude-opus-5"           ← from config, never a literal (X2)
          prompt_template_version="v3"
          content_schema_version="1.2.0"
          trace_id="trc_01HQ6F..."
```

Those last five fields are **provenance** (X5). Six months later they answer "which model and which prompt produced this claim?" — the question you cannot reconstruct after the fact.

## Step 10 · Next.js renders it

The completion event carries the warnings:

```
event: completed
data: {"artifact_id": "art_01HQ6D...", "status": "ready",
       "warnings": ["1 key point could not be verified against your sources"]}
```

Rendered with TypeScript types **generated from the same schema used in Step 7**:

```
📘 Java Collections — Study Guide
   ⚠ 1 key point could not be verified against your sources

   Overview
   This guide covers the Java Collections Framework...

   1. List Implementations
      • ArrayList gives O(1) random access...      [p. 7]   ← click → page 7
      • Java 21 added virtual threads...           (uncited)

   Short Answer Questions
   Q1. When would you choose LinkedList over ArrayList?
       [Show answer]
```

**Silent truncation is a bug** (X6). A degraded artifact that looks complete is the exact failure this whole pipeline exists to prevent.

---

# The whole trip

| # | Part | Does | Time |
|---|---|---|---|
| 1 | Next.js | send the file | instant |
| 2 | FastAPI | validate, record, enqueue | ~80 ms |
| 3 | Celery (ingest) | parse → normalize → chunk | ~20 s |
| 4 | Next.js | show progress via SSE | live |
| 5 | Next.js | request the artifact | instant |
| 6 | FastAPI | dedupe, record, enqueue | ~80 ms |
| 7 | Celery (generation) + schema | prompt → LLM → structured JSON | ~90 s |
| 8 | Celery (generation) | resolve citations, degrade, gate | ~2 s |
| 9 | Celery (generation) | persist with provenance | ~50 ms |
| 10 | Next.js + schema | render, warnings included | instant |

## Where the schema showed up

One file, `packages/schemas/study_guide.json`, was used three times:

| Step | Used as | Consequence if it drifted |
|---|---|---|
| 7 | `output_config.format` — the LLM contract | model returns a shape nothing can read |
| 8–9 | generated Pydantic — backend validation | invalid content reaches the database |
| 10 | generated TypeScript — renderer input | a section renders silently empty |

This is why generated types are committed and CI fails on a stale diff (T-005), and why hand-editing a generated model is forbidden. The three consumers disagreeing is not a loud failure — it is a mysteriously blank section in a student's study guide.

## Cross-cutting rules, seen in the flow

| Rule | Where it appeared |
|---|---|
| X1 no fabricated grounding | Step 8 — every claim through T-113/T-114 |
| X2 model IDs from config | Step 9 — `model_version` from config, never a literal |
| X3 money endpoints idempotent | Step 6 — both layers |
| X4 long operations are jobs | Steps 2 and 6 — API never waits |
| X5 provenance recorded | Step 9 |
| X6 no silent truncation | Steps 8c and 10 — `warnings[]` reaches the screen |
| X8 stream LLM calls | Step 7 |
