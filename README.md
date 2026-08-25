# AIStudyAssit

AI-empowered study assistant for students.

Upload your study materials — PDFs, slide decks, Word docs, web links, or pasted text — and get a complete self-guided learning package generated from them: podcast-style audio overviews, study guides, briefing documents, FAQ sheets, timelines, and mind maps. Everything is grounded in your own sources, with citations back to the exact passage.

---

## Status

**Pre-implementation.** Specs are written; no code yet. Start at [`docs/TASKS.md`](docs/TASKS.md) → T-001.

---

## Documentation

```
docs/
├── REQUIREMENTS.md      what we're building and why      (~1,000 lines)
├── TECHNICAL_DESIGN.md  how it's built                   (~1,100 lines)
└── TASKS.md             what to do, in what order          (~250 lines)
```

They're meant to be read in that order. Each one answers a different question, and they deliberately don't overlap.

---

### 📋 [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) — Product Requirements

**The "what and why."** Everything that defines the product independent of how it's implemented.

- **Goals and non-goals** — including explicit anti-goals (this is not a homework-answering machine)
- **Personas** — undergraduate, graduate researcher, instructor, professional learner
- **Functional requirements** — ~90 numbered, prioritized requirements (`FR-ING-1`, `FR-QA-3`, …) across ingestion, notebooks, processing, generation, chat, and export
- **Artifact specifications** — one section per artifact with its structure, requirements, and quality bar. The audio host design lives here
- **Non-functional requirements** — performance targets, reliability, accuracy, accessibility, security, cost, observability (`NFR-*`)
- **Architecture overview and data model** — component diagrams and entity definitions
- **Release plan** — four phases with exit criteria
- **Risks, open questions, glossary**

*Read it when you need to know what the product does, or what a requirement ID means.* Changes slowly.

---

### 🔧 [`docs/TECHNICAL_DESIGN.md`](docs/TECHNICAL_DESIGN.md) — Technical Design

**The "how."** The wire-level contracts the requirements deliberately leave out.

- **API contract** — every endpoint, request/response shape, and error code
- **Job lifecycle** — the async state machine, plus the semantics requirements left open: what happens when a user closes the tab mid-generation, what cancel does mid-TTS, when quota is refunded
- **Artifact content schemas** — JSON Schema for all six artifacts. These *are* the contract in three places at once: the LLM structured-output format, the database shape, and the renderer's input type
- **Grounding and validation** — citation resolution, the per-claim degradation policy (what a user sees when the model gets something wrong), and the text-normalization ladder for verifying quotes
- **Model strategy** — routing, effort levels, context strategy, prompt-cache design
- **Cost model** — the actual arithmetic, with per-artifact and per-notebook figures
- **Evaluation harness** — golden corpus, gating metrics, what blocks a merge
- **Observability** — trace records, alerts
- **Appendix A** — amendments this doc proposes to the requirements, listed rather than silently applied

*Read it before implementing anything.* Changes with the implementation.

---

### ✅ [`docs/TASKS.md`](docs/TASKS.md) — Implementation Tasks

**The "in what order."** A 62-task execution list an AI agent or a person can work through directly.

- **Stack selection** with rationale, and the two consequences of the Python/TypeScript split that are real work rather than paperwork
- **Tasks grouped by phase** (0 foundations → 4 refinement), each with an ID, dependencies, spec references, and mechanically checkable acceptance criteria
- **Cross-cutting rules** that apply to every task
- **Critical path** — the shortest sequence to something demoable
- **Open items** — a running log for ambiguities found during implementation

*Read it when picking up work.* Start at T-001.

---

**How they connect.** Requirement IDs (`FR-*`, `NFR-*`) are defined in `REQUIREMENTS.md` and referenced by the other two. `TASKS.md` cites both as `REQ §x` and `TD §x`. If the specs contradict each other, the requirements win on *what* and the design wins on *how* — and the contradiction should be logged, not quietly resolved.

> **One live contradiction, on purpose.** `TECHNICAL_DESIGN.md` §7.5 shows the free tier written into `REQUIREMENTS.md` costs ~$5.55/user/month in variable cost, which isn't viable. The unviable number was left in place so the discrepancy is visible and gets a decision. Tracked as task T-134.

---

## The six artifacts

| Artifact | What it is |
|---|---|
| **Audio Overview** | Podcast-style deep dive between two AI hosts who banter and explain the material |
| **Study Guide** | Outline with short-answer questions, essay prompts, and a glossary |
| **Briefing Document** | Executive summary distilling core themes and actionable points |
| **FAQ Sheet** | Likely questions answered with exact quoted citations |
| **Timeline Guide** | Chronological map of events extracted from the sources |
| **Mind Map** | Interactive visual hierarchy of concepts and their relationships |

---

## Design principles

1. **Source-grounded above all.** Every factual claim traces to a citation in the user's own material. The system refuses rather than fabricates, and tells the user when it dropped something it couldn't verify.
2. **Automatic by default, controllable on demand.** Good output with one click; customization for those who want it.
3. **Study artifacts, not chat transcripts.** The deliverable is something a student can revise from.
4. **Transparent processing.** Show what's happening and how long it will take.

---

## Stack

Python backend (FastAPI + Celery + Postgres), TypeScript frontend (Next.js), Claude API for generation. Rationale and the full selection table are in [`docs/TASKS.md`](docs/TASKS.md#stack--selected).

---

## Getting started

Nothing to run yet. Once T-001/T-002 land:

```bash
docker compose up      # Postgres, Redis, MinIO
```

Setup instructions will replace this section when the scaffold exists.
