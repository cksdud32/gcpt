# GCPT

**Experimental AI reasoning evolution engine — tracks branch survival, question drift, and cognitive framework generation through structured multi-agent discussion.**

> ⚠️ **Alpha / Experimental Build**  
> 연구 및 구조 실험 목적으로 개발 중입니다. API 없이도 Mock mode로 전체 기능을 체험할 수 있습니다.

---

## 소개

GCPT는 "AI들이 결론을 뽑아내는 앱"이 아닙니다.

토론이 진행되는 동안:
- 질문 자체가 어떻게 변형되는가 (Question Evolution)
- 어떤 논리 branch가 살아남고 어떤 것이 소멸하는가 (Branch Survival)
- 토론 전체가 어떤 사고 구조를 만들어냈는가 (Cognitive Framework Extraction)

를 추적하는 **실험적 reasoning evolution 시스템**입니다.

결론은 "승자 선택"이 아니라 **"토론 구조 전체가 어떤 형태로 수렴했는가"** 로 표현됩니다.

---

## Evolution Flow

```
Question (초기 질문)
  ↓
Multi-AI Debate
  (GPT · Claude · Gemini 논증 / 반박 / 양보)
  ↓
Branch Evolution
  (살아남는 논리 계보 vs 흡수·소멸되는 논거)
  ↓
Question Drift
  (초기 질문이 어떻게 변형되는가)
  ↓
Structural Consensus
  (표면 불일치 이면의 공유 구조 수렴)
  ↓
Cognitive Framework Extraction
  (토론이 생성한 사고 구조 모델)
  ↓
Evolutionary Resolution
  (진화 결론 — winner가 아닌 구조적 수렴)
```

---

## 핵심 개념

### Branch Survival
각 proposal은 독립적인 논리 branch로 추적됩니다. refine / concede / synthesize 연결을 통해 살아남은 branch와 흡수·소멸된 branch를 분석합니다. 최종 결론은 "가장 많이 득표한 것"이 아니라 "논리 계보상 가장 강하게 살아남은 것"을 기반으로 합니다.

### Question Evolution
초기 질문(Goal)과 후반 surviving structure의 semantic centroid를 비교해 논점이 어떻게 이동했는지 분류합니다.

- `stable_topic` — 원래 질문 유지
- `reframed_topic` — 같은 질문, 다른 관점
- `shifted_topic` — 논의 중심축 이동
- `transformed_topic` — 질문 자체가 새 질문으로 진화

Emergent Question을 자동 생성해 "토론이 실제로 답하려 한 질문"을 추출합니다.

### Structural Consensus
AI들이 표면적으로 여전히 대립하더라도, 실제로는 동일한 개념 구조를 공유하고 있을 수 있습니다. Semantic Loop 감지를 통해 표면 불일치 이면의 구조 수렴을 탐지합니다.

### Cognitive Framework Extraction
토론 전체가 형성한 사고 구조 모델을 추출합니다.

| Framework Type | 의미 |
|---|---|
| `governance_model` | 참여·제도·구조 기반 조율 프레임 |
| `ethical_model` | 책임·가치·신뢰 중심 프레임 |
| `systemic_model` | 상호의존적 시스템 메커니즘 프레임 |
| `adaptive_model` | 피드백·실험·지속 적응 프레임 |
| `dialectical_model` | 대립 → 합성 반복 변증법 프레임 |
| `hybrid_framework` | 복합 사고 구조 |

각 framework는 핵심 원리(foundation / driver / balancer / emergent / constraint), 개념 간 관계망(requires / limits / stabilizes / amplifies / balances), reasoning pattern을 포함합니다.

### Evolutionary Resolution
최종 결론 유형:

| Resolution Type | 의미 |
|---|---|
| `transformed_resolution` | 질문 자체가 진화한 후 도달한 결론 |
| `synthesized_resolution` | 복수 입장의 합성으로 도달 |
| `stable_answer` | 수렴 명확, 초기 질문 유지 |
| `unresolved_dynamic_tension` | 긴장 유지 — 합의 없음이 결론 |

### Convergence Freeze Detection
argument entropy가 붕괴하고 novelty가 지속 소진될 때 자동 감지합니다.

- `branch_frozen` — 동일 semantic defend 반복
- `semantic_convergence` — actor 간 의미 유사도 과수렴
- `discussion_exhausted` — novelty 완전 소진 + 지배 branch 생존

### Semantic Loop Collapse
actor들이 표면적으로 계속 대립하지만 실제 의미 drift가 거의 없는 상태(pseudo-debate)를 감지해 자동 종료합니다.

### Evolution Pressure System
각 AI actor의 논리 진화 기여도를 추적합니다. defend 반복 비율이 높은 actor는 semantic decay로 표시되고, refine / concede / synthesize 중심의 actor는 evolution driver로 집계됩니다.

### Segment-Based Continuation
사용자가 토론 중간에 개입(Interjection)하면 새 segment가 시작됩니다.

- 이전 segment의 evaluator score는 리셋
- 이전 segment의 결론·핵심 개념·미해결 충돌은 memory context로 유지
- segment별 독립 분석 + 통합 meta-evolution 분석 제공

---

## 분석 시스템 (Analysis Modal)

토론 종료 후 열리는 분석 화면은 다음 레이어를 표시합니다:

| 레이어 | 내용 |
|---|---|
| **생성된 사고 프레임** | cognitive framework type, 핵심 원리, 개념 관계망, reasoning pattern, 생성된 관점 |
| **최종 진화 구조** | resolution type, primary conclusion, 논리 진화 궤적, 미해결 긴장 |
| **질문 진화** | 초기 → 중간 → emergent question, 신규/소멸 개념, actor lock/redirect |
| **Meta Evolution** | segment 간 사고 흐름 변화, concept transition, interjection 영향 |
| **논리 수렴 과정** | novelty decay, convergence history, phase flow |
| **생존 Branch** | dominant branch, semantic persistence, innovation retention |
| **Argument Graph** | 논거 간 관계 그래프, synthesis lineage |
| **Concept Gravity** | 토론을 지배한 개념 ranking |
| **Structural Consensus Map** | 표면 충돌 vs 공유 구조 시각화 |

---

## 기술 스택

| 분류 | 기술 |
|---|---|
| 런타임 | Electron 28 + Node.js |
| 프레임워크 | electron-vite 5 |
| UI | React 19 + TypeScript |
| AI | OpenAI GPT / Anthropic Claude / Google Gemini |
| 빌드 | Vite 7, TypeScript 6 |

---

## 실행 방법

### 요구 사항
- Node.js 18+
- npm 9+

### 설치

```bash
git clone https://github.com/cksdud32/gcpt.git
cd gcpt
npm install
```

### API 키 설정

```bash
cp .env.example .env
# .env 파일에 API 키 입력
```

API 키 없이도 Mock mode로 모든 기능을 체험할 수 있습니다.

### 개발 모드

```bash
npm run app
```

### 프로덕션 빌드

```bash
npm run dist:win   # Windows 패키지
npm run app:build  # 일반 빌드
```

---

## API 키 설정

```env
OPENAI_API_KEY=sk-...       # GPT 실제 응답
GEMINI_API_KEY=             # Gemini 실제 응답
ANTHROPIC_API_KEY=          # Claude 실제 응답
```

키가 없는 경우 해당 AI는 자동으로 Mock worker로 대체됩니다.

---

## 사용 가이드

### Mock Mode (API 키 불필요)

1. 앱 실행 → 좌측 사이드바에서 시나리오 선택 (normal / delay / stress 등)
2. `▶ 실행` 클릭
3. 토론 종료 후 `분석 보기` → 생성된 사고 프레임, 질문 진화, 논리 궤적 확인

### Live Discussion Mode

1. `⚡ Live OFF` → `⚡ Live ON` 전환
2. 활성화할 AI 선택 (GPT / Claude / Gemini)
3. 주제 입력 후 실행
4. 토론 중 `Interjection`으로 개입 → 새 segment 시작
5. 종료 후 분석 모달에서 evolution layer 탐색

---

## 프로젝트 구조

```
gcpt/
├── app/
│   ├── main/         # Electron main process (IPC 핸들러)
│   ├── preload/      # contextBridge API
│   └── renderer/     # React UI
│       └── src/
│           ├── AnalysisModal.tsx      # 분석 모달 (7-layer)
│           ├── CognitiveFrameworkView.tsx
│           ├── FinalResolutionView.tsx
│           ├── QuestionEvolutionView.tsx
│           ├── MetaEvolutionView.tsx
│           ├── StructuralAnalysisView.tsx
│           └── ArgumentGraphView.tsx
└── src/
    ├── live-orchestrator.ts      # Live 토론 엔진
    ├── analysis.ts               # 분석 파이프라인 통합
    ├── cognitive-framework.ts    # Cognitive Framework Extraction
    ├── final-resolution.ts       # Evolutionary Resolution
    ├── question-evolution.ts     # Question Evolution Layer
    ├── meta-evolution.ts         # Segment-level Meta Evolution
    ├── semantic-loop.ts          # Semantic Loop / Pseudo-debate Detection
    ├── concept-gravity.ts        # Concept Gravity System
    ├── branch-survival.ts        # Branch Survival Resolver
    ├── argument-graph.ts         # Argument Graph Builder
    ├── convergence-freeze.ts     # Convergence Freeze Detection
    ├── evolution-pressure.ts     # Evolution Pressure System
    ├── synthesis.ts              # Consensus Synthesis
    └── final-conclusion.ts       # Final Conclusion Resolver
```

---

## Recent Updates

| 버전 | 추가 내용 |
|---|---|
| Cognitive Framework | 토론이 생성한 사고 프레임 추출 — frameworkType / corePrinciples / structuralRelationships / reasoningPattern / generatedPerspective |
| Evolutionary Resolution | winner 선택 대신 진화 구조 기반 최종 결론 — transformed / synthesized / stable / unresolved_dynamic_tension |
| Question Evolution Layer | 초기 vs 후반 semantic centroid 비교, emergent question 생성, question pressure per-revision, actor lock detection |
| Branch Survival Resolver | refine/concede/synthesize lineage 기반 branch 생존 분석, semantic persistence / innovation retention 점수화 |
| Cognitive Framework | 위 참조 |
| Evolution Pressure System | actor별 논리 진화 기여도, semantic decay actor 감지, innovation moment 추적 |
| Convergence Freeze Detection | entropy collapse + novelty 소진 → branch_frozen / semantic_convergence / discussion_exhausted 분류 |
| Segment-based Continuation | 사용자 개입 → 새 segment, evaluator 리셋, 이전 reasoning memory 유지 |
| Meta Evolution Analysis | segment 간 concept transition, interjection 영향, topicShiftType 분류 |
| Semantic Loop Collapse | pseudo-debate 감지, structural consensus 추출, 자동 종료 |
| Structural Analysis | SemanticLoopView / ConceptGravityView / StructuralMapView |
| Provider Control | GPT / Claude / Gemini ON/OFF, API key 분리, 모델 선택 |

---

## Known Issues

- **한글 콘솔 출력 깨짐**: Windows 기본 터미널에서 한글 로그가 깨질 수 있습니다. Windows Terminal 또는 `chcp 65001` 권장.
- **Gemini parseFail**: 응답이 길어질 경우 드물게 파싱 실패. 토론 흐름에는 영향 없음.
- **API Rate Limit**: 무료 티어 사용 시 RPM 제한으로 일부 응답이 스킵될 수 있습니다.

---

## 주의사항

- `.env` 파일에 API 키 입력 시 **절대로 Git에 커밋하지 마세요**
- `.gitignore`에 `.env`가 포함되어 있으나 주의 필요
- API 사용에 따른 과금이 발생할 수 있습니다
- 이 프로젝트는 Alpha 단계의 실험적 빌드입니다

---

## 라이선스

MIT License — [LICENSE](LICENSE) 참조
