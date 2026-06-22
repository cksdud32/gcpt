# GCPT — Reasoning Evolution Engine

> Experimental multi-agent system that tracks how arguments evolve, how questions transform, and what cognitive frameworks emerge through structured AI discussion.

**Not a debate app. Not a voting system.**  
GCPT observes reasoning structure — how logic branches survive, how questions drift, and what kind of thinking a discussion generates as a whole.

---

## Architecture

```
Question (initial goal)
       │
       ▼
Multi-Agent Discussion
  ┌────────────────────────────────────┐
  │  GPT · Claude · Gemini             │
  │  propose → refine → concede →      │
  │  synthesize (revision timeline)    │
  └────────────────────────────────────┘
       │
       ▼
Branch Evolution
  (which reasoning lineages survive; which get absorbed or collapse)
       │
       ▼
Question Drift
  (stable_topic → reframed → shifted → transformed)
       │
       ▼
Structural Consensus
  (shared reasoning structure beneath surface disagreement)
       │
       ▼
Cognitive Framework Extraction
  (what kind of thinking model did the discussion generate?)
       │
       ▼
Evolutionary Resolution
  (structural conclusion — not winner selection)
```

---

## Philosophy

GCPT's design philosophy has evolved through several shifts:

```
Winner Selection          →  "which AI got the most votes"
      ↓
Consensus Tracking        →  "did they converge on an answer"
      ↓
Branch Survival           →  "which reasoning lines held up over time"
      ↓
Question Evolution        →  "did the question itself change"
      ↓
Cognitive Framework Gen.  →  "what structure of thinking did this produce"
```

The final output is not "who won."  
It is: **what kind of reasoning structure did the discussion evolve into.**

---

## Core Systems

### Evolutionary Resolution

Final conclusions are not derived from vote counts or evaluator scores.  
`buildFinalResolution()` synthesizes:

- surviving reasoning branches
- structural consensus core
- question evolution trajectory
- unresolved tensions

Resolution types:

| Type | Meaning |
|---|---|
| `transformed_resolution` | The question itself evolved; conclusion reflects that transformation |
| `synthesized_resolution` | Multiple positions merged into a shared structural understanding |
| `stable_answer` | Convergence with the original question frame preserved |
| `unresolved_dynamic_tension` | Persistent structural conflict — the tension itself is the result |

---

### Question Evolution

Compares the semantic centroid of the initial 20% of proposals against the final 20%.  
Classifies how the question shifted:

| Drift Type | Description |
|---|---|
| `stable_topic` | Original question maintained throughout |
| `reframed_topic` | Same question, new framing or perspective |
| `shifted_topic` | Central axis of discussion moved |
| `transformed_topic` | The question itself evolved into a new question |

Generates an **Emergent Question** — the question the discussion was actually trying to answer by the end, derived from surviving branch content rather than summarization.

Tracks per-revision **Question Pressure** (preserve / reframe / expand / redirect / replace) and detects **Question Lock** actors who consistently preserved the original framing rather than evolving it.

---

### Branch Survival

Each proposal is tracked as a node in a reasoning lineage.  
Connections:

- `refines` — builds on a prior proposal
- `concedes` — absorbs a counter-argument
- `synthesizes` — merges two lineages
- `criticizes` — challenges without adoption

Branches are scored by:

- `semanticPersistence` — how long the reasoning keywords survived
- `innovationRetention` — how much of their novel content was carried forward
- `repeatedDefenseRatio` — how often the branch defended without evolving

**Dominant branches** are those that either survived through evolution or absorbed competing branches into themselves.

---

### Structural Consensus

Two actors can share a deep reasoning structure while disagreeing on surface framing.  
`detectPseudoDebate()` identifies this state — Semantic Loop — where:

- surface disagreement is maintained
- semantic drift score is low (concepts barely changing)
- shared core concepts are strong across all actors

When detected, `buildStructuralConsensus()` extracts:

- the shared structural core
- each actor's surface position vs. their structural contribution
- a structural note describing the convergence

This can trigger `pseudo_convergence` — automatic termination when continued debate would be redundant.

---

### Cognitive Framework Extraction

After a discussion, `extractCognitiveFramework()` determines what type of thinking model the debate generated as a whole.

Framework types:

| Type | Characteristics |
|---|---|
| `governance_model` | Participation, institutional structure, regulatory framing |
| `ethical_model` | Responsibility, trust, value-based reasoning |
| `systemic_model` | Interdependence, feedback loops, mechanism thinking |
| `adaptive_model` | Iteration, feedback, continuous adjustment |
| `dialectical_model` | Opposition → synthesis cycles; contradiction-driven |
| `hybrid_framework` | Multiple structural modes active simultaneously |

For each framework, the system extracts:

- **Core Principles** — each concept classified as `foundation` / `driver` / `balancer` / `emergent` / `constraint`
- **Structural Relationships** — directed relations between concepts: `requires` / `limits` / `stabilizes` / `amplifies` / `balances`
- **Reasoning Pattern** — how the discussion evolved: `conflict_resolution` / `dialectical_synthesis` / `recursive_adaptation` / `system_balancing` / `incremental_refinement`
- **Generated Perspective** — the new viewpoint the discussion produced, not a summary

> A cognitive framework is not a summary of what was said.  
> It is a model of what kind of thinking the discussion generated.

---

### Convergence Freeze Detection

Monitors for structural stagnation:

| Freeze Type | Trigger |
|---|---|
| `branch_frozen` | Repeated identical semantic defense, argument entropy collapsed |
| `semantic_convergence` | Actor keyword similarity exceeded threshold (>0.88) |
| `discussion_exhausted` | Novelty fully depleted + dominant branch still surviving |

When detected, discussion terminates automatically with a structured explanation.

---

### Evolution Pressure System

Tracks each actor's contribution to reasoning evolution:

- **Innovation Moments** — proposals that introduced genuinely new conceptual territory
- **Actor Momentum** — weighted sum of refine / concede / synthesize actions
- **Semantic Decay Actors** — actors whose repeated defense lowered the discussion's novelty rate

Actors with high defend-only ratios are flagged as reducing evolution pressure.

---

### Segment-Based Continuation

When a user interjects during a discussion:

1. Current evaluator scores reset — the new segment is evaluated independently
2. A new discussion segment begins with fresh novelty/convergence tracking
3. Conclusions, key concepts, and unresolved conflicts from prior segments persist as **memory context** injected into AI prompts

Each segment receives isolated analysis. The Analysis Modal shows:
- Per-segment tabs with independent branch/novelty/convergence data
- A unified **통합 분析** tab with Meta Evolution across segments

---

### Meta Evolution Analysis

Analyzes how reasoning evolved across segments (when multiple interjections occurred):

- **Concept Transitions** — which concepts persisted, which were abandoned, which were introduced
- **Topic Shift Type** — `refinement` / `pivot` / `expansion` / `contradiction` / `synthesis`
- **Interjection Impact** — whether user intervention redirected, constrained, or validated the discussion

---

## Analysis Modal

After each discussion, the Analysis Modal presents structured layers:

```
┌─────────────────────────────────────────┐
│  Cognitive Framework                    │  ← what thinking model emerged
│  (type · principles · relationships ·  │
│   reasoning pattern · perspective)      │
├─────────────────────────────────────────┤
│  Evolutionary Resolution                │  ← structural conclusion
│  (type · trajectory · tensions)         │
├─────────────────────────────────────────┤
│  Question Evolution                     │  ← how the question transformed
│  (drift type · emergent question ·      │
│   actor lock/redirect)                  │
├─────────────────────────────────────────┤
│  Meta Evolution  [multi-segment only]   │  ← segment-to-segment shifts
├─────────────────────────────────────────┤
│  ▼ Full Analysis (collapsed)            │
│    · Convergence Flow                   │
│    · Branch Survival                    │
│    · Argument Graph                     │
│    · Concept Gravity                    │
│    · Structural Consensus Map           │
│    · Semantic Loop / Repeated Frames    │
│    · Evolution Pressure                 │
└─────────────────────────────────────────┘
```

<!-- Analysis UI screenshots would go here -->

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Electron 28 + Node.js |
| Framework | electron-vite 5 |
| UI | React 19 + TypeScript |
| AI Providers | OpenAI GPT / Anthropic Claude / Google Gemini |
| Build | Vite 7, TypeScript 6 |

All analysis runs locally — no external analysis API.  
AI providers are used only for generating proposals; all reasoning analysis is computed in-process.

---

## Project Structure

```
gcpt/
├── src/
│   ├── live-orchestrator.ts        # live discussion engine, phase control
│   ├── analysis.ts                 # analysis pipeline coordinator
│   ├── cognitive-framework.ts      # framework type detection + extraction
│   ├── final-resolution.ts         # evolutionary resolution builder
│   ├── question-evolution.ts       # question drift + emergent question
│   ├── meta-evolution.ts           # segment-level meta analysis
│   ├── semantic-loop.ts            # pseudo-debate + structural consensus
│   ├── concept-gravity.ts          # concept influence scoring
│   ├── branch-survival.ts          # reasoning lineage tracking
│   ├── argument-graph.ts           # argument relation graph
│   ├── convergence-freeze.ts       # entropy collapse detection
│   ├── evolution-pressure.ts       # actor momentum + innovation moments
│   ├── synthesis.ts                # consensus synthesis
│   ├── novelty-tracker.ts          # round-by-round novelty rates
│   ├── phase-controller.ts         # discussion phase management
│   ├── consensus-evaluator.ts      # convergence verdict engine
│   ├── final-conclusion.ts         # final conclusion resolver (legacy)
│   ├── types.ts                    # all shared types
│   └── workers/
│       ├── gpt.ts / claude.ts / gemini.ts
│       └── segment-context.ts      # memory context builder
│
└── app/renderer/src/
    ├── AnalysisModal.tsx            # 7-layer analysis modal
    ├── CognitiveFrameworkView.tsx   # framework type + principles + relations
    ├── FinalResolutionView.tsx      # resolution type + trajectory + tensions
    ├── QuestionEvolutionView.tsx    # question drift + emergent question
    ├── MetaEvolutionView.tsx        # segment transition view
    ├── StructuralAnalysisView.tsx   # semantic loop + concept gravity + map
    └── ArgumentGraphView.tsx        # argument graph visualization
```

---

## Setup

### Requirements
- Node.js 18+
- npm 9+

### Install

```bash
git clone https://github.com/cksdud32/gcpt.git
cd gcpt
npm install
```

### API Keys

```bash
cp .env.example .env
```

```env
OPENAI_API_KEY=sk-...       # GPT
GEMINI_API_KEY=             # Gemini
ANTHROPIC_API_KEY=          # Claude
```

All three providers are optional. Any missing key falls back to a mock worker. The mock mode covers the full analysis pipeline — all reasoning analysis features work without API keys.

### Run

```bash
npm run app           # development
npm run dist:win      # Windows production build
```

---

## Usage

### Mock Mode (no API keys required)

1. Launch app → select scenario from sidebar (normal / delay / stress / mixed)
2. Run → discussion completes automatically
3. Open **Analysis Modal** → explore cognitive framework, question evolution, branch survival

### Live Discussion

1. Toggle `Live OFF` → `Live ON`
2. Select active AI providers (GPT / Claude / Gemini)
3. Enter a topic → discussion begins
4. Optionally interject mid-discussion → new segment starts
5. After completion → explore full analysis stack

---

## Recent Updates

| System | Description |
|---|---|
| **Cognitive Framework Extraction** | Detects framework type from debate structure; extracts principles, relationships, reasoning pattern, generated perspective |
| **Evolutionary Resolution** | Structure-based final conclusion replacing winner selection; transformed / synthesized / stable / dynamic-tension types |
| **Question Evolution Layer** | Semantic centroid comparison, emergent question generation, per-revision pressure classification, actor lock detection |
| **Semantic Loop Collapse** | Pseudo-debate detection, structural consensus extraction, auto-termination on convergence |
| **Branch Survival Resolver** | Refine/concede/synthesize lineage tracking; semantic persistence and innovation retention scoring |
| **Evolution Pressure System** | Actor momentum tracking, innovation moment detection, semantic decay flagging |
| **Convergence Freeze Detection** | Entropy collapse + novelty exhaustion; branch_frozen / semantic_convergence / discussion_exhausted |
| **Segment Continuation** | Evaluator reset per segment, reasoning memory propagation, isolated per-segment analysis |
| **Meta Evolution Analysis** | Segment-to-segment concept transition, interjection impact, topic shift classification |
| **Provider Control** | Independent enable/disable per provider, API key separation, per-provider model selection |

---

## GitHub Repository

**Short description:**  
Experimental reasoning evolution engine for tracking branch survival, question drift, and cognitive framework generation.

**Long description:**  
GCPT is an experimental multi-agent reasoning system focused on evolutionary resolution rather than winner selection. It analyzes how arguments evolve, how questions transform, and what cognitive frameworks emerge through structured AI discussion.

**Suggested topics:**  
`ai` `multi-agent` `reasoning` `argumentation` `cognitive-framework` `semantic-analysis` `evolutionary-systems` `llm` `typescript` `electron`

---

## Notes

- `.env` files with real API keys must never be committed — `.gitignore` covers this but verify manually
- Alpha stage — internal APIs may change without notice
- API usage incurs cost depending on provider tier and discussion length
- All reasoning analysis (branch survival, framework extraction, etc.) runs locally without additional API calls

---

## License

MIT — see [LICENSE](LICENSE)
