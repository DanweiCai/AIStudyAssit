# AI Study Assistant — Technical Design

**Project:** AIStudyAssit
**Version:** 0.1
**Date:** 2026-08-24
**Owner:** cai.da@northeastern.edu
**Status:** Draft for review
**Companion document:** [`REQUIREMENTS.md`](./REQUIREMENTS.md) — product requirements, personas, artifact specs, release plan

> **Scope of this document.** The wire-level and implementation contracts that `REQUIREMENTS.md` deliberately omits: API endpoints, job lifecycle, artifact output schemas, grounding validation, cost arithmetic, and the evaluation harness. Requirement IDs referenced here (`FR-*`, `NFR-*`) are defined in the companion document. This document changes on a faster cadence than the requirements.

---

## Table of Contents

1. [Service Boundaries](#1-service-boundaries)
2. [API Contract](#2-api-contract)
3. [Job Lifecycle](#3-job-lifecycle)
4. [Artifact Content Schemas](#4-artifact-content-schemas)
5. [Grounding and Validation](#5-grounding-and-validation)
6. [Model Strategy](#6-model-strategy)
7. [Cost Model](#7-cost-model)
8. [Evaluation Harness](#8-evaluation-harness)
9. [Observability](#9-observability)
10. [Open Technical Decisions](#10-open-technical-decisions)

---

## 1. Service Boundaries

Four deployable units. The split is drawn along scaling and failure-isolation lines, not along domain nouns.

| Service | Responsibility | Scales with | Failure blast radius |
|---|---|---|---|
| **API** | AuthN/Z, CRUD, job submission, SSE fan-out | Concurrent users | Total outage |
| **Ingest worker** | Parse → normalize → chunk → locate → (Phase 2) embed | Upload volume | New sources stall; existing notebooks unaffected |
| **Generation worker** | Retrieve → prompt → LLM → validate → persist | Generation volume | New artifacts stall; reading unaffected |
| **Audio worker** | Script → TTS fan-out → assemble → store | Audio volume (bursty, slow) | Audio only |

Audio is a separate worker pool specifically because a 12-minute overview occupies a worker for minutes while a study guide takes seconds. Sharing a pool means audio jobs starve text jobs during load.

### Storage

| Store | Contents | Notes |
|---|---|---|
| Postgres | Notebooks, sources, chunks, artifacts, jobs, chat | `Artifact.content` is JSONB validated against §4 schemas |
| Object storage | Uploaded originals, generated MP3s, export renders | Originals retained for re-processing after parser fixes |
| Vector store | Chunk embeddings | **Phase 2 only** — see FR-PROC-4 note in requirements |
| Cache (Redis) | Sessions, job status, SSE fan-out, rate-limit counters | Job status also in Postgres; cache is the read path |

---

## 2. API Contract

Base path `/v1`. JSON unless noted. Auth via `Authorization: Bearer <token>` on every route.

### 2.1 Conventions

| Aspect | Decision |
|---|---|
| IDs | Prefixed ULIDs — `nb_01H…`, `src_01H…`, `art_01H…`, `job_01H…`. Sortable, unambiguous in logs |
| Errors | `{"error": {"code": "source_too_large", "message": "...", "details": {...}}}` — machine-readable `code`, human `message` |
| Pagination | Cursor-based: `?limit=50&cursor=<opaque>` → `{"data": [...], "next_cursor": "..." \| null}` |
| Timestamps | RFC 3339 UTC |
| Long operations | Never block. Return `202` + a job resource. Progress via SSE |
| Idempotency | `Idempotency-Key` header on all POSTs that cost money |

### 2.2 Notebooks

```
POST   /v1/notebooks                 → 201 Notebook
GET    /v1/notebooks                 → 200 {data: [NotebookSummary], next_cursor}
GET    /v1/notebooks/{nb_id}         → 200 Notebook (includes sources[], artifacts[])
PATCH  /v1/notebooks/{nb_id}         → 200 Notebook          (title, description, settings)
DELETE /v1/notebooks/{nb_id}         → 204                    (soft delete; NFR-SEC-4)
```

### 2.3 Sources

Three creation shapes on one endpoint, discriminated by content type.

```
POST /v1/notebooks/{nb_id}/sources
  Content-Type: multipart/form-data        → file upload
  Content-Type: application/json           → {"type": "url", "url": "https://..."}
                                           → {"type": "pasted_text", "title": "...", "text": "..."}
  → 202 {source: Source, job: Job}

GET    /v1/notebooks/{nb_id}/sources       → 200 {data: [Source]}
GET    /v1/sources/{src_id}                → 200 Source
PATCH  /v1/sources/{src_id}                → 200 Source        (rename only)
DELETE /v1/sources/{src_id}                → 204
GET    /v1/sources/{src_id}/chunks?locator=p14
                                           → 200 {data: [Chunk]}
```

`GET /chunks` backs the citation-jump interaction (FR-QA-3): the client resolves a citation to its chunk and highlights the locator range.

**Source object**

```json
{
  "id": "src_01H...",
  "notebook_id": "nb_01H...",
  "title": "Lecture 4 — Meiosis.pdf",
  "type": "pdf",
  "status": "ready",
  "error": null,
  "token_count": 19840,
  "page_count": 31,
  "content_hash": "sha256:...",
  "created_at": "2026-08-24T10:00:00Z"
}
```

**Upload errors** — `code` values the client must handle distinctly, per FR-ING-9:

| `code` | HTTP | Meaning |
|---|---|---|
| `unsupported_type` | 415 | Extension or sniffed MIME not in the supported set |
| `file_too_large` | 413 | Exceeds 50 MB (FR-ING-10) |
| `notebook_token_limit` | 409 | Would exceed the 500K-token notebook cap — the binding constraint |
| `source_limit` | 409 | 50 sources already present |
| `extraction_failed` | 422 | Parsed but yielded no usable text (likely a scanned PDF — offer OCR in P2) |
| `requires_javascript` | 422 | URL returned a shell page; v1 does not run a headless browser (FR-ING-5) |
| `paywalled` | 422 | Login or paywall interstitial detected (FR-ING-5a) |
| `url_not_allowed` | 400 | Non-public address — SSRF guard (NFR-SEC-6) |
| `duplicate_source` | 409 | `content_hash` already present in this notebook (FR-PROC-7) |

### 2.4 Artifacts

```
POST /v1/notebooks/{nb_id}/artifacts
  Idempotency-Key: <client-generated>
  {
    "type": "study_guide",
    "source_ids": ["src_01H...", "src_01H..."],   // omit ⇒ all ready sources
    "params": {
      "difficulty": "intermediate",                // study_guide
      "length": "standard",                        // briefing | audio_overview
      "customization": "focus on chapters 3-5"     // optional free text
    }
  }
  → 202 {artifact: Artifact(status=queued), job: Job}
  → 200 {artifact, job}    // idempotent replay: existing in-flight job returned

GET    /v1/notebooks/{nb_id}/artifacts     → 200 {data: [ArtifactSummary]}
GET    /v1/artifacts/{art_id}              → 200 Artifact (content populated when ready)
DELETE /v1/artifacts/{art_id}              → 204

POST   /v1/artifacts/{art_id}/regenerate   → 202 {artifact, job}
       { "params": {...} }                  // new Artifact, parent_artifact_id set

POST   /v1/artifacts/{art_id}/report       → 204     (NFR-ACC-5 / NFR-OBS-3)
       { "claim_path": "sections[2].key_points[0]", "reason": "not_in_source", "note": "..." }
```

**Idempotency semantics (FR-GEN-9).** Two layers, because clients misbehave in two different ways:

1. **`Idempotency-Key` header** — replay of the identical request within 24h returns the original response. Catches network retries.
2. **Server-side in-flight dedup** — a request whose `(notebook_id, type, sorted(source_ids), canonical(params))` fingerprint matches a job in `queued` or `running` returns that job with `200` instead of creating a second one. Catches double-clicks and multi-tab, where the client generates a fresh key each time.

Without layer 2 a double-click bills twice. Without layer 1 a network retry does. Both are needed.

### 2.5 Jobs

```
GET    /v1/jobs/{job_id}          → 200 Job
DELETE /v1/jobs/{job_id}          → 202 Job(status=cancelling)
GET    /v1/jobs/{job_id}/events   → 200 text/event-stream
```

**Job object**

```json
{
  "id": "job_01H...",
  "type": "generate_artifact",
  "status": "running",
  "stage": "validating_citations",
  "progress": 0.75,
  "artifact_id": "art_01H...",
  "trace_id": "trc_01H...",
  "attempt": 1,
  "error": null,
  "created_at": "...",
  "started_at": "...",
  "completed_at": null
}
```

**SSE event stream**

```
event: progress
data: {"stage": "calling_model", "progress": 0.4}

event: progress
data: {"stage": "validating_citations", "progress": 0.75}

event: completed
data: {"artifact_id": "art_01H...", "status": "ready", "warnings": ["2 claims dropped: unresolvable citation"]}
```

Reconnect with `Last-Event-ID`; the server replays from the cached job event log. **The stream is a convenience, not the source of truth** — `GET /v1/jobs/{id}` is authoritative, and a client that misses the stream entirely still converges by polling. Building it the other way around produces a system that loses jobs whenever a laptop lid closes.

### 2.6 Chat

```
POST /v1/notebooks/{nb_id}/chat        → 200 text/event-stream
     { "message": "How does meiosis differ from mitosis?" }

GET  /v1/notebooks/{nb_id}/chat/messages  → 200 {data: [ChatMessage]}
```

Streams `token` events, then a terminal `citations` event carrying resolved chunk references. Citations arrive **after** the text because they are validated against the chunk store once the answer is complete — streaming unvalidated citations would show the user references that later vanish.

### 2.7 Export

```
GET /v1/artifacts/{art_id}/export?format=md|pdf|docx   → 200 (binary)
GET /v1/artifacts/{art_id}/export?format=png|svg       → 200 (mind_map only)
GET /v1/artifacts/{art_id}/audio                       → 200 audio/mpeg (Range supported)
```

`md` renders synchronously. `pdf`/`docx`/`png`/`svg` render synchronously if cached, otherwise return `202` + a job.

---

## 3. Job Lifecycle

### 3.1 State machine

```
                 ┌──────────┐
                 │  queued  │
                 └────┬─────┘
                      │ worker claims
                 ┌────▼─────┐
      ┌──────────┤ running  ├──────────┐
      │          └────┬─────┘          │
      │ DELETE        │                │ transient error
      │          ┌────▼──────┐         │  & attempt < 3
 ┌────▼──────┐   │ succeeded │    ┌────▼─────┐
 │cancelling │   └───────────┘    │ retrying │
 └────┬──────┘                    └────┬─────┘
      │                                │ backoff 2^n
 ┌────▼──────┐                         └──▶ queued
 │ cancelled │
 └───────────┘                    ┌────────┐
                                  │ failed │ ◀── terminal error
                                  └────────┘     or attempt == 3
```

**Terminal states:** `succeeded`, `failed`, `cancelled`.

### 3.2 Semantics that the requirements left open

| Question | Decision | Rationale |
|---|---|---|
| User closes the tab mid-generation | Job **continues**. It is server-side and already billed | Killing it wastes the spend and the user usually comes back for the result |
| What does cancel do mid-LLM-call? | Abort the HTTP request to the provider, mark `cancelled`. Tokens already generated are still billed by the provider | Honest: we cannot un-spend them |
| What does cancel do mid-TTS? | Finish the in-flight segment, skip remaining segments, discard partial audio | Segment granularity is ~10s of audio; finer control is not worth the complexity |
| Is quota refunded on cancel? | **Yes** — quota is charged on `succeeded` only (NFR-COST-2) | Charging for cancelled work makes users afraid to cancel, which costs *more* |
| Is quota refunded on `failed`? | Yes, same rule | Our bug, not their quota |
| Duplicate submit | Deduped — §2.4 | |
| Worker dies mid-job | Lease expires after 10 min; job returns to `queued`, `attempt` increments | At-least-once delivery; generation is idempotent because output is written once at the end |
| Retry on model refusal / content policy | **No retry** — terminal `failed` with a distinct code | Retrying a refusal burns money to get the same refusal |

### 3.3 Retryable vs terminal errors

| Class | Examples | Action |
|---|---|---|
| Transient | 429, 5xx, connection reset, timeout | Retry, exponential backoff, max 3 attempts (NFR-REL-3) |
| Validation | Citation resolution below threshold, schema violation | Retry with a corrective prompt appended, max 2 attempts |
| Terminal | Model refusal, quota exceeded, source deleted mid-job, malformed params | Fail immediately with a specific error code |

Distinguishing these matters: a broad `catch` that retries everything turns one refusal into three billed refusals.

---

## 4. Artifact Content Schemas

These are the contract in three places at once — the LLM structured-output schema, the `Artifact.content` JSONB shape, and the renderer's input type. Generate the TypeScript types and the Postgres validation from a single source.

`Artifact.content_schema_version` records which version produced a stored artifact so renderers can handle old rows.

### 4.1 Shared types

```json
{
  "Citation": {
    "type": "object",
    "required": ["source_id", "chunk_id", "locator"],
    "additionalProperties": false,
    "properties": {
      "source_id": { "type": "string" },
      "chunk_id":  { "type": "string" },
      "locator":   { "type": "string", "description": "Human-readable: 'p. 14', 'slide 7', '§3.2'" }
    }
  },

  "Claim": {
    "type": "object",
    "required": ["text", "citations"],
    "additionalProperties": false,
    "properties": {
      "text":      { "type": "string" },
      "citations": { "type": "array", "items": { "$ref": "#/Citation" }, "minItems": 1 },
      "uncited":   { "type": "boolean", "default": false,
                     "description": "Set by the validator when citations failed to resolve and the claim was retained in degraded form. The model must never set this." }
    }
  }
}
```

`minItems: 1` on citations is the schema-level half of grounding (§5). The model cannot emit a claim without attempting a citation; whether that citation is *real* is settled in validation.

### 4.2 Study Guide

```json
{
  "type": "object",
  "required": ["overview", "topics", "short_answer_questions", "essay_questions", "glossary"],
  "additionalProperties": false,
  "properties": {
    "overview": { "type": "string", "description": "2-3 sentence scope statement" },

    "topics": {
      "type": "array", "minItems": 3, "maxItems": 12,
      "items": {
        "type": "object",
        "required": ["title", "summary", "key_points"],
        "additionalProperties": false,
        "properties": {
          "title":      { "type": "string" },
          "summary":    { "type": "string" },
          "key_points": { "type": "array", "items": { "$ref": "#/Claim" }, "minItems": 1 },
          "subtopics":  { "type": "array", "items": { "$ref": "#/StudyGuideTopic" }, "maxItems": 6 }
        }
      }
    },

    "short_answer_questions": {
      "type": "array", "minItems": 10, "maxItems": 20,
      "items": {
        "type": "object",
        "required": ["question", "model_answer"],
        "additionalProperties": false,
        "properties": {
          "question":     { "type": "string" },
          "model_answer": { "$ref": "#/Claim" },
          "difficulty":   { "enum": ["introductory", "intermediate", "advanced"] }
        }
      }
    },

    "essay_questions": {
      "type": "array", "minItems": 4, "maxItems": 8,
      "items": {
        "type": "object",
        "required": ["prompt", "guidance"],
        "additionalProperties": false,
        "properties": {
          "prompt":        { "type": "string" },
          "guidance":      { "type": "string", "description": "What a strong answer addresses" },
          "topics_tested": { "type": "array", "items": { "type": "string" } }
        }
      }
    },

    "glossary": {
      "type": "array", "minItems": 5,
      "items": {
        "type": "object",
        "required": ["term", "definition"],
        "additionalProperties": false,
        "properties": {
          "term":       { "type": "string" },
          "definition": { "$ref": "#/Claim" }
        }
      }
    }
  }
}
```

Topic nesting is recursive but capped at depth 3 by the prompt — JSON Schema cannot express a depth limit, so the validator enforces it after parsing.

### 4.3 Briefing Document

```json
{
  "type": "object",
  "required": ["executive_summary", "themes", "key_facts", "actionable_points", "sources_covered"],
  "additionalProperties": false,
  "properties": {
    "executive_summary": { "type": "string", "description": "3-5 sentences; the single core thesis" },

    "themes": {
      "type": "array", "minItems": 3, "maxItems": 7,
      "items": {
        "type": "object",
        "required": ["title", "explanation", "evidence", "significance"],
        "additionalProperties": false,
        "properties": {
          "title":        { "type": "string" },
          "explanation":  { "type": "string" },
          "evidence":     { "type": "array", "items": { "$ref": "#/Claim" }, "minItems": 1 },
          "significance": { "type": "string" }
        }
      }
    },

    "key_facts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["fact", "citations"],
        "additionalProperties": false,
        "properties": {
          "fact":       { "type": "string", "description": "Verbatim figure or data point" },
          "context":    { "type": "string" },
          "citations":  { "type": "array", "items": { "$ref": "#/Citation" }, "minItems": 1 }
        }
      }
    },

    "actionable_points": {
      "type": "array",
      "items": { "$ref": "#/Claim" }
    },

    "cross_source_analysis": {
      "type": "object",
      "description": "P1 — omitted when only one source is in scope",
      "additionalProperties": false,
      "properties": {
        "agreements": { "type": "array", "items": { "$ref": "#/Claim" } },
        "tensions":   { "type": "array", "items": {
                          "type": "object",
                          "required": ["description", "positions"],
                          "properties": {
                            "description": { "type": "string" },
                            "positions": { "type": "array", "items": { "$ref": "#/Claim" }, "minItems": 2 }
                          }
                        } },
        "gaps":       { "type": "array", "items": { "type": "string" } }
      }
    },

    "sources_covered": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["source_id", "coverage_note"],
        "properties": {
          "source_id":     { "type": "string" },
          "coverage_note": { "type": "string" }
        }
      }
    }
  }
}
```

### 4.4 FAQ Sheet

```json
{
  "type": "object",
  "required": ["groups"],
  "additionalProperties": false,
  "properties": {
    "groups": {
      "type": "array", "minItems": 2,
      "items": {
        "type": "object",
        "required": ["theme", "items"],
        "additionalProperties": false,
        "properties": {
          "theme": { "type": "string" },
          "items": {
            "type": "array", "minItems": 1,
            "items": {
              "type": "object",
              "required": ["question", "answer", "supporting_quotes"],
              "additionalProperties": false,
              "properties": {
                "question": { "type": "string" },
                "answer":   { "type": "string", "description": "2-4 sentences" },
                "supporting_quotes": {
                  "type": "array", "minItems": 1,
                  "items": {
                    "type": "object",
                    "required": ["quote", "citation"],
                    "additionalProperties": false,
                    "properties": {
                      "quote":    { "type": "string", "description": "EXACT text from the source. Subject to verbatim validation (§5.4)" },
                      "citation": { "$ref": "#/Citation" }
                    }
                  }
                },
                "importance": { "enum": ["high", "medium", "low"] }
              }
            }
          }
        }
      }
    },
    "unanswered_questions": {
      "type": "array",
      "description": "P2 — questions the sources raise but do not resolve",
      "items": { "type": "string" }
    }
  }
}
```

The FAQ is the only artifact where a validation failure **removes the item** rather than degrading it. A FAQ answer without a verified quote is just a worse briefing document — the quote is the entire value proposition.

### 4.5 Timeline Guide

```json
{
  "type": "object",
  "required": ["scope_note", "entries", "cast"],
  "additionalProperties": false,
  "properties": {
    "scope_note": {
      "type": "object",
      "required": ["period_covered", "granularity"],
      "properties": {
        "period_covered": { "type": "string" },
        "granularity":    { "enum": ["year", "month", "day", "phase", "ordinal"] },
        "known_gaps":     { "type": "array", "items": { "type": "string" } }
      }
    },

    "eras": {
      "type": "array",
      "description": "Optional grouping; entries reference era_id",
      "items": {
        "type": "object",
        "required": ["id", "label"],
        "properties": {
          "id":    { "type": "string" },
          "label": { "type": "string" },
          "range": { "type": "string" }
        }
      }
    },

    "entries": {
      "type": "array", "minItems": 3,
      "items": {
        "type": "object",
        "required": ["sort_key", "display_date", "title", "description", "citations", "date_precision"],
        "additionalProperties": false,
        "properties": {
          "sort_key":       { "type": "string", "description": "ISO-8601 or zero-padded ordinal. Sorts lexicographically; never displayed" },
          "display_date":   { "type": "string", "description": "As the source expresses it: 'early 1900s', 'Q3 2024', 'Phase 2'" },
          "date_precision": { "enum": ["exact", "approximate", "relative", "ordinal_only"] },
          "title":          { "type": "string" },
          "description":    { "type": "string" },
          "era_id":         { "type": ["string", "null"] },
          "actors":         { "type": "array", "items": { "type": "string" } },
          "citations":      { "type": "array", "items": { "$ref": "#/Citation" }, "minItems": 1 }
        }
      }
    },

    "cast": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "role", "citations"],
        "properties": {
          "name":             { "type": "string" },
          "role":             { "type": "string" },
          "first_appearance": { "type": "string" },
          "citations":        { "type": "array", "items": { "$ref": "#/Citation" }, "minItems": 1 }
        }
      }
    },

    "conflicts": {
      "type": "array",
      "description": "FR-TL-12 — cross-source date disagreements, surfaced not resolved",
      "items": {
        "type": "object",
        "required": ["event_description", "competing_claims"],
        "properties": {
          "event_description": { "type": "string" },
          "competing_claims": {
            "type": "array", "minItems": 2,
            "items": {
              "type": "object",
              "required": ["claimed_date", "citation"],
              "properties": {
                "claimed_date": { "type": "string" },
                "citation":     { "$ref": "#/Citation" }
              }
            }
          }
        }
      }
    }
  }
}
```

**Why `sort_key` is separate from `display_date`.** "Early 1900s" cannot be sorted; `1900-01-01` cannot be displayed without asserting a precision the source never gave. Splitting them lets ordering be correct and display be honest — the alternative is either a broken sort or a fabricated date, and both have shipped in products that conflated these fields.

### 4.6 Mind Map

```json
{
  "type": "object",
  "required": ["central_topic", "nodes"],
  "additionalProperties": false,
  "properties": {
    "central_topic": { "type": "string", "maxLength": 60 },
    "nodes": {
      "type": "array", "minItems": 3, "maxItems": 60,
      "items": {
        "type": "object",
        "required": ["id", "label", "parent_id", "summary", "citations"],
        "additionalProperties": false,
        "properties": {
          "id":        { "type": "string" },
          "label":     { "type": "string", "maxLength": 40, "description": "≤ 6 words" },
          "parent_id": { "type": ["string", "null"], "description": "null ⇒ top-level branch" },
          "summary":   { "type": "string", "description": "1-2 sentences" },
          "depth":     { "type": "integer", "minimum": 1, "maximum": 4 },
          "citations": { "type": "array", "items": { "$ref": "#/Citation" }, "minItems": 1 }
        }
      }
    },
    "cross_links": {
      "type": "array",
      "description": "P2 — non-hierarchical relationships",
      "items": {
        "type": "object",
        "required": ["from", "to", "relationship"],
        "properties": {
          "from":         { "type": "string" },
          "to":           { "type": "string" },
          "relationship": { "type": "string", "maxLength": 40 }
        }
      }
    }
  }
}
```

Post-parse validation the schema cannot express: `parent_id` references an existing node, the graph is acyclic, depth ≤ 4 (FR-MM-5), and no node has more than 7 children.

### 4.7 Audio Overview

```json
{
  "type": "object",
  "required": ["title", "segments", "turns", "estimated_duration_seconds"],
  "additionalProperties": false,
  "properties": {
    "title": { "type": "string" },
    "segments": {
      "type": "array",
      "description": "Structural plan from pipeline stage 1",
      "items": {
        "type": "object",
        "required": ["kind", "topic"],
        "properties": {
          "kind":  { "enum": ["cold_open", "roadmap", "body", "synthesis", "close"] },
          "topic": { "type": "string" }
        }
      }
    },
    "turns": {
      "type": "array", "minItems": 20,
      "items": {
        "type": "object",
        "required": ["speaker", "text"],
        "additionalProperties": false,
        "properties": {
          "speaker":    { "enum": ["host_a", "host_b"] },
          "text":       { "type": "string" },
          "segment_index": { "type": "integer" },
          "citations":  { "type": "array", "items": { "$ref": "#/Citation" },
                          "description": "Not rendered to the listener; used for grounding validation and the displayed transcript" }
        }
      }
    },
    "estimated_duration_seconds": { "type": "integer" }
  }
}
```

Citations exist on turns but are **never spoken** — hosts do not say "according to page 14." They exist so the same validator that gates every other artifact can gate this one. Stripping grounding from audio because it is not user-visible would make audio the one artifact where hallucination goes undetected, which is exactly backwards: it is the artifact users consume least critically.

---

## 5. Grounding and Validation

### 5.1 Where each layer sits

| Layer | Mechanism | Catches |
|---|---|---|
| Prompt | Explicit source-only instruction + refusal clause | Most drift |
| Context | Every chunk labeled with `chunk_id` and locator | Makes correct citation *possible* |
| Schema | `minItems: 1` on citation arrays, `strict: true` tools | Uncited claims |
| Validation | Post-generation resolution + verbatim check | Fabricated `chunk_id`s, misquotes |

Only the fourth layer is adversarial. The first three make the model's job easy; the fourth assumes it failed anyway.

### 5.2 Citation resolution

For each `Citation` in the parsed output:

1. `chunk_id` exists → else **unresolvable**
2. That chunk belongs to a `source_id` in this job's scope → else **unresolvable**
3. `locator` matches the chunk's stored locator → else **repairable**: overwrite with the true locator, log a metric. Locator drift is cosmetic; the chunk reference is what matters.

### 5.3 Degradation policy

Resolves NFR-ACC-1's ambiguity. Per-claim, not per-artifact.

| Artifact | Element with unresolvable citation | Action |
|---|---|---|
| Study Guide | `key_point`, `model_answer`, glossary `definition` | **Retain**, set `uncited: true`, render with a subdued "uncited" marker |
| Briefing | `theme.evidence` item | Retain, mark `uncited` |
| Briefing | `key_facts` item | **Drop** — an uncited statistic is worse than no statistic |
| FAQ | any `supporting_quote` fails | **Drop the whole Q&A item** (§4.4) |
| Timeline | `entry` | **Drop the entry** — an uncited event corrupts the chronology |
| Mind Map | `node` | Retain, mark `uncited` — structure survives a weak node |
| Audio | `turn` | **Fail the artifact** if any turn is unresolvable — see below |

**Artifact-level gate.** After per-element handling, compute `resolution_rate = resolved / total`.

```
resolution_rate ≥ 0.95   → ship, surface warnings for any dropped elements
0.80 ≤ rate < 0.95       → retry once with a corrective prompt naming the failures
rate < 0.80              → retry immediately (do not ship a mostly-fabricated artifact)
after 2 retries          → fail the job with `grounding_failed`
```

Audio is stricter — whole-artifact failure on any unresolvable turn — because there is no per-turn degradation a listener can perceive. You cannot render half a sentence of speech in grey.

**The user always learns what happened.** A shipped artifact with drops carries `warnings[]` on the completion event, rendered as "2 items were removed because their sources could not be verified." Silent truncation reads as completeness, which is the failure mode this entire section exists to prevent.

### 5.4 Verbatim quote normalization

NFR-ACC-2's "100% verbatim" is meaningless against raw extracted PDF text. The model reproduces what a human *reads*; the extractor produces what the PDF *encodes*. These differ constantly.

**Normalization, applied identically to both the model's quote and the stored chunk text:**

| # | Step | Fixes |
|---|---|---|
| 1 | Unicode NFKC | Ligatures (`ﬁ`→`fi`, `ﬂ`→`fl`), full-width forms, compatibility chars |
| 2 | Strip soft hyphens (`U+00AD`) and zero-width chars (`U+200B`–`U+200D`, `U+FEFF`) | Invisible PDF artifacts |
| 3 | Dehyphenate line breaks: `/(\w)-\s*\n\s*(\w)/` → `$1$2` | `develop-\nment` → `development` |
| 4 | Fold quotes: `' ' ‚ ‛` → `'`; `" " „ ‟` → `"` | Smart-quote substitution |
| 5 | Fold dashes: `– — ‒ −` → `-` | En/em dash variance |
| 6 | Collapse whitespace runs (incl. `\n`, `\t`, `U+00A0`) → single space | Column and line-wrap noise |
| 7 | Trim | |

Case and punctuation are **preserved** — a quote that changes case is a misquote.

`Chunk.text_normalized` is precomputed at ingest so matching is a substring search, not a per-validation transform.

**Match ladder:**

```
1. Normalized substring match          → PASS
2. Levenshtein ratio ≥ 0.95            → PASS, log `fuzzy_quote_match` metric
3. Otherwise                           → FAIL, drop the FAQ item, log for eval review
```

Step 2 is a deliberate concession: real extractors emit occasional character-level noise that no normalization rule catches. Metric on it — if `fuzzy_quote_match` climbs above ~5% of quotes, the extractor is the problem, not the model. **Open question Q10** tracks whether 0.95 survives contact with real PDFs.

---

## 6. Model Strategy

### 6.1 Routing

| Task | Model | Effort | Rationale |
|---|---|---|---|
| Study Guide, Briefing | `claude-opus-5` | `high` | Synthesis quality *is* the product; weakest automated quality gates (§6.1.2) |
| FAQ | `claude-opus-5` | `high` | Question quality is judgment; quote extraction is gated by §5.4 |
| Timeline, Mind Map | `claude-opus-5` | **`medium`** | Structural extraction, not synthesis. Fully gated by automated checks |
| Audio script | `claude-opus-5` | `xhigh` | Conversational naturalness is the hardest generation task here |
| Q&A chat | `claude-opus-5` | `medium` | Latency-sensitive; retrieval does the heavy lifting |
| Chunk summarization (hierarchical index) | `claude-haiku-4-5` | — | High volume, bounded, mechanical. Does not read the full corpus |
| Title / tag generation | `claude-haiku-4-5` | — | Trivial, latency-sensitive. Does not read the full corpus |

Model IDs live in configuration, never in code (NFR-COST-5). Never append date suffixes to these IDs.

### 6.1.1 Why the cheap-model split is narrower than it looks

The obvious cost move — route the "easier" artifacts to Sonnet 5 — **loses money**. Prompt cache is per-model, and the corpus is the cached prefix shared across all six artifact types (§6.4). Splitting artifacts across two models means writing the 100K-token corpus into cache twice.

Measured on the §7.4 scenario (100K-token notebook, all six artifacts, batched):

| Routing | Corpus cache writes | Total | vs all-Opus |
|---|---|---|---|
| All `claude-opus-5` | 1 | $1.38 | — |
| 3 Opus + 3 Sonnet 5 | 2 | **$1.57** | **+14%** |
| All `claude-sonnet-5` | 1 | $0.83 | −40% |

The second cache write ($0.375) exceeds everything the three downgraded artifacts save. Input dominates because the corpus is 100K tokens while all six outputs together are ~18K.

**This yields two distinct levers, and conflating them is the mistake:**

| Lever | Granularity | Cache impact | Status |
|---|---|---|---|
| **`effort`** | Per artifact | None — same model, same cached prefix | **Applied now** (Timeline/Mind Map → `medium`) |
| **Model tier** | Per notebook, all-or-nothing | Fragments the cache if mixed | Gated on eval (§7.7, T-406) |

Effort is the free lever. Model tier is a 40% saving available only as a wholesale switch, and only if the eval says quality holds.

Haiku 4.5 is separately excluded from corpus-reading tasks by its **200K context window** — it cannot hold a notebook at the 500K cap. Its routing above is limited to tasks that read individual chunks, which is also why it does not fragment the cache.

### 6.1.2 Which artifacts are safe to test cheaper

Downgrade risk is inversely proportional to automated gate strength.

| Artifact | Automated correctness gate | Downgrade risk |
|---|---|---|
| Timeline | Ordering correctness 100% (§8.2) | **Low** — regression is mechanically caught |
| Mind Map | Acyclic, depth ≤ 4, breadth ≤ 7 (§4.6) | **Low** |
| FAQ | Verbatim quote match ≥ 98% (§5.4) | **Low-medium** — quotes gated, question quality is not |
| Briefing | Citation resolution only | **High** — "themes are genuinely distinct" is human-judged |
| Study Guide | Citation resolution only | **High** — "questions test comprehension, not trivia" is human-judged |
| Audio script | Citation resolution only | **Highest** — naturalness is the whole artifact and only blind A/B detects it |

Run the model-tier experiment against the two high-risk artifacts first. If Sonnet 5 holds on Study Guide and Briefing, it holds everywhere; if it fails there, the wholesale switch is dead regardless of how the easy artifacts score.

### 6.2 Request configuration

```
model:         claude-opus-5
thinking:      {type: "adaptive"}          // on by default for Opus 5; do not use budget_tokens
output_config: {effort: "high",
                format: {<artifact schema from §4>}}
max_tokens:    64000                       // streaming
stream:        true
```

Three things worth stating because a stale prior gets each one wrong:

- **`budget_tokens` is removed** on Opus 5 — it returns a 400. Depth is controlled via `output_config.effort`.
- **Structured output is `output_config.format`**, not the deprecated top-level `output_format`.
- **Assistant prefill is removed** on Opus 5 — format control comes from the schema and system prompt, not a primed assistant turn.

Stream every generation call. Artifact outputs run to several thousand tokens and non-streaming requests at high `max_tokens` risk HTTP timeouts.

### 6.3 Context strategy — revised

`REQUIREMENTS.md` §10.3 sets a hierarchical-summarization threshold at 200K tokens. **Opus 5 has a 1M-token context window**, so the entire 500K-token notebook cap fits in a single request.

The revised thresholds are therefore driven by **cost and attention quality, not context limits**:

| Corpus | Strategy | Why |
|---|---|---|
| < 200K tokens | Full text, single request, cached prefix | Fits comfortably; best synthesis quality |
| 200K – 500K | Full text still fits, but per-generation input cost becomes the constraint | Use the hierarchical index for section-scoped generation; fall back to full text for the executive summary pass |
| > 500K | Not reachable — FR-ING-10 caps the notebook | |

This is a meaningful simplification over the requirements-doc framing: hierarchical summarization is a **cost optimization**, not a correctness requirement, and can be deferred if Phase 2 telemetry shows most notebooks land under 200K.

### 6.4 Prompt caching

The source corpus is the cacheable prefix; it is identical across all six artifact types for a given notebook.

**Ordering** (render order is `tools` → `system` → `messages`):

```
system:   [ role definition + grounding rules ]          ← stable, cached
          [ source corpus with chunk_ids ]               ← stable per notebook, cached  ◀ breakpoint
messages: [ artifact-specific spec + user customization ] ← volatile, uncached
```

Putting the artifact spec *after* the cache breakpoint is what makes one cached corpus serve all six artifact types. Reversing that order — spec first — invalidates the cache on every artifact and forfeits the entire saving in §7.

**TTL is the real constraint.** The default cache TTL is short (minutes). A user who generates a study guide, reads it for ten minutes, then generates a briefing will miss the cache entirely.

**Mitigation — "generate all" batching.** When a user requests multiple artifacts, enqueue them as a burst so they execute within one TTL window. Offer a one-click "generate everything" that fans out all six immediately. This is a UX affordance driven by a caching constraint, and it happens to be what users want anyway.

Verify `usage.cache_read_input_tokens` is non-zero in staging. If it is zero across repeated generations, something is silently invalidating the prefix — a timestamp in the system prompt, unsorted `source_ids`, or a varying tool list.

---

## 7. Cost Model

Fills the gap flagged in review: `REQUIREMENTS.md` §7.6 mandated cost controls without any arithmetic to set them against.

### 7.1 Rates

First-party Anthropic API, as of 2026-06-24:

| Model | Input $/1M | Output $/1M | Context |
|---|---|---|---|
| `claude-opus-5` | $5.00 | $25.00 | 1M |
| `claude-sonnet-5` | $3.00 | $15.00 | 1M |
| `claude-haiku-4-5` | $1.00 | $5.00 | 200K |

**Assumptions requiring verification before these figures are used for pricing decisions:**

| Assumption | Modeled value | Verify |
|---|---|---|
| Cache write multiplier | 1.25 × base input | Current pricing page |
| Cache read multiplier | 0.10 × base input | Current pricing page |
| TTS rate | $15 / 1M characters | Vendor selection — **Q1**, unresolved |

### 7.2 Token volumes

| Quantity | Estimate | Derivation |
|---|---|---|
| 30-page PDF | ~20K tokens | ~500 words/page × 30 × 1.33 tok/word |
| Typical notebook (5 sources) | ~100K tokens | |
| Study Guide output | ~5K tokens | Outline + 15 SAQ + 6 essays + glossary ≈ 3,700 words |
| Briefing output | ~2.5K tokens | ~1,900 words |
| FAQ output | ~3.5K tokens | 20 items with quotes |
| Timeline output | ~3K tokens | |
| Mind Map output | ~2K tokens | 40 nodes × ~35 tokens |
| Audio script (12 min) | ~2.5K tokens | 150 wpm × 12 = 1,800 words |
| Audio TTS input | ~11K characters | 1,800 words × ~6 chars |

### 7.3 Per-artifact cost

**Single 20K-token source, cold cache:**

| Line | Tokens | Rate | Cost |
|---|---|---|---|
| Input (source + prompt), cache write | 21.5K | $6.25/1M | $0.134 |
| Output (Study Guide) | 5K | $25.00/1M | $0.125 |
| **Total** | | | **$0.26** |

**Same notebook, second artifact within the cache window:**

| Line | Tokens | Rate | Cost |
|---|---|---|---|
| Input, cache read | 20K | $0.50/1M | $0.010 |
| Input, uncached spec | 1.5K | $5.00/1M | $0.008 |
| Output (Briefing) | 2.5K | $25.00/1M | $0.063 |
| **Total** | | | **$0.08** |

Cache warmth is a **3× cost difference**. This is why §6.4's batching affordance is a cost mechanism, not a nicety.

### 7.4 Full notebook — all six artifacts

100K-token notebook (5 sources), generated as one burst:

| Line | Cost |
|---|---|
| First generation, cache write (100K × $6.25/1M) | $0.625 |
| Five subsequent generations, cache read (5 × 100K × $0.50/1M) | $0.250 |
| Uncached per-request specs (6 × 1.5K × $5/1M) | $0.045 |
| All outputs (18.5K × $25/1M) | $0.463 |
| **LLM subtotal** | **$1.38** |
| TTS (11K chars × $15/1M) | $0.165 |
| **Total** | **≈ $1.55** |

Generated one-at-a-time across a study session, with every cache miss: **≈ $3.60**. The batching decision is worth roughly 2.3× on a fully-populated notebook.

### 7.5 Free tier — the number does not work

Checking `REQUIREMENTS.md` NFR-COST-2's proposed free tier against the above:

| Tier | Composition | Modeled cost/user/month |
|---|---|---|
| As drafted | 30 text artifacts + 3 audio | **$5.55** |
| Recommended | 10 text artifacts + 1 audio | **$1.85** |
| Aggressive | 5 text artifacts, no audio | **$0.75** |

**$5.55/user/month of variable cost on a free tier is not viable** at any plausible conversion rate. This is exactly the number the review said was missing, and it invalidates a figure already written into the requirements.

**Recommendation:** free tier = **10 text artifacts + 1 audio overview per month**. Audio is 20% of the cost of a free user while being the feature most likely to drive conversion — one free sample is the right shape. `REQUIREMENTS.md` NFR-COST-2 should be amended; it currently carries the unviable number, retained deliberately so the discrepancy is visible rather than quietly overwritten.

### 7.6 Derivation of the rate limits

`REQUIREMENTS.md` NFR-SEC-7's limits, justified:

| Limit | Value | Basis |
|---|---|---|
| Generations / hour | 10 | Bounds a runaway client to ~$3.60/hr worst case (all cache-cold) |
| Concurrent jobs | 3 | Matches NFR-PERF-7; bounds worker-pool monopolization by one user |
| Audio / day | 5 | Highest unit cost and slowest worker; the tightest natural bottleneck |
| Uploads / hour | 20 | Ingest cost is parsing CPU, not tokens — limit is abuse control |

### 7.7 Levers not yet applied

| Lever | Saving | Trade-off | Status |
|---|---|---|---|
| Lower `effort` on Timeline / Mind Map | Thinking tokens on 2 of 6 artifacts | Structural extraction likely doesn't need `high`; both are mechanically gated (§6.1.2) | **Applied** — §6.1 |
| Batch API for evals | 50% | 24h turnaround — unusable interactively, ideal for §8 | **Applied** — §8.4 |
| **Wholesale switch to Sonnet 5** | **~40% per notebook** | All-or-nothing; mixing costs *more* (§6.1.1). Requires eval evidence on Study Guide and Briefing | Gated — T-406 |
| Extended cache TTL | Converts cold generations to warm (up to 3×, §7.3) | Higher write multiplier; model against real inter-generation gaps | Gated — D2 |
| Per-artifact model mixing | **Negative** | Fragments the corpus cache; measured at +14% | **Rejected** — §6.1.1 |

**Sonnet 5 intro pricing.** Sonnet 5 is at $2.00/$10.00 per MTok through **2026-08-31**, versus $3.00/$15.00 standard. At intro rates the wholesale switch is ~60% rather than ~40%. Model the business on the standard rate — the intro window is days away from closing and is not a basis for a pricing decision.

Do not apply a model downgrade without eval evidence. Shipping a cheaper model and learning about the quality regression from user reports is the most expensive way to run this experiment, and in an education product the damage lands on students who trusted the output.

---

## 8. Evaluation Harness

The review flagged that this had one table row in the requirements and deserved a section. It is the difference between shipping prompt changes confidently and shipping them hopefully.

### 8.1 Golden corpus

| Property | Target |
|---|---|
| Size | 40 documents |
| Composition | 12 lecture PDFs, 8 slide decks, 6 academic papers, 6 web articles, 4 DOCX, 4 pasted-text |
| Domains | STEM, humanities, social science, professional/certification — at least 8 each |
| Adversarial subset | 8 documents chosen to break things: scanned-then-OCR'd, heavy tables, multi-column, non-chronological narrative, a document with no extractable timeline, two documents that contradict each other |
| Reference outputs | Authored by a human reviewer per artifact type, stored alongside |

The adversarial subset matters more than the size. A corpus of 40 clean lecture PDFs will pass every regression and catch nothing.

### 8.2 Metrics

**Automated, every run — these gate deploys:**

| Metric | Threshold | Fails the build |
|---|---|---|
| Schema validation pass rate | 100% | Yes |
| Citation resolution rate | ≥ 95% | Yes |
| Verbatim quote match rate (post-normalization) | ≥ 98% exact, 100% incl. fuzzy | Yes |
| Fuzzy-match fallback rate | ≤ 5% | Warn |
| Structural constraints (depth, breadth, counts) | 100% | Yes |
| Timeline ordering correctness | 100% | Yes |
| p95 generation latency | ≤ NFR-PERF-2 | Warn |

**Human-rated, per release — these gate the release, not the build:**

| Dimension | Method |
|---|---|
| Faithfulness | Reviewer checks a 20-claim sample per artifact against sources |
| Coverage | Proportion of source sections represented |
| Usefulness | 1–5 rating against the §6 quality bars in the requirements |
| Audio naturalness | Blind A/B against the prior version; **Q9** |

### 8.3 Gating

```
Prompt template change  → full automated suite; block merge on any red gate
Model version change    → full automated suite + human faithfulness sample
Parser change           → ingestion fidelity subset only (fast)
Schema change           → full suite + a migration plan for stored artifacts
```

### 8.4 Cost of a run

40 documents × 6 artifact types ≈ 240 generations. At the §7.3 cold-cache figure of ~$0.26, a full run is **≈ $62**.

Two reductions: cache per document across its six artifact types (§6.4) brings it to **≈ $25**; running evals through the Batch API at 50% brings it to **≈ $12**. Eval runs are not latency-sensitive, so Batch is strictly correct here.

At $12–25 per full run, the suite can gate every prompt merge without a cost conversation. That property is what makes it get used.

---

## 9. Observability

Implements NFR-OBS-1 through 5.

### 9.1 Trace record

Written for every generation job, retained 30 days:

```json
{
  "trace_id": "trc_01H...",
  "job_id": "job_01H...",
  "artifact_id": "art_01H...",
  "user_id": "usr_01H...",
  "artifact_type": "faq",
  "model": "claude-opus-5",
  "prompt_template_version": "faq/v3",
  "content_schema_version": 2,
  "source_ids": ["src_..."],
  "chunk_ids_in_context": ["chk_...", "..."],
  "prompt_hash": "sha256:...",
  "prompt_blob_uri": "s3://traces/...",
  "response_blob_uri": "s3://traces/...",
  "usage": {
    "input_tokens": 21500,
    "cache_read_input_tokens": 20000,
    "cache_creation_input_tokens": 0,
    "output_tokens": 3500
  },
  "validation": {
    "citations_total": 42,
    "citations_resolved": 41,
    "resolution_rate": 0.976,
    "quotes_exact": 19,
    "quotes_fuzzy": 1,
    "quotes_failed": 0,
    "elements_dropped": 0
  },
  "stage_latency_ms": {
    "retrieve": 120, "prompt_assembly": 15,
    "model_call": 18400, "validation": 340, "persist": 55
  },
  "attempt": 1,
  "outcome": "succeeded"
}
```

Storing `prompt_blob_uri` and `response_blob_uri` rather than inline payloads keeps the trace record queryable while the bulky content sits in object storage under the same retention and deletion rules as source material (NFR-OBS-2).

### 9.2 Privacy

Trace blobs contain user coursework verbatim. They inherit source-content handling exactly: same encryption at rest, same per-user access control, same deletion cascade. **A user deletion request must purge trace blobs** — the most likely place for this promise to leak in practice, because traces live in a different bucket than the sources and are easy to forget in the deletion job. Add an explicit test for it.

### 9.3 Dashboards and alerts

| Alert | Condition | Why it matters |
|---|---|---|
| Citation resolution drop | 1h rate < 0.93 | Leading indicator of a prompt or model regression |
| Quote failure spike | `quotes_failed` > 2% | Usually an extractor regression, not a model one |
| Generation failure rate | > 3% over 15 min | Provider issue or a bad deploy |
| p95 latency regression | > 1.5× baseline | |
| Cache hit rate collapse | `cache_read` / total input < 0.5 | A silent prefix invalidator; directly a cost incident (§7.3) |
| Cost per artifact drift | > 1.3× 7-day baseline | Catches prompt bloat before the invoice does |

The cache-hit alert deserves emphasis: a silent prefix invalidator produces no errors, no quality regression, and no user complaints — just a 3× cost increase that surfaces weeks later on a bill.

---

## 10. Open Technical Decisions

| # | Decision | Blocking | Recommendation |
|---|---|---|---|
| D1 | TTS vendor — must support 2 distinct natural voices, SSML prosody control, ≥20 min output | Phase 3 | Bake-off against 3 vendors using the §8.2 blind A/B; cost enters §7.1 |
| D2 | Cache TTL selection and whether extended TTL beats batching | Phase 1 | Measure real inter-generation gaps in Phase 1 before paying the higher write multiplier |
| D3 | Vector store selection | Phase 2 | Defer — FR-PROC-4 is P1; revisit with real notebook-size data |
| D4 | Per-turn vs full-script TTS synthesis | Phase 3 | Per-turn, synthesized in parallel — it is the only way to hit NFR-PERF-4's 5-minute p95, and it makes cancellation tractable (§3.2) |
| D5 | Whether `claude-sonnet-5` is sufficient **for all six artifacts** — the only form the question can take, since mixing costs more than it saves (§6.1.1) | Phase 4 | Test Study Guide and Briefing first; they gate the answer (§6.1.2). ~40% saving if it holds |
| D6 | Export rendering — server-side headless vs a document library | Phase 2 | Library-based (DOCX/PDF) avoids a headless browser in the deployment; revisit if fidelity is poor |
| D7 | Hierarchical summarization — build or defer | Phase 2 | Defer until telemetry shows the share of notebooks over 200K tokens (§6.3) |

---

## Appendix A — Amendments This Document Makes to `REQUIREMENTS.md`

Recorded explicitly rather than silently applied, so the requirements owner can accept or reject each.

| Requirement | Current text | Proposed amendment | Reason |
|---|---|---|---|
| NFR-COST-2 | Free tier: 30 text + 3 audio/month | **10 text + 1 audio/month** | Drafted tier costs $5.55/user/month in variable cost (§7.5) |
| §10.3 context strategy | Hierarchical summarization above 200K tokens | Reframe as a **cost optimization**, not a context requirement | Opus 5's 1M context holds the entire 500K notebook cap (§6.3) |
| NFR-ACC-2 | 100% verbatim | 100% **after normalization**, with a 0.95 fuzzy fallback tier | Exact matching fails on correct quotes due to extraction artifacts (§5.4) |

---

*End of document. Section 7.5 contains a finding that contradicts a number already in the requirements — that is intentional and needs a decision, not a reconciliation.*
