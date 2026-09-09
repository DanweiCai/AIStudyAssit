# AI Study Assistant — Product Requirements Document

**Project:** AIStudyAssit
**Version:** 0.2 (Draft)
**Date:** 2026-08-24
**Owner:** cai.da@northeastern.edu
**Status:** Draft for review
**Companion document:** [`TECHNICAL_DESIGN.md`](./TECHNICAL_DESIGN.md) — API contract, job lifecycle, artifact schemas, cost model, eval harness

> **Scope of this document.** Product requirements: what the system does and why, expressed as testable requirements with priorities. Wire formats, schemas, endpoint definitions, and cost arithmetic live in the companion technical design doc, which changes on a faster cadence.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Goals and Non-Goals](#2-goals-and-non-goals)
3. [Target Users and Personas](#3-target-users-and-personas)
4. [User Journey](#4-user-journey)
5. [Functional Requirements](#5-functional-requirements)
   - [5.1 Source Ingestion](#51-source-ingestion)
   - [5.2 Notebook / Workspace Management](#52-notebook--workspace-management)
   - [5.3 Content Processing Pipeline](#53-content-processing-pipeline)
   - [5.4 Generated Artifacts](#54-generated-artifacts)
   - [5.5 Interactive Q&A](#55-interactive-qa)
   - [5.6 Export and Sharing](#56-export-and-sharing)
6. [Artifact Specifications](#6-artifact-specifications)
7. [Non-Functional Requirements](#7-non-functional-requirements)
8. [System Architecture](#8-system-architecture)
9. [Data Model](#9-data-model)
10. [LLM and AI Design](#10-llm-and-ai-design)
11. [Success Metrics](#11-success-metrics)
12. [Release Plan](#12-release-plan)
13. [Risks and Mitigations](#13-risks-and-mitigations)
14. [Open Questions](#14-open-questions)
15. [Glossary](#15-glossary)

---

## 1. Executive Summary

### 1.1 What We Are Building

An **AI Study Assistant** that turns a student's raw study materials into a complete, self-guided learning package.

A student uploads what they already have — lecture PDFs, slide decks, Word documents, web articles, or pasted text — and the system automatically produces a set of study artifacts grounded strictly in those materials:

| Artifact | What It Does |
|---|---|
| **Audio Overview** | Podcast-style deep-dive between two AI hosts who banter and explain the material |
| **Study Guide** | Formatted outline with short-answer questions, essay prompts, and a glossary |
| **Briefing Document** | Executive summary distilling core themes and actionable points |
| **FAQ Sheet** | The most important questions the sources answer, with exact citations |
| **Timeline Guide** | Chronological map of events extracted from the text |
| **Mind Map** | Interactive visual hierarchy of concepts and their relationships |

### 1.2 What We Want to Achieve

**The core outcome:** Compress the gap between "I have the readings" and "I understand the material" from hours of manual note-taking into minutes of automated synthesis — without introducing hallucinated facts.

Five concrete objectives:

1. **Zero-effort onboarding.** A student goes from upload to a usable study guide in under three minutes (see NFR-PERF-8), with no configuration, prompting skill, or AI literacy required.
2. **Multi-modal learning coverage.** Serve reading learners (guides, briefings), auditory learners (podcast audio), and visual learners (mind maps, timelines) from one upload.
3. **Grounded and trustworthy output.** Every factual claim traces back to a citation in the user's own sources. The assistant answers *from the material*, not from its general training knowledge.
4. **A durable study workspace.** Materials, generated artifacts, and chat history persist in a per-topic notebook the student returns to across a semester.
5. **Exam-ready output.** Artifacts are directly usable for revision — printable, exportable, and structured the way students actually study.

### 1.3 Design Principles

- **Source-grounded above all.** Refuse to answer rather than fabricate. Citations are a first-class feature, not a footnote.
- **Automatic by default, controllable on demand.** Good output with one click; customization available for those who want it.
- **Study artifacts, not chat transcripts.** The primary deliverable is a document a student can revise from, not a conversation.
- **Transparent processing.** Show what is happening during long-running generation, and how long it will take.

---

## 2. Goals and Non-Goals

### 2.1 In Scope

| # | Goal | Priority |
|---|---|---|
| G1 | Ingest PDF, PPT/PPTX, DOC/DOCX, TXT/Markdown, web URLs, and pasted text | P0 |
| G2 | Generate Study Guides, Briefing Documents, and FAQ Sheets | P0 |
| G3 | Generate Timeline Guides and Mind Maps | P1 |
| G4 | Generate two-host podcast-style Audio Overviews | P1 |
| G5 | Grounded Q&A chat over the uploaded sources with inline citations | P0 |
| G6 | Persistent notebooks holding multiple sources and their artifacts | P0 |
| G7 | Export artifacts to PDF, Markdown, and DOCX; audio to MP3 | P1 |
| G8 | User accounts with private, isolated workspaces — **[local-v1: deferred, §2.4]** | P0 |

### 2.2 Out of Scope (v1)

| Excluded | Rationale |
|---|---|
| Real-time collaborative editing | Adds significant complexity; single-user value must be proven first |
| Video file ingestion / transcription | Large processing cost; revisit after v1 usage data |
| Native mobile apps | Responsive web covers the primary use case |
| LMS integrations (Canvas, Blackboard) | Requires institutional agreements; post-v1 |
| Spaced-repetition scheduling / flashcard drilling | Adjacent product surface; may be a v2 module |
| Multi-language source support beyond English | v1 targets English; architecture should not preclude expansion |
| Grading, plagiarism detection, or assessment scoring | Different product with different compliance obligations |

### 2.3 Explicit Anti-Goals

- **Not a homework-answering machine.** The product is framed around comprehension, not completing assignments on a student's behalf.
- **Not a general chatbot.** The assistant is scoped to the user's uploaded material.
- **Not a content library.** We do not supply textbooks or course content; the user brings their own sources.

### 2.4 Deployment Scope — Local, Single-User (v1)

**Owner decision, 2026-09-08.** v1 runs locally via `docker compose` and serves exactly one user. There is no hosted environment and no second account.

Requirements this defers, marked **[local-v1]** where they appear:

| Requirement | v1 treatment | Why deferred rather than deleted |
|---|---|---|
| G8 — user accounts | One seeded dev user; no signup, login, or password handling | `user_id` stays on every table and in every query, so multi-user later is a resolver swap, not a migration |
| NFR-SEC-1 — authentication | Fixed dev token from `.env`; query-layer scoping retained | Same as above — the API contract does not change when real auth arrives |
| NFR-SEC-2 — TLS 1.3 / AES-256 at rest | Not applicable over localhost | Supplied by the hosting platform if this is ever deployed |
| NFR-SEC-7 — per-user rate limits | Not enforced | Rate limits protect a shared service from its users; nothing is shared here |
| NFR-COST-2 — monthly quotas | **Enforcement** deferred; cost telemetry (NFR-COST-1) still built | The quota *numbers* are untouched — the `TECHNICAL_DESIGN.md` §7.5 contradiction stays live for T-134 to settle |

**Not deferred:** the `user_id` column, query-layer scoping, NFR-SEC-3 (no training on user content), NFR-SEC-5 (content-type sniffing), and NFR-SEC-6 (SSRF protection). The last two defend against malformed input rather than against other users, so a single-user deployment does not make them safe to skip.

---

## 3. Target Users and Personas

### Persona 1 — Maya, Undergraduate Student (Primary)

- **Context:** Sophomore taking five courses, ~200 pages of assigned reading per week.
- **Pain:** Falls behind on readings; cramming before exams without synthesized notes.
- **Need:** Fast, reliable summaries and self-test questions from lecture slides and readings.
- **Success looks like:** Uploads a week of slides on Sunday, gets a study guide and a 12-minute podcast to listen to on the commute.

### Persona 2 — Daniel, Graduate Researcher (Primary)

- **Context:** Reading 15–30 papers for a literature review.
- **Pain:** Hard to track themes and chronology across many dense papers.
- **Need:** Briefing documents, cross-source themes, and citation-backed claims he can trust and verify.
- **Success looks like:** Uploads 20 PDFs into one notebook, gets a briefing on shared themes and a timeline of the field's development.

### Persona 3 — Priya, Instructor / TA (Secondary)

- **Context:** Preparing a course module and review sessions.
- **Pain:** Manually writing review questions and glossaries takes hours.
- **Need:** Draft FAQ sheets, glossaries, and short-answer questions to adapt.
- **Success looks like:** Uploads her lecture deck, exports a study guide as DOCX, edits it, distributes it.

### Persona 4 — Sam, Professional Learner (Secondary)

- **Context:** Studying for a certification while working full-time.
- **Pain:** No contiguous study blocks; learns in fragments.
- **Need:** Audio overviews for passive learning; briefing docs for quick review.

---

## 4. User Journey

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  1. CREATE   │───▶│  2. UPLOAD   │───▶│  3. PROCESS  │───▶│ 4. GENERATE  │
│   NOTEBOOK   │    │   SOURCES    │    │  (automatic) │    │  ARTIFACTS   │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
                                                                    │
                    ┌──────────────┐    ┌──────────────┐           │
                    │  7. EXPORT   │◀───│  6. REFINE   │◀──────────┘
                    │  AND STUDY   │    │   AND ASK    │    5. REVIEW
                    └──────────────┘    └──────────────┘
```

### Step-by-Step

1. **Create a notebook** — The user names a workspace (e.g., "BIOL 3010 — Midterm 2").
2. **Add sources** — Drag-and-drop files, paste a URL, or paste raw text. Multiple sources per notebook.
3. **Automatic processing** — The system extracts text, chunks it, embeds it, and builds a source index. Progress is visible per source.
4. **Generate artifacts** — Once at least one source is ready, the user clicks any artifact type. Generation runs asynchronously with a progress indicator.
5. **Review** — Artifacts render in-app. Citations are clickable and jump to the exact source passage.
6. **Refine and ask** — The user regenerates with customization ("focus on chapters 3–5", "make it more technical") or asks follow-up questions in grounded chat.
7. **Export and study** — Download as PDF/DOCX/Markdown, or stream/download the audio.

### Key Interaction Requirements

- Generation is **asynchronous and non-blocking** — the user can start an audio overview and continue reading the study guide.
- Every artifact shows **which sources it was generated from** and **when**.
- Long operations show **elapsed time and estimated remaining time**, never an indeterminate spinner alone.

---

## 5. Functional Requirements

Requirement IDs use `FR-<AREA>-<n>`. Priority: **P0** = v1 launch blocker, **P1** = v1 target, **P2** = post-v1.

### 5.1 Source Ingestion

| ID | Requirement | Priority |
|---|---|---|
| FR-ING-1 | Upload PDF files (text-based) and extract text with page numbers preserved | P0 |
| FR-ING-2 | Upload PPT/PPTX and extract per-slide text, titles, and speaker notes | P0 |
| FR-ING-3 | Upload DOC/DOCX and extract text with heading hierarchy preserved | P0 |
| FR-ING-4 | Upload TXT and Markdown files | P0 |
| FR-ING-5 | Submit a web URL; fetch and extract main article content, stripping nav/ads/boilerplate. **v1 scope is server-rendered HTML only** — no headless browser, so JS-rendered SPAs will fail with an explicit "this page requires JavaScript" error rather than yielding empty text | P0 |
| FR-ING-5a | Detect and clearly report paywalled or login-gated pages instead of ingesting the truncated preview as if it were the full article | P0 |
| FR-ING-6 | Paste raw text directly into a text box as a source | P0 |
| FR-ING-7 | Drag-and-drop upload with multi-file selection | P0 |
| FR-ING-8 | Per-source upload progress, then per-source processing status (`queued`/`processing`/`ready`/`failed`) | P0 |
| FR-ING-9 | Clear, actionable error messages on failure (unsupported type, corrupt file, paywalled URL, size exceeded) | P0 |
| FR-ING-10 | Enforce limits: **50 MB** per file, **50 sources** per notebook, **500K tokens** total per notebook. The **token cap is the binding constraint** — it derives from the cost ceiling per generation (`TECHNICAL_DESIGN.md` §7) and the hierarchical-summarization threshold in §10.3. File size and source count are secondary guards against abuse, not capacity planning | P0 |
| FR-ING-11 | Rename, view, and delete individual sources | P0 |
| FR-ING-12 | OCR for scanned/image-based PDFs | P2 |
| FR-ING-13 | Extract figure/table captions as distinct, labeled content units | P2 |
| FR-ING-14 | Ingest YouTube URLs via transcript extraction | P2 |

**Acceptance criteria for FR-ING-1..6:** For each supported type, a representative test file produces extracted text with ≥95% character-level fidelity against a manual reference, retains source locators (page/slide/heading/paragraph), and reaches `ready` status.

### 5.2 Notebook / Workspace Management

| ID | Requirement | Priority |
|---|---|---|
| FR-NB-1 | Create, rename, and delete notebooks | P0 |
| FR-NB-2 | A notebook contains N sources and M generated artifacts | P0 |
| FR-NB-3 | List all notebooks with title, source count, and last-modified date | P0 |
| FR-NB-4 | Notebooks are private to the owning user by default | P0 |
| FR-NB-5 | Select a subset of sources to scope a given generation | P1 |
| FR-NB-6 | Search across sources and artifacts within a notebook | P1 |
| FR-NB-7 | Share a notebook read-only via link | P2 |
| FR-NB-8 | Duplicate a notebook | P2 |

### 5.3 Content Processing Pipeline

| ID | Requirement | Priority |
|---|---|---|
| FR-PROC-1 | Normalize all source types into a common internal document representation | P0 |
| FR-PROC-2 | Chunk documents semantically (~800–1200 tokens, ~15% overlap), respecting section boundaries | P0 |
| FR-PROC-3 | Attach a **source locator** to every chunk (file + page/slide/heading/paragraph range) | P0 |
| FR-PROC-4 | Generate and store vector embeddings per chunk | **P1** |
| FR-PROC-5 | Process sources asynchronously via a job queue; do not block the UI | P0 |
| FR-PROC-6 | Retry transient failures up to 3× with exponential backoff | P0 |
| FR-PROC-7 | Deduplicate identical uploads within a notebook by content hash | P1 |
| FR-PROC-8 | Auto-detect document structure (chapters, sections) to inform chunking | P1 |
| FR-PROC-9 | Build a hierarchical summary index (per-chunk → per-section → per-document) for long-source synthesis | P1 |

> **Note on FR-PROC-4 (embeddings).** Deliberately **P1, not P0**. Phase 1 ships whole-corpus synthesis artifacts (Study Guide, Briefing) that pass full source text to the model with prompt caching — they perform no retrieval. The first genuine consumer of vector search is Q&A chat in Phase 2. Building the embedding pipeline and vector store in Phase 1 would add infrastructure and operational burden that nothing in Phase 1 queries. Chunking and locators (FR-PROC-2, FR-PROC-3) remain P0 — citations depend on them regardless of retrieval.

### 5.4 Generated Artifacts

**Common requirements — apply to every artifact type:**

| ID | Requirement | Priority |
|---|---|---|
| FR-GEN-1 | Generate on explicit user action from the notebook view | P0 |
| FR-GEN-2 | Run asynchronously with visible progress and cancellation | P0 |
| FR-GEN-3 | Ground content strictly in selected sources; no external facts | P0 |
| FR-GEN-4 | Record source-set, timestamp, model, and parameters on every artifact | P0 |
| FR-GEN-5 | Regenerate with optional free-text customization instructions | P0 |
| FR-GEN-6 | Persist artifacts; retain previous versions on regeneration | P1 |
| FR-GEN-7 | Surface a clear, non-technical error and allow retry on failure | P0 |
| FR-GEN-8 | Editable artifacts (user can modify generated text in place) | P2 |
| FR-GEN-9 | **Idempotent submission** — repeated generate requests for the same (notebook, artifact type, source set, params) while a job is in flight return the existing job rather than starting a second one. Prevents double-click double-billing | P0 |
| FR-GEN-10 | Generation uses only sources in `ready` state; the artifact records which sources were included and warns the user if any were skipped | P0 |

Per-artifact requirements are specified in [Section 6](#6-artifact-specifications). The machine-readable output schema for each artifact type — which is simultaneously the LLM structured-output contract, the `Artifact.content` shape, and the renderer's input — is defined in `TECHNICAL_DESIGN.md` §4.

### 5.5 Interactive Q&A

| ID | Requirement | Priority |
|---|---|---|
| FR-QA-1 | Chat interface scoped to the notebook's sources | P0 |
| FR-QA-2 | Retrieve relevant chunks (RAG) and answer from them only | P0 |
| FR-QA-3 | Inline citations on every factual claim, clickable to the source passage | P0 |
| FR-QA-4 | Explicitly state when the sources do not contain the answer, rather than guessing | P0 |
| FR-QA-5 | Maintain conversation history within a notebook session | P0 |
| FR-QA-6 | Stream responses token-by-token | P1 |
| FR-QA-7 | Suggested starter questions derived from the sources | P1 |
| FR-QA-8 | Save a chat answer into the notebook as a note | P2 |

### 5.6 Export and Sharing

| ID | Requirement | Priority |
|---|---|---|
| FR-EXP-1 | Export text artifacts as Markdown | P0 |
| FR-EXP-2 | Export text artifacts as PDF with preserved formatting | P1 |
| FR-EXP-3 | Export text artifacts as DOCX | P1 |
| FR-EXP-4 | Download Audio Overview as MP3 | P1 |
| FR-EXP-5 | Export Mind Map as PNG/SVG | P1 |
| FR-EXP-6 | Copy artifact to clipboard as formatted text | P0 |
| FR-EXP-7 | Print-optimized stylesheet | P1 |
| FR-EXP-8 | Export the full notebook as a single bundled document | P2 |

---

## 6. Artifact Specifications

### 6.1 Audio Overview (Podcast-Style Deep Dive)

**What it is:** A conversational audio discussion between two AI hosts with distinct voices and personalities, who explain the material to each other and to the listener — including natural banter, clarifying questions, and analogies.

**Requirements**

| ID | Requirement | Priority |
|---|---|---|
| FR-AUD-1 | Generate a two-host dialogue script grounded in the sources | P1 |
| FR-AUD-2 | Two distinct voices with distinct conversational roles | P1 |
| FR-AUD-3 | Synthesize the script to audio via a TTS API, stitched into one track | P1 |
| FR-AUD-4 | In-app player: play/pause, seek, speed control (0.75×–2×) | P1 |
| FR-AUD-5 | Display the full transcript alongside the player | P1 |
| FR-AUD-6 | Length presets: Short (~5 min), Default (~12 min), Long (~20 min) | P1 |
| FR-AUD-7 | Customization prompt: focus topics, target audience level, tone | P1 |
| FR-AUD-8 | Download as MP3 | P1 |
| FR-AUD-9 | Transcript is time-synced and highlights during playback | P2 |
| FR-AUD-10 | Interactive mode — listener interrupts to ask a question | P2 |

**Host design**

| Host | Role | Behavior |
|---|---|---|
| **Host A — The Guide** | Domain-knowledgeable explainer | Introduces concepts, provides structure and analogies, drives the arc |
| **Host B — The Curious One** | Intelligent non-expert proxy for the listener | Asks clarifying questions, surfaces implications, challenges vague points |

**Script structure**

1. **Cold open (~30s)** — Hook: why this material matters.
2. **Roadmap (~30s)** — What the episode will cover.
3. **Body (70–80%)** — 3–5 thematic segments, each: concept → explanation → concrete example → why it matters. Host B interjects with questions at natural seams.
4. **Synthesis (~1 min)** — Connect themes; identify the through-line.
5. **Close (~30s)** — Key takeaways; what to study next.

**Quality bar**

- Reads as spontaneous conversation, not alternating monologues.
- Uses natural speech: contractions, interjections, mid-sentence redirections, occasional light humor.
- No invented facts, statistics, or citations — everything traces to the sources.
- Technical terms are defined on first use.
- Zero references to being an AI, to "the document," or to the generation process. Hosts speak as if they have read and internalized the material.

---

### 6.2 Study Guide

**What it is:** A formatted outline of the material paired with self-assessment questions and a glossary — the artifact a student revises from directly.

**Requirements**

| ID | Requirement | Priority |
|---|---|---|
| FR-SG-1 | Hierarchical outline of key topics and subtopics | P0 |
| FR-SG-2 | 10–20 short-answer questions with model answers (initially hidden) | P0 |
| FR-SG-3 | 4–8 essay prompts requiring synthesis across topics | P0 |
| FR-SG-4 | Glossary of key terms with source-grounded definitions | P0 |
| FR-SG-5 | Every section cites its source locations | P0 |
| FR-SG-6 | Difficulty setting: Introductory / Intermediate / Advanced | P1 |
| FR-SG-7 | Self-test mode — reveal answers one at a time | P1 |
| FR-SG-8 | Multiple-choice question section | P2 |

**Structure**

```
STUDY GUIDE: <Notebook Title>

1. Overview                     — 2–3 sentence scope statement
2. Key Topics                   — Hierarchical outline; each topic has
                                  summary, key points, and citations
3. Short-Answer Questions       — 10–20 items; 2–3 sentence model answers,
                                  each citing a source
4. Essay Questions              — 4–8 prompts, each with a guidance note on
                                  what a strong answer addresses
5. Glossary                     — Alphabetized terms with definitions
                                  drawn from the sources
```

**Quality bar:** Questions test comprehension and application, not trivia recall. Every model answer is fully supported by the sources. The glossary covers terms a newcomer would stumble on.

---

### 6.3 Briefing Document

**What it is:** A high-level executive summary that distills complex sources into core themes and actionable points — for someone who needs the substance in five minutes.

**Requirements**

| ID | Requirement | Priority |
|---|---|---|
| FR-BRF-1 | Executive summary (3–5 sentences) capturing the core thesis | P0 |
| FR-BRF-2 | 3–7 core themes, each with explanation and supporting evidence | P0 |
| FR-BRF-3 | Key facts / figures / data points extracted verbatim with citations | P0 |
| FR-BRF-4 | Actionable points or practical implications | P0 |
| FR-BRF-5 | Cross-source synthesis: agreements, tensions, and gaps between sources | P1 |
| FR-BRF-6 | Length presets: Brief (~1 page) / Standard (~3 pages) / Detailed (~6 pages) | P1 |

**Structure**

```
BRIEFING DOCUMENT: <Notebook Title>

1. Executive Summary            — The single most important takeaway
2. Core Themes                  — 3–7 themes: what it is, evidence, significance
3. Key Facts and Figures        — Verbatim data points with citations
4. Actionable Points            — What the reader should do or watch for
5. Cross-Source Analysis (P1)   — Where sources agree, conflict, or leave gaps
6. Sources Referenced           — Full list with coverage note
```

**Quality bar:** A reader who reads only the executive summary knows the thesis. Themes are genuinely distinct, not restatements. Actionable points are specific enough to act on.

---

### 6.4 FAQ Sheet

**What it is:** The questions a reader is most likely to have, answered directly from the material with exact textual citations.

**Requirements**

| ID | Requirement | Priority |
|---|---|---|
| FR-FAQ-1 | 15–30 question/answer pairs derived from the sources | P0 |
| FR-FAQ-2 | Every answer includes at least one **exact quoted passage** from a source | P0 |
| FR-FAQ-3 | Citations name the source file and precise location (page/slide/section) | P0 |
| FR-FAQ-4 | Questions grouped by theme | P0 |
| FR-FAQ-5 | Ordered by importance/likelihood within each group | P0 |
| FR-FAQ-6 | Collapsible answers (accordion UI) | P1 |
| FR-FAQ-7 | Keyword search across the FAQ set | P1 |
| FR-FAQ-8 | Flag questions the sources raise but do not fully answer | P2 |

**Per-item format**

```
Q: <Question phrased as a reader would ask it>

A: <Direct 2–4 sentence answer>

   > "<Exact quoted passage from the source>"
   — source_name.pdf, p. 14
```

**Quality bar:** Questions are ones a real learner would ask, not mechanically inverted sentences. Quotes are verbatim — character-for-character — and directly support the answer.

---

### 6.5 Timeline Guide

**What it is:** A chronological map of events, milestones, or process stages extracted from the material — for history, project management, case studies, and any sequential process.

**Requirements**

| ID | Requirement | Priority |
|---|---|---|
| FR-TL-1 | Extract dated or sequenced events from the sources | P1 |
| FR-TL-2 | Order chronologically; handle absolute dates, relative dates, and pure ordering | P1 |
| FR-TL-3 | Each entry: date/marker, title, description, citation | P1 |
| FR-TL-4 | Cast of characters — key people/organizations with roles | P1 |
| FR-TL-5 | Visual vertical timeline rendering | P1 |
| FR-TL-6 | Handle imprecise dates ("early 1900s", "Q3", "Phase 2") with explicit uncertainty markers | P1 |
| FR-TL-7 | Group into eras/phases when the material supports it | P1 |
| FR-TL-8 | Gracefully report when the material contains no meaningful chronology | P1 |
| FR-TL-9 | Filter by date range or source | P2 |
| FR-TL-10 | Parallel tracks for concurrent event streams | P2 |
| FR-TL-11 | **Multi-source merge:** produce one unified chronology across all selected sources, not one timeline per source. Events describing the same occurrence are merged and carry citations from every source that mentions them | P1 |
| FR-TL-12 | **Date conflicts across sources** are surfaced explicitly in Uncertainty Notes with each source's claimed date and citation — never silently resolved by picking one | P1 |

**Structure**

```
TIMELINE: <Notebook Title>

1. Scope Note                   — Period covered, granularity, known gaps
2. Chronology                   — Ordered entries, optionally grouped into eras
3. Cast of Characters           — Key actors, roles, and first appearance
4. Uncertainty Notes            — Events with ambiguous or conflicting dating
```

**Quality bar:** Ordering is verifiably correct. No dates are inferred beyond what the sources state. Ambiguity is disclosed, not silently resolved.

---

### 6.6 Mind Map

**What it is:** An interactive visual hierarchy showing the central topic, major branches, and how concepts relate.

**Requirements**

| ID | Requirement | Priority |
|---|---|---|
| FR-MM-1 | Extract a concept hierarchy: central topic → major branches → sub-nodes | P1 |
| FR-MM-2 | Render as an interactive node-link diagram | P1 |
| FR-MM-3 | Expand/collapse branches | P1 |
| FR-MM-4 | Click a node to see its summary and source citations | P1 |
| FR-MM-5 | Depth limit of 4 levels; branch breadth limit of ~7 for readability | P1 |
| FR-MM-6 | Pan and zoom; fit-to-screen control | P1 |
| FR-MM-7 | Export as PNG and SVG | P1 |
| FR-MM-8 | Cross-links between branches for non-hierarchical relationships | P2 |
| FR-MM-9 | Manual node editing and repositioning | P2 |
| FR-MM-10 | Color-code branches by source document | P2 |
| FR-MM-11 | **Multi-source merge:** one unified map across all selected sources. Concepts appearing in several sources become a single node carrying multiple citations; the central topic is derived from the whole source set, not the first document | P1 |

**Data shape**

```json
{
  "central_topic": "string",
  "nodes": [
    {
      "id": "string",
      "label": "string (≤ 6 words)",
      "parent_id": "string | null",
      "summary": "string (1–2 sentences)",
      "citations": [{ "source_id": "string", "locator": "string" }]
    }
  ],
  "cross_links": [
    { "from": "node_id", "to": "node_id", "relationship": "string" }
  ]
}
```

**Quality bar:** The hierarchy reflects the material's actual conceptual structure, not just its table of contents. Labels are short enough to read at a glance. A student can use the map to recall the shape of the topic.

---

### 6.7 Artifact Comparison

| Artifact | Best For | Reading Time | Learning Mode | Priority |
|---|---|---|---|---|
| Audio Overview | Passive review, commuting | 5–20 min | Auditory | P1 |
| Study Guide | Active exam prep | 15–30 min | Reading + self-test | P0 |
| Briefing Document | Rapid orientation | 3–10 min | Reading | P0 |
| FAQ Sheet | Targeted lookup | Variable | Reference | P0 |
| Timeline Guide | Sequence and causality | 5–15 min | Visual + reading | P1 |
| Mind Map | Structural recall | 3–10 min | Visual | P1 |

---

## 7. Non-Functional Requirements

### 7.1 Performance

| ID | Requirement | Target |
|---|---|---|
| NFR-PERF-1 | Source processing (upload → ready) for a 30-page PDF | < 60s (p95) |
| NFR-PERF-2 | Text artifact generation (Study Guide, Briefing, FAQ) | < 90s (p95) |
| NFR-PERF-3 | Mind Map / Timeline generation | < 60s (p95) |
| NFR-PERF-4 | Audio Overview end-to-end (script + TTS) | < 5 min (p95) |
| NFR-PERF-5 | Q&A first token latency | < 3s (p95) |
| NFR-PERF-6 | Page load (notebook view) | < 2s (p95) |
| NFR-PERF-7 | Concurrent generation jobs per user | ≥ 3 |
| NFR-PERF-8 | **End-to-end: upload → first text artifact ready** | < 3 min (p95), < 90s (median) |

**Derivation of NFR-PERF-8:** 60s processing (NFR-PERF-1) + 90s generation (NFR-PERF-2) + ~30s queue and transfer overhead = 180s at p95. All user-facing "time to first artifact" claims elsewhere in this document derive from this budget; do not state a tighter number without changing the components above.

### 7.2 Reliability

| ID | Requirement |
|---|---|
| NFR-REL-1 | 99.5% uptime for the core application |
| NFR-REL-2 | Generation jobs survive server restarts (durable queue) |
| NFR-REL-3 | LLM API failures retry 3× with exponential backoff before surfacing an error |
| NFR-REL-4 | Partial failure isolation: one failed source does not block others in the notebook |
| NFR-REL-5 | Uploaded sources and generated artifacts are durably stored and backed up daily |

### 7.3 Accuracy and Trust

| ID | Requirement |
|---|---|
| NFR-ACC-1 | ≥ 95% of factual claims in generated artifacts carry a citation that resolves to a real chunk. Claims whose citations fail to resolve are **dropped or visibly flagged per-claim**, not silently shipped — the artifact still delivers. See the degradation policy in `TECHNICAL_DESIGN.md` §5.3 |
| NFR-ACC-2 | 100% of FAQ quoted passages match their source after **text normalization** (Unicode NFKC, whitespace collapse, dehyphenation across line breaks, quote-character folding). Raw byte-for-byte comparison is **not** the check — PDF extraction artifacts would fail correct quotes. Normalization spec in `TECHNICAL_DESIGN.md` §5.4 |
| NFR-ACC-3 | The assistant states "the sources do not address this" rather than answering from general knowledge |
| NFR-ACC-4 | Every artifact displays which sources and which model version produced it |
| NFR-ACC-5 | Users can report a bad or hallucinated output on any artifact |

### 7.4 Usability and Accessibility

| ID | Requirement |
|---|---|
| NFR-UX-1 | WCAG 2.1 Level AA compliance |
| NFR-UX-2 | Full keyboard navigation for all core flows |
| NFR-UX-3 | Screen-reader compatible; mind maps provide an equivalent text outline |
| NFR-UX-4 | Responsive layout for desktop, tablet, and mobile web |
| NFR-UX-5 | No AI/prompting expertise required for the default path |
| NFR-UX-6 | Long-running operations show progress and estimated time remaining |

### 7.5 Security and Privacy

| ID | Requirement |
|---|---|
| NFR-SEC-1 | Authentication required; sources and artifacts isolated per user account. **[local-v1: §2.4 — one seeded dev user and a fixed `.env` token; query-layer scoping still enforced]** |
| NFR-SEC-2 | Encryption in transit (TLS 1.3) and at rest (AES-256). **[local-v1: n/a over localhost, §2.4]** |
| NFR-SEC-3 | User content is **not** used to train models; enforced via provider API settings and documented in the privacy policy |
| NFR-SEC-4 | Full account and data deletion on request, completing within 30 days |
| NFR-SEC-5 | Uploaded files are validated and scanned; content-type is verified rather than trusted from the extension |
| NFR-SEC-6 | URL fetching restricted to public HTTP(S); SSRF protection against internal address ranges |
| NFR-SEC-7 | Rate limiting per user: **20 uploads/hour**, **10 generations/hour**, **3 concurrent generation jobs**. Audio overviews additionally capped at **5/day** (highest unit cost). Values derived in `TECHNICAL_DESIGN.md` §7. **[local-v1: not enforced, §2.4]** |
| NFR-SEC-8 | FERPA-aware handling if institutional deployment is pursued (post-v1 assessment) |

### 7.6 Cost

| ID | Requirement |
|---|---|
| NFR-COST-1 | Track LLM and TTS token/character spend per user and per notebook |
| NFR-COST-2 | Enforce configurable per-user monthly quotas. **v1 free tier: 30 text artifacts + 3 audio overviews per month.** Quota consumption is charged on job *success* only — failed or cancelled jobs are refunded. Derivation in `TECHNICAL_DESIGN.md` §7. **[local-v1: enforcement deferred, §2.4 — tier numbers unchanged, T-134 still open]** |
| NFR-COST-3 | Cache generated artifacts; never regenerate without explicit user action |
| NFR-COST-4 | Use prompt caching for repeated source context across artifact generations |
| NFR-COST-5 | Route work to appropriately-sized models per task (see §10.2) |

### 7.7 Observability and Debuggability

| ID | Requirement |
|---|---|
| NFR-OBS-1 | Every generation job carries a **trace ID** linking the job, the assembled prompt, the raw model response, the retrieved chunk set, and the resulting artifact |
| NFR-OBS-2 | Prompts and raw model responses are persisted for **30 days** to make user-reported bad output (NFR-ACC-5) diagnosable. These payloads contain user coursework — they inherit the same encryption, access control, and deletion guarantees as source content (NFR-SEC-2, NFR-SEC-4) |
| NFR-OBS-3 | A user-submitted issue report captures artifact ID, trace ID, and the specific claim flagged, so a reviewer can reproduce it without contacting the user |
| NFR-OBS-4 | Structured metrics per job: latency by pipeline stage, tokens in/out, model version, prompt template version, citation resolution rate, retry count |
| NFR-OBS-5 | Alerting on regressions in citation resolution rate, generation failure rate, and p95 latency |

---

## 8. System Architecture

### 8.1 High-Level Components

```
┌─────────────────────────────────────────────────────────────────┐
│                          CLIENT (Web)                            │
│   Notebook UI · Upload · Artifact Viewers · Chat · Audio Player  │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTPS / REST + SSE
┌────────────────────────────▼────────────────────────────────────┐
│                          API LAYER                               │
│   Auth · Notebooks · Sources · Artifacts · Chat · Export         │
└──────┬──────────────────────────────────────────────┬───────────┘
       │                                              │
┌──────▼───────────────┐                    ┌─────────▼───────────┐
│   INGESTION SERVICE  │                    │  GENERATION SERVICE │
│  ─────────────────── │                    │ ─────────────────── │
│  Format parsers      │                    │  Retrieval (RAG)    │
│  Text normalization  │                    │  Prompt assembly    │
│  Semantic chunking   │                    │  LLM orchestration  │
│  Embedding           │                    │  Citation validation│
│  URL fetch/extract   │                    │  TTS synthesis      │
└──────┬───────────────┘                    └─────────┬───────────┘
       │                                              │
       └──────────────┬───────────────────────────────┘
                      │
       ┌──────────────▼──────────────┐   ┌──────────────────────┐
       │        JOB QUEUE            │   │   EXTERNAL SERVICES  │
       │  Durable async workers      │   │  ──────────────────  │
       │  Retry · Progress · Cancel  │   │  LLM API             │
       └──────────────┬──────────────┘   │  Embedding API       │
                      │                  │  TTS API             │
       ┌──────────────▼──────────────┐   └──────────────────────┘
       │        STORAGE LAYER        │
       │  Postgres  · Vector store   │
       │  Object storage (files/mp3) │
       │  Cache (sessions/prompts)   │
       └─────────────────────────────┘
```

### 8.2 Component Responsibilities

| Component | Responsibility |
|---|---|
| **Client** | Upload UX, artifact rendering, chat, audio playback, export triggers |
| **API Layer** | AuthN/AuthZ, CRUD, job submission, streaming responses |
| **Ingestion Service** | Parse → normalize → chunk → embed → index, per source type |
| **Generation Service** | Retrieve context, assemble prompts, call LLM, validate citations, synthesize audio |
| **Job Queue** | Durable async execution with retry, progress reporting, and cancellation |
| **Storage** | Relational metadata, vector index, binary blobs, cache |

### 8.3 Generation Flow

```
User clicks "Generate Study Guide"
         │
         ▼
  Enqueue job ──▶ Worker picks up
         │
         ▼
  Select source scope (all, or user-selected subset)
         │
         ▼
  Retrieve context
    ├─ Small corpus  → include full text
    └─ Large corpus  → hierarchical summaries + targeted retrieval
         │
         ▼
  Assemble prompt: system role + artifact spec + source chunks (with locators)
         │
         ▼
  Call LLM with structured output schema
         │
         ▼
  Validate: schema conformance · citation resolution · quote verbatim check
         │
         ├─ Fail ──▶ Retry (max 3) ──▶ Surface error
         │
         ▼
  Persist artifact + provenance metadata
         │
         ▼
  Notify client ──▶ Render
```

### 8.4 Audio Generation Flow

```
Source content
   │
   ▼
[1] Content planning     → Themes, arc, segment outline
   │
   ▼
[2] Script generation    → Turn-by-turn dialogue (speaker, text)
   │
   ▼
[3] Script validation    → Grounding check · length estimate · tone check
   │
   ▼
[4] TTS synthesis        → Per-turn audio, voice A / voice B
   │
   ▼
[5] Audio assembly       → Concatenate with natural pause spacing, normalize levels
   │
   ▼
[6] Store MP3 + transcript
```

Splitting planning from scripting keeps the dialogue coherent over long material and lets the pipeline fail fast on grounding problems before incurring TTS cost.

### 8.5 Technology Considerations

Not final selections; these are the constraints any chosen stack must satisfy.

| Layer | Requirement |
|---|---|
| Document parsing | Reliable PDF text + layout extraction; PPTX and DOCX structural extraction |
| Web extraction | Article-content isolation with boilerplate removal |
| Vector store | Metadata filtering by notebook and source; supports 500K+ chunks |
| LLM API | Long context window, structured output support, prompt caching |
| TTS | Multiple natural voices, SSML or equivalent prosody control, ≥ 20 min output |
| Job queue | Durable, at-least-once delivery, progress reporting, cancellation |
| Mind map rendering | Interactive node-link graph with expand/collapse and SVG export |

---

## 9. Data Model

### Core Entities

```
User
 ├── id, email, name, created_at
 └── plan_tier, usage_quota

Notebook
 ├── id, user_id, title, description
 ├── created_at, updated_at
 └── settings (default difficulty, tone preferences)

Source
 ├── id, notebook_id, title
 ├── type            (pdf | pptx | docx | txt | md | url | pasted_text)
 ├── original_uri    (object storage key or URL)
 ├── status          (queued | processing | ready | failed)
 ├── error_message
 ├── content_hash
 ├── token_count, page_count
 └── created_at

Chunk
 ├── id, source_id, sequence_index
 ├── text                 (as extracted)
 ├── text_normalized      (for verbatim quote matching — see NFR-ACC-2)
 ├── locator              { page? , slide? , heading? , char_range }
 └── token_count

Embedding                 (Phase 2 — see note on FR-PROC-4)
 ├── id, chunk_id
 ├── vector
 ├── model_version        (re-embed required if this changes)
 └── created_at

Artifact
 ├── id, notebook_id
 ├── type            (audio_overview | study_guide | briefing |
 │                    faq | timeline | mind_map)
 ├── status          (queued | generating | ready | failed)
 ├── content         (JSONB — type-specific schema)
 ├── source_ids      (array — provenance)
 ├── model_version, prompt_template_version
 ├── generation_params, customization_prompt
 ├── version_number, parent_artifact_id   (regeneration lineage)
 ├── trace_id                             (→ NFR-OBS-1)
 ├── created_at, deleted_at               (soft delete → NFR-SEC-4)
 └── content_schema_version

AudioAsset
 ├── id, artifact_id
 ├── audio_uri, duration_seconds
 ├── transcript      (JSONB — turns with speaker + optional timings)
 └── voice_config

ChatMessage
 ├── id, notebook_id, role (user | assistant)
 ├── content
 ├── citations       (JSONB — chunk references)
 └── created_at

GenerationJob
 ├── id, notebook_id, artifact_id
 ├── job_type, status, progress_percent
 ├── started_at, completed_at
 ├── error_detail, retry_count
 └── token_usage, estimated_cost
```

### Key Relationships

- `User` 1—N `Notebook` 1—N `Source` 1—N `Chunk`
- `Notebook` 1—N `Artifact`; each `Artifact` references the `Source` set it was generated from
- `Artifact` (audio_overview) 1—1 `AudioAsset`
- `Notebook` 1—N `ChatMessage`
- Citations resolve to `Chunk` → `Source` → locator

---

## 10. LLM and AI Design

### 10.1 Grounding Strategy

Grounding is enforced at four points, not one:

1. **Prompt-level.** System prompts explicitly instruct: answer only from provided sources; if the sources are insufficient, say so.
2. **Context-level.** Every chunk in the prompt carries its source ID and locator so the model can cite precisely.
3. **Output-level.** Structured output schemas make citation fields required, not optional.
4. **Validation-level.** Post-generation, every citation is resolved against the chunk store; every FAQ quote is verified verbatim by exact string match. Unresolvable citations trigger regeneration.

### 10.2 Model Routing

| Task | Model Tier | Rationale |
|---|---|---|
| Study Guide, Briefing, FAQ, Timeline, Mind Map | Frontier | Quality of synthesis is the product |
| Audio script generation | Frontier | Conversational naturalness is difficult |
| Q&A chat | Frontier | User-facing accuracy under retrieval |
| Chunk-level summarization (index building) | Mid-tier | High volume, bounded task |
| Title generation, tagging, classification | Small/fast | Trivial, latency-sensitive |

Model IDs are configuration, not code — routing must be changeable without redeployment.

### 10.3 Context Management

| Corpus Size | Strategy |
|---|---|
| Small (< 50K tokens) | Pass full text directly |
| Medium (50K–200K tokens) | Full text with prompt caching across artifact generations |
| Large (> 200K tokens) | Hierarchical summarization + targeted retrieval per artifact section |

For per-section generation (e.g., each study guide topic), retrieve context scoped to that section rather than re-sending the whole corpus.

### 10.4 Prompt Architecture

Each artifact type has a versioned prompt template composed of:

1. **Role definition** — Who the model is acting as for this artifact.
2. **Grounding constraints** — Source-only rule, citation requirements, refusal behavior.
3. **Structural specification** — The exact required output shape.
4. **Quality criteria** — What good looks like for this artifact type.
5. **Source context** — Chunks with locators.
6. **User customization** — Optional free-text instructions, applied last and constrained to not override grounding rules.

Prompt templates are versioned; the version is recorded on every artifact for reproducibility and regression tracking.

**Version migration policy.** Existing artifacts are **never silently regenerated** when a prompt template or model version changes — regeneration costs money and would rewrite output a student may already have studied from. Instead, an artifact produced by a superseded version displays a passive "a newer version is available" affordance with one-click regeneration. The user decides. Regeneration creates a new `Artifact` row linked via `parent_artifact_id`, preserving the original.

### 10.5 Quality Evaluation

| Dimension | Method |
|---|---|
| Grounding | Automated citation resolution rate; verbatim quote match rate |
| Structure | Schema validation pass rate |
| Coverage | Proportion of source sections represented in the artifact |
| Usefulness | User thumbs up/down + explicit "report issue" on each artifact |
| Regression | Golden test set of documents with reviewed reference outputs, run on prompt/model changes |

The evaluation harness is the highest-leverage engineering investment in this product — corpus composition, reference-output authoring, pass thresholds, deploy gating, and per-run cost are specified in `TECHNICAL_DESIGN.md` §8.

---

## 11. Success Metrics

### 11.1 Product Metrics

| Metric | Target (90 days post-launch) |
|---|---|
| Time from first upload to first generated artifact | < 90s (median), < 3 min (p95) |
| Artifact generation success rate | > 97% |
| Users generating ≥ 2 artifact types per notebook | > 60% |
| Weekly returning users | > 40% |
| Notebooks with ≥ 3 sources | > 50% |
| Artifact thumbs-up rate | > 80% |
| Hallucination reports per 1,000 artifacts | < 10 |

### 11.2 Technical Metrics

| Metric | Target |
|---|---|
| Source processing p95 latency | < 60s |
| Text artifact generation p95 latency | < 90s |
| Audio generation p95 latency | < 5 min |
| Citation resolution rate | > 95% |
| Verbatim quote match rate (FAQ) | 100% |
| API error rate | < 1% |
| Cost per generated artifact | Tracked; target set after v1 baseline |

### 11.3 The Core Question

> **Does a student who uses this study more effectively than one who does not?**

Proxy signals for v1: return rate during exam periods, artifacts exported (indicating real study use), and self-reported usefulness. Direct learning-outcome measurement is a post-v1 research question.

---

## 12. Release Plan

### Phase 1 — Foundation (v0.1)

**Goal:** Prove the ingest → generate → read loop end-to-end.

- Single-user context (seeded dev user, **[local-v1: §2.4]**) and notebook CRUD
- Ingestion: PDF, pasted text
- Processing pipeline: extract → chunk → locators → normalize (**no embeddings** — see FR-PROC-4 note)
- Async job infrastructure with progress and cancellation
- Artifacts: **Study Guide**, **Briefing Document** (full-text context + prompt caching)
- Citation validation and per-claim degradation
- Trace-ID observability (NFR-OBS-1/2)
- Markdown export
- Basic notebook UI

**Exit criteria:** A user uploads a PDF and gets a correct, citation-backed study guide within the NFR-PERF-8 budget (< 3 min p95, < 90s median).

---

### Phase 2 — Full Text Artifacts (v0.2)

**Goal:** Complete text-based artifact coverage and grounded chat.

- Ingestion: PPTX, DOCX, TXT/MD, URL (server-rendered HTML only)
- **Embedding pipeline and vector store** (FR-PROC-4) — first real consumer arrives here
- Artifacts: **FAQ Sheet** (with normalized verbatim validation), **Timeline Guide**
- Grounded Q&A chat with inline citations
- Multi-source notebooks with source-scope selection and cross-source merge
- Hierarchical summarization for corpora > 200K tokens
- PDF and DOCX export

**Exit criteria:** All P0 requirements met; citation resolution rate above 95%.

---

### Phase 3 — Visual and Audio (v0.3)

**Goal:** Multi-modal coverage.

- **Mind Map** generation and interactive rendering
- **Audio Overview**: script generation, TTS, player, transcript
- Audio length presets and customization
- PNG/SVG and MP3 export

**Exit criteria:** Audio overviews rated useful by > 70% of users who generate one.

---

### Phase 4 — Refinement (v0.4)

**Goal:** Quality, control, and scale.

- Artifact regeneration with customization; version history
- Difficulty and length controls across artifact types
- Notebook search
- Performance optimization and cost controls
- Accessibility audit and WCAG 2.1 AA remediation

---

### Post-v1 Candidates

OCR for scanned PDFs · YouTube transcript ingestion · Read-only notebook sharing · Interactive audio mode · Flashcards and spaced repetition · Editable artifacts · LMS integration · Multi-language support

---

## 13. Risks and Mitigations

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | **Hallucinated content** undermines trust in an education product | Critical | Four-layer grounding (§10.1); automated citation validation; verbatim quote checking; user reporting; visible provenance |
| R2 | **Audio quality falls short** of the natural-conversation bar | High | Two-stage script pipeline; invest in prosody/pacing tuning; validate script before spending TTS cost; ship behind a quality gate rather than on schedule |
| R3 | **Cost per user exceeds** sustainable economics | High | Model routing by task; prompt caching; artifact caching; per-user quotas; cost telemetry from day one |
| R4 | **Long documents** exceed context or degrade synthesis quality | High | Hierarchical summarization; section-scoped retrieval; explicit per-notebook token limits |
| R5 | **Format extraction fails** on real-world messy files | Medium | Broad test corpus of real course materials; per-format fidelity tests; clear failure messaging; OCR fallback planned |
| R6 | **Generation latency** frustrates users | Medium | Async jobs with real progress; generate cheapest artifacts first; stream where possible; set expectations in the UI |
| R7 | **Academic integrity concerns** from institutions | Medium | Position and design around comprehension, not assignment completion; no essay-writing feature; clear positioning in product copy |
| R8 | **Privacy concerns** over uploaded coursework | Medium | No training on user content; clear policy; encryption; deletion controls; per-user isolation |
| R9 | **LLM provider outage or breaking change** | Medium | Provider abstraction layer; model IDs in config; retry with backoff; graceful degradation messaging |
| R10 | **Copyright exposure** from uploaded textbook content | Medium | Private-by-default notebooks; no redistribution features in v1; user-attested rights in ToS |

---

## 14. Open Questions

| # | Question | Needed By | Owner |
|---|---|---|---|
| Q1 | Which TTS provider meets the two-host naturalness bar at acceptable cost? | Phase 3 start | Eng |
| ~~Q2~~ | ~~Free-tier limits~~ — **resolved v0.2:** 30 text artifacts + 3 audio/month (NFR-COST-2), pending validation against real cost data | — | — |
| Q3 | Do we support institutional/team accounts in v1, or individual only? | Phase 2 | Product |
| ~~Q4~~ | ~~Per-notebook token ceiling~~ — **resolved v0.2:** 500K tokens is binding (FR-ING-10); revisit after Phase 1 cost telemetry | — | — |
| Q9 | Which TTS voices clear the two-host naturalness bar — requires blind listening test | Phase 3 start | Product + Eng |
| Q10 | Does the FAQ verbatim-match threshold hold at 0.95 similarity post-normalization, or does real PDF extraction force it lower? | Phase 2 | Eng |
| Q5 | Should artifacts be user-editable in v1, or read-only with regeneration? | Phase 4 | Product |
| Q6 | How do we handle sources in languages other than English — block, or attempt? | Phase 2 | Product |
| Q7 | Is there an institutional sales motion, and does it change FERPA obligations? | Post-v1 | Business |
| Q8 | Do we measure learning outcomes directly, and if so how? | Post-v1 | Research |

---

## 15. Glossary

| Term | Definition |
|---|---|
| **Artifact** | Any AI-generated study output (study guide, briefing, FAQ, timeline, mind map, audio overview) |
| **Chunk** | A semantically coherent segment of a source document, the unit of retrieval and citation |
| **Citation** | A reference from generated content back to a specific chunk and its location in a source |
| **Grounding** | Constraining generated content to information present in the user's sources |
| **Locator** | The precise position of content within a source (page, slide, heading, character range) |
| **Notebook** | A user workspace containing a set of related sources and the artifacts generated from them |
| **Provenance** | The recorded metadata of how an artifact was produced: sources, model, prompt version, timestamp |
| **RAG** | Retrieval-Augmented Generation — retrieving relevant source chunks to include in the model prompt |
| **Source** | A single uploaded or pasted piece of study material |
| **TTS** | Text-to-Speech — synthesis of the audio overview script into spoken audio |

---

*End of document. Comments and revisions welcome — this is a v0.1 draft intended to be argued with.*
