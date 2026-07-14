export type Author = "user" | ProviderName | "system";

// ─── Provider Settings ────────────────────────────────────────────

export interface ProviderSettings {
  enabled: boolean;
  apiKey:  string;
  model:   string;
  apiName?: string;
  endpoint?: string;
  authMethod?: "bearer" | "api-key" | "custom-header";
  customHeader?: string;
  /** Optional dot/bracket path used to extract text from a Custom API response. */
  responsePath?: string;
}

export interface ProvidersConfig {
  testMode: boolean;
  gpt:    ProviderSettings;
  claude: ProviderSettings;
  gemini: ProviderSettings;
  grok: ProviderSettings;
  glm: ProviderSettings;
  deepseek: ProviderSettings;
  custom: ProviderSettings;
}

export type ProviderName = Exclude<keyof ProvidersConfig, "testMode">;

export const DEFAULT_PROVIDER_MODELS: Record<ProviderName, string> = {
  gpt:    "gpt-5-mini",
  claude: "claude-haiku-4-5-20251001",
  gemini: "gemini-2.5-flash",
  grok: "grok-3-mini",
  glm: "glm-4.5-flash",
  deepseek: "deepseek-chat",
  custom: "",
};

export type DiscussionMode = "general" | "development" | "idea";

export type InteractionStyle = "debate" | "conversation";

// ─── Discussion Budget ────────────────────────────────────────────

/**
 * 논리 진화 단계 — "몇 번 토론할 것인가"가 아니라 "어느 단계까지 진화를 허용할 것인가"
 */
export type DiscussionDepth =
  | "quick_conclusion"      // 빠른 결론: 첫 합의 또는 safety limit 도달 시 종료
  | "structural_convergence" // 구조 수렴까지: AI들이 공통 사고 구조를 형성할 때까지 (기본값)
  | "question_evolution"    // 질문 변화까지: 질문 자체가 reframed/shifted/transformed 감지 시 종료
  | "deep_evolution";       // 심층 진화: 논리 진화를 최대한 탐색 후 수렴 또는 safety limit 종료

/** 결론 확정 방식 — 토론 길이와 무관 */
export type ConsensusMode = "auto" | "manual";

/** 종료 목표 조건 */
export type TargetCondition =
  | "first_consensus"       // 첫 합의 또는 round limit
  | "structural_convergence" // convergence_freeze / pseudo_convergence / soft_consensus
  | "question_drift"        // 질문 변화 감지 시 종료
  | "exhaustive";           // 최대 진화 후 수렴 또는 limit

export interface DiscussionBudget {
  maxRoundsPerWorker:   number;          // AI 워커 1개당 최대 발언 횟수
  maxDistinctProposals: number;          // actor당 신규 후보 제안 가능 횟수 (초과 시 defend/concede로 전환)
  stabilityMode:        boolean;         // true = 높은 임계값으로 수렴 판단
  safetyTimeoutMs:      number;          // 전체 세션 강제 종료 한도 (ms)
  safetyLimitEnabled:   boolean;         // false = safety_limit verdict 무시
  targetCondition:      TargetCondition; // 이 모드의 종료 목표
}

export const DEPTH_BUDGETS: Record<DiscussionDepth, DiscussionBudget> = {
  quick_conclusion:      { maxRoundsPerWorker:  2, maxDistinctProposals: 2, stabilityMode: false, safetyTimeoutMs: 10 * 60 * 1000, safetyLimitEnabled: true, targetCondition: "first_consensus"       },
  structural_convergence:{ maxRoundsPerWorker:  8, maxDistinctProposals: 3, stabilityMode: true,  safetyTimeoutMs: 15 * 60 * 1000, safetyLimitEnabled: true, targetCondition: "structural_convergence" },
  question_evolution:    { maxRoundsPerWorker: 15, maxDistinctProposals: 4, stabilityMode: true,  safetyTimeoutMs: 20 * 60 * 1000, safetyLimitEnabled: true, targetCondition: "question_drift"        },
  deep_evolution:        { maxRoundsPerWorker: 30, maxDistinctProposals: 5, stabilityMode: true,  safetyTimeoutMs: 30 * 60 * 1000, safetyLimitEnabled: true, targetCondition: "exhaustive"            },
};

/** 모드별 최소 proposal 수 — 이 수를 충족하기 전에는 force-terminate 외 종료 불가 */
export const MIN_PROPOSALS_BY_TARGET: Record<TargetCondition, number> = {
  first_consensus:        2,
  structural_convergence: 8,
  question_drift:         8,
  exhaustive:             12,
};

export const DEPTH_LABELS: Record<DiscussionDepth, string> = {
  quick_conclusion:       "빠른 결론",
  structural_convergence: "구조 수렴까지",
  question_evolution:     "질문 변화까지",
  deep_evolution:         "심층 진화",
};

export const CONSENSUS_LABELS: Record<ConsensusMode, string> = {
  auto:   "자동 수렴",
  manual: "수동 채택",
};

// --- Payload 타입 분리 (discriminated union) ---

export interface SetGoalPayload {
  type: "set_goal";
  goal: string;
  mode?: DiscussionMode; // 미입력 시 "general"로 처리
  interactionStyle?: InteractionStyle; // 미입력 시 "debate"로 처리
}

/** AI 발언의 의도 분류 — evaluator가 보조 증거로 사용 */
export type StanceAction = "defend" | "refine" | "concede" | "propose";

export interface ProposeDecisionPayload {
  type: "propose_decision";
  value: string;
  reason: string;
  stanceAction?: StanceAction;
}

export interface ProposeAlternativePayload {
  type: "propose_alternative";
  value: string;
  reason: string;
  stanceAction?: StanceAction;
}

export interface SelectOptionPayload {
  type: "select_option";
  selected: string;
}

export type ConvergenceSource = "auto_evaluator" | "manual_policy" | "manual_select";
export type ConfidenceKind = "analysis" | "evaluator";

// 오케스트레이터 자동 수렴 — 실제 사용자 선택과 구분
export interface ConsensusReachedPayload {
  type: "consensus_reached";
  selected: string; // 승리 제안의 value
  winner: Author;   // 승리 제안의 author (gpt/gemini/claude)
  convergenceSource?: ConvergenceSource;
  confidenceKind?: ConfidenceKind;
  isMockAffected?: boolean;
}

/**
 * 최초 합의 기록 — selectedOption 설정만 수행, topic.status는 "active" 유지.
 * quick_conclusion 이외 모드에서 첫 consensus 감지 시 append.
 * 이후 targetCondition 달성 시 discussion_paused로 최종 종료.
 */
export interface InitialConsensusNotedPayload {
  type:              "initial_consensus_noted";
  selected:          string;
  winner:            Author;
  convergenceSource: ConvergenceSource;
}

export interface UserOverridePayload {
  type: "user_override";
  goal?: string;
}

export interface UserInterjectionPayload {
  type: "user_interjection";
  message: string;
}

/** until_consensus 모드에서 사용자가 [토론 중지] 누를 때 append */
export interface DiscussionPausedPayload {
  type:   "discussion_paused";
  reason: "user_stop" | "safety_limit" | "timeout" | "hard_timeout"
        | "stagnation"           // 새 논거 소진 — semantic loop 자동 종료
        | "soft_consensus"       // 어휘는 달라도 의미 프레임이 수렴
        | "consensus_saturated"  // 합의 포화: novelty 소진 + 고수렴 자동 종료
        | "conversation_end"     // 대화 모드: 지정 턴 수 완료 후 자동 종료
        | "branch_frozen"        // 동일 semantic defend 반복 → argument entropy 붕괴
        | "semantic_convergence" // actor간 의미 유사도 > 0.88 고수렴 확정
        | "discussion_exhausted"      // novelty 완전 소진 + 지배 branch 생존 → 수렴 완료
        | "pseudo_convergence"        // 표면 불일치 이면 구조 수렴 (semantic loop)
        | "question_drift_detected";  // 질문 변화 감지 — question_evolution 모드 종료
}

/**
 * until_consensus 모드 교착 상태 경고 — topic은 계속 "active"
 * AI 발언이 아닌 engine이 판정해 append; 사용자에게 중지 여부 선택지 제공
 */
export interface DiscussionDeadlockPayload {
  type:   "discussion_deadlock";
  reason: string;
}

/** Conversation Mode 전용 — debate 구조 없음, value만 존재 */
export interface ChatReplyPayload {
  type:  "chat_reply";
  value: string;
}

export type TypedPayload =
  | SetGoalPayload
  | ProposeDecisionPayload
  | ProposeAlternativePayload
  | SelectOptionPayload
  | ConsensusReachedPayload
  | InitialConsensusNotedPayload
  | UserOverridePayload
  | UserInterjectionPayload
  | DiscussionPausedPayload
  | DiscussionDeadlockPayload
  | ChatReplyPayload;

// --- Patch ---

export type PatchType = TypedPayload["type"];

export interface Patch {
  type: PatchType;
  references?: readonly number[];
  payload: TypedPayload;
  rationale?: string;
}

// --- Revision ---

export interface Revision {
  id: number;
  parent: number | null;
  author: Author;
  timestamp: string;
  patch: Patch;
}

// --- Rebuilt State ---

export type TopicStatus = "active" | "decided" | "reopened" | "overridden" | "closed" | "paused";

export interface Proposal {
  revisionId: number;
  author: Author;
  content: ProposeDecisionPayload | ProposeAlternativePayload | ChatReplyPayload;
  rationale?: string;
}

// ─── Discussion Segment ───────────────────────────────────────────

/**
 * 하나의 토론 세션 단위.
 * 첫 세그먼트는 set_goal부터, 이후 세그먼트는 user_interjection부터 시작.
 * 평가 점수(aggregation, branch, entropy 등)는 세그먼트 범위 안에서만 계산.
 */
export interface DiscussionSegment {
  segmentId:           number;    // 1-based
  startRevisionId:     number;    // set_goal revId(seg1) 또는 user_interjection revId(seg2+)
  endRevisionId?:      number;    // 세그먼트 종료 revision (undefined = 현재 진행 중)
  proposalRevisionIds: number[];  // 이 세그먼트에 속한 proposal revId 목록
}

/**
 * 이전 세그먼트에서 추출한 기억 컨텍스트.
 * AI worker prompt에 주입되지만 score 계산에는 직접 가산하지 않음.
 */
export interface SegmentMemoryContext {
  previousConclusions:  string[];  // segment별 finalConclusion.text
  survivingBranches:    string[];  // dominantBranch.finalProposalValue
  keyConcepts:          string[];  // 핵심 공유 키워드
  unresolvedQuestions:  string[];  // 미해결 충돌 축
  segmentCount:         number;    // 완료된 세그먼트 수
}

export interface Topic {
  goal: string;
  mode?: DiscussionMode;              // set_goal payload에서 복사 (없으면 "general")
  interactionStyle?: InteractionStyle; // set_goal payload에서 복사 (없으면 "debate")
  startRevId: number;                 // 이 topic의 set_goal revision id
  status: TopicStatus;
  proposals: Proposal[];
  selectedOption: {
    revisionId: number;
    selectedBy: Author;
    content: ProposeDecisionPayload | ProposeAlternativePayload;
    convergenceSource?: ConvergenceSource;
    confidenceKind?: ConfidenceKind;
    isMockAffected?: boolean;
  } | null;
  // ── Segment tracking ──────────────────────────────────────────
  segments:                  DiscussionSegment[];   // 세그먼트 이력 (항상 최소 1개)
  currentSegmentStartRevId:  number;                // 현재 평가 윈도우 시작 revId
  memoryContext?:            SegmentMemoryContext;  // 이전 세그먼트 기억
}

export interface State {
  topics: Topic[];
}

// ─── Proposal Aggregation ─────────────────────────────────────────

// ─── Stance Transition History ───────────────────────────────────

export interface StanceShift {
  from:       string;   // 변경 전 original value
  to:         string;   // 변경 후 original value
  revisionId: number;   // 변경이 일어난 revision id
}

export interface ActorStanceHistory {
  actor:   Author;
  current: string;        // 가장 최근 지지 value (original)
  trail:   string[];      // 변화 지점만 기록한 흐름 (RLE: 연속 동일 값 축약)
  shifts:  StanceShift[]; // shift 발생 목록
}

// ─── Proposal Aggregation ─────────────────────────────────────────

export interface AggregatedSupporter {
  author:    Author;
  count:     number;   // 이 value를 언급한 횟수
  lastRevId: number;   // 가장 최근 언급 revision id
}

export interface AggregatedProposal {
  value:        string;               // 정규화 전 원본 (첫 등장 케이스 유지)
  normalKey:    string;               // 정규화된 키 (비교/그룹용)
  score:        number;               // mentions + recency bonus
  mentions:     number;               // 총 등장 횟수
  supporters:   AggregatedSupporter[]; // 지지 actor 목록 (count 내림차순)
  latestReason: string;               // 가장 최근 reason
  firstRevId:   number;
  lastRevId:    number;
  isSelected:   boolean;              // 현재 selectedOption과 일치
}

// ─── Discussion Analysis ──────────────────────────────────────────

export interface ActorPosition {
  actor:        Author;
  corePosition: string;  // 마지막 지지 proposal value
  premise:      string;  // 마지막 proposal reason (전제)
}

export interface DeadlockAnalysis {
  actorPositions: ActorPosition[];
  conflictPoint:  string;   // 핵심 충돌 지점
  whyNoConsensus: string;   // 합의 실패 원인 설명
}

export interface ProgressDriver {
  actor:      Author;
  score:      number;       // concede/refine 가중치 합
  highlights: string[];     // 진전 기여 발언 요약
}

export interface RepetitionPattern {
  actor: Author;
  value: string;
  count: number;
}

export interface NoveltyHighlight {
  actor:     Author;
  value:     string;
  rationale: string;  // 새 논거가 담긴 rationale 요약
}

export interface UnresolvedConflict {
  dimension: string;                               // 공유 키워드 클러스터 (논쟁 축)
  positions: { actor: Author; stance: string }[];  // 축별 각 actor 최종 입장
}

// ─── Repetition Cluster ──────────────────────────────────────────

export interface RepetitionCluster {
  canonical:  string;      // 대표 문장 (첫 등장 원본)
  actors:     Author[];
  count:      number;
  revisions:  number[];    // 관련 revisionId 목록
}

// ─── Consensus Saturation ─────────────────────────────────────────

export interface ConsensusSaturation {
  saturated:           boolean;
  confidence:          number;   // 0–1
  reason:              string;
  repetitionClusters:  RepetitionCluster[];
}

// ─── Final Conclusion ─────────────────────────────────────────────

/**
 * "누가 이겼는가"가 아니라 "토론이 실제로 어디까지 진화했는가"를 표현하는
 * analysis-layer 결론. selectedOption(revision winner)과 분리된다.
 */
export interface FinalConclusion {
  text:               string;
  source:             "selected_option" | "synthesized_consensus" | "hybrid" | "surviving_branch" | "structural_consensus";
  confidence:         number;        // 0–1
  basedOnRevisionIds: number[];      // 결론 형성에 기여한 revision ID 목록
  reason:             string;        // 결론 선택 이유 (사용자 표시용)
}

// ─── Discussion Phase ─────────────────────────────────────────────

export type DiscussionPhase =
  | "initial_position"
  | "cross_critique"
  | "refinement"
  | "convergence_attempt"
  | "finalization";

export interface PhaseState {
  phase:         DiscussionPhase;
  startRound:    number;
  roundsInPhase: number;
}

export interface PhaseFlowSummary {
  phase:       DiscussionPhase;
  rounds:      number;
  keyEvent:    string;
  noveltyMean: number;
}

// ─── Argument Graph ──────────────────────────────────────────────

export type ArgumentRelation =
  | "supports"
  | "criticizes"
  | "refines"
  | "concedes"
  | "synthesizes"
  | "repeats";

/** Argument Graph의 단일 노드 — 하나의 proposal에 대응 */
export interface ArgumentNode {
  id:             string;            // "n-{revisionId}"
  revisionId:     number;
  actor:          Author;
  text:           string;            // proposal value
  keywords:       string[];
  stanceAction?:  StanceAction;
  influenceScore: number;            // 0–1, 정규화된 영향력 점수
}

/** 두 ArgumentNode 사이의 방향 관계 */
export interface ArgumentEdge {
  from:     string;                  // node id
  to:       string;                  // node id
  relation: ArgumentRelation;
}

/** topic 전체의 논거 그래프 */
export interface ArgumentGraph {
  nodes: ArgumentNode[];
  edges: ArgumentEdge[];
}

/** 그래프에서 추출한 논리 진화 요약 */
export interface ArgumentEvolution {
  dominantChain:        ArgumentNode[];   // 가장 긴 진화 체인 (refines/concedes/synthesizes)
  mostAbsorbedConcept:  string;           // 가장 많이 흡수된 논거 텍스트
  highestInfluenceNode: ArgumentNode | null;
  collapseLoops:        string[][];       // 순환 비판 루프 (node id 쌍)
  synthesisLineage:     ArgumentNode[];   // highestInfluenceNode까지의 역추적 조상 체인
}

// ─── Consensus Synthesis ─────────────────────────────────────────

/** 복수 actor가 late-phase에서 공유한 키워드 */
export interface SharedConcept {
  keyword:    string;
  actors:     Author[];   // 이 키워드를 사용한 actor 목록
  frequency:  number;     // 전체 proposal에서의 등장 횟수
  firstActor: Author;     // 처음 도입한 actor
}

/** actor A가 actor B의 논거를 자신의 후기 발언에 흡수한 사례 */
export interface AbsorbedArgument {
  from:       Author;     // 원 도입 actor
  by:         Author;     // 흡수한 actor
  concept:    string;     // 흡수된 키워드
  revisionId: number;     // 흡수가 일어난 proposal의 revisionId
}

/**
 * revision winner 선택이 아닌,
 * 토론 전체 흐름에서 형성된 합성 결론 구조.
 */
export interface SynthesizedConsensus {
  text:                  string;     // 합성 결론 문장
  confidence:            number;     // 0–1 신뢰도
  basis:                 "convergence" | "late_concede" | "dominant" | "fallback";
  sharedConcepts:        SharedConcept[];    // actor 간 공유된 핵심 개념
  absorbedArguments:     AbsorbedArgument[]; // 논거 흡수 사례
  unresolvedKeywords:    string[];           // late-phase에서 한 actor만 유지한 키워드
  synthesisNote:         string;             // 합성 형성 과정 설명
  synthesisQualityScore?: number;            // 0–1 최종 합성 품질 점수
}

// ─── Branch Survival ─────────────────────────────────────────────

/** refine/concede 연결로 형성된 논리 계보 단위 */
export interface ReasoningBranch {
  id:                   string;
  rootRevisionId:       number;
  latestRevisionId:     number;
  revisionIds:          number[];
  actors:               string[];
  sharedConcepts:       string[];
  branchSummary:        string;
  convergenceScore:     number;   // 0–1
  survivalScore:        number;   // 0–1 (최종 생존 점수)
  concedeDepth:         number;   // concede 엣지 수
  refineDepth:          number;   // refine 엣지 수
  semanticPersistence:  number;   // 평균 influenceScore
  innovationRetention:  number;   // 0–1
  repeatedDefenseRatio: number;   // 0–1 (높을수록 bad)
  finalProposalValue:   string;   // 최종 생존 proposal 텍스트
  dominant:             boolean;
}

export interface BranchSurvivalAnalysis {
  branches:               ReasoningBranch[];
  dominantBranch?:        ReasoningBranch;
  branchEvolutionSummary: string;
}

// ─── Convergence Freeze ──────────────────────────────────────────

export type ConvergenceFreezeType = "branch_frozen" | "semantic_convergence" | "discussion_exhausted";

/** revision별 의미 novelty 점수 */
export interface ProposalNoveltyScore {
  revisionId:      number;
  novelty:         number;   // 0–1 (새 키워드 비율 × stance shift 보너스)
  newKeywordCount: number;
  totalKeywords:   number;
  stanceShift:     boolean;  // 이전 발언과 stanceAction이 달라졌으면 true
}

/** Convergence Freeze 감지 결과 */
export interface ConvergenceFreezeAnalysis {
  frozen:                    boolean;
  freezeType?:               ConvergenceFreezeType;
  frozenAtRevisionId?:       number;   // freeze 조건이 처음 충족된 revision
  argumentEntropy:           number;   // 0–1 Shannon 정규화 (낮을수록 붕괴)
  lastMeaningfulRevisionId?: number;   // novelty > 0.15인 마지막 revision
  noveltyScores:             ProposalNoveltyScore[];
  entropyCollapseRevisionId?: number;  // entropy가 임계 아래로 처음 내려간 revision
  convergenceMoment?:        string;   // 수렴 완료 설명 (사용자 표시용)
  reason:                    string;
}

// ─── Evolution Pressure ───────────────────────────────────────────

/** 논리 진화의 핵심 혁신 순간 */
export interface InnovationMoment {
  revisionId:  number;
  actor:       Author;
  score:       number;    // 0–1
  description: string;
}

/** actor별 논리 진화 기여도 */
export interface ActorEvolutionMomentum {
  actor:  Author;
  score:  number;    // 0-1+
  events: string[];  // 발전 이벤트 목록
}

/** 토론 전체의 Evolution Pressure 분석 */
export interface EvolutionPressureAnalysis {
  stagnationLevel:     number;                  // 0-1: defend 반복 기반 정체 비율
  actorMomentum:       ActorEvolutionMomentum[];
  innovationMoments:   InnovationMoment[];
  semanticDecayActors: string[];                // 고반복 defend로 감쇠된 actor 목록
}

// ─── Cognitive Framework ─────────────────────────────────────────

export type FrameworkType =
  | "governance_model"
  | "ethical_model"
  | "systemic_model"
  | "adaptive_model"
  | "dialectical_model"
  | "hybrid_framework";

export type PrincipleRole =
  | "foundation"   // 토론 전반을 지탱하는 핵심 기반
  | "constraint"   // 다른 개념을 제한/조건화
  | "balancer"     // 대립 축을 조율
  | "driver"       // 논점 이동을 추진
  | "emergent";    // 후반에 새로 등장

export type RelationType =
  | "requires"    // A는 B를 필요로 함
  | "limits"      // A는 B를 제한함
  | "stabilizes"  // A는 B를 안정화함
  | "amplifies"   // A는 B를 강화함
  | "balances";   // A는 B와 균형을 이룸

export type ReasoningPatternType =
  | "conflict_resolution"       // 대립 → 해소
  | "system_balancing"          // 복수 축 균형 유지
  | "incremental_refinement"    // 점진적 정교화
  | "dialectical_synthesis"     // 변증법적 합성
  | "recursive_adaptation";     // 반복 적응

export interface FrameworkPrinciple {
  concept:           string;
  role:              PrincipleRole;
  influence:         number;       // 0–1
  supportedByActors: string[];
}

export interface StructuralRelationship {
  from:       string;
  to:         string;
  relation:   RelationType;
  confidence: number;  // 0–1
}

export interface ReasoningPattern {
  type:        ReasoningPatternType;
  confidence:  number;
  description: string;
}

export interface CognitiveFramework {
  frameworkType:             FrameworkType;
  frameworkName:             string;
  corePrinciples:            FrameworkPrinciple[];
  structuralRelationships:   StructuralRelationship[];
  reasoningPattern:          ReasoningPattern;
  dominantWorldview:         string;
  generatedPerspective:      string;
  frameworkSummary:          string;
}

// ─── Final Resolution ────────────────────────────────────────────

export type ResolutionType =
  | "stable_answer"              // 수렴 명확, 초기 질문 유지
  | "synthesized_resolution"     // 복수 입장 합성으로 도달
  | "transformed_resolution"     // 질문 자체가 진화한 후 도달
  | "unresolved_dynamic_tension"; // 긴장 유지 상태

export interface EvolutionaryTrajectoryStage {
  stage:     number;
  axis:      string;    // 논리 축 (예: "AI 협력론 vs 인간 통제론")
  dominant?: string;    // 이 단계를 지배한 개념/방향
  keyShift?: string;    // 다음 단계로 넘어간 핵심 전환 (마지막 단계엔 없음)
}

export interface ResolutionTension {
  axis:          string;
  sideA:         string;
  sideB:         string;
  whyUnresolved: string;
}

export interface FinalResolution {
  resolutionType:           ResolutionType;
  primaryConclusion:        string;          // 표시용 핵심 결론
  dominantStructure:        string;          // 최종 지배 구조 텍스트
  survivingBranches:        string[];
  emergentQuestion?:        string;
  structuralConsensusCore?: string[];
  evolutionaryTrajectory:   EvolutionaryTrajectoryStage[];
  unresolvedTensions:       ResolutionTension[];
  confidence:               number;          // 0–1
  source:                   string;
}

// ─── Question Evolution Layer ─────────────────────────────────────

export type TopicDriftType =
  | "stable_topic"
  | "reframed_topic"
  | "shifted_topic"
  | "transformed_topic";

export type QuestionPressureType =
  | "preserve_question"
  | "reframe_question"
  | "expand_question"
  | "redirect_question"
  | "replace_question";

export interface QuestionPressureEntry {
  revisionId:    number;
  actor:         Author;
  pressureType:  QuestionPressureType;
  proposalValue: string;
}

export interface QuestionLockActor {
  actor:           Author;
  preserveRatio:   number;  // 0–100
  totalPressures:  number;
}

export interface QuestionEvolutionStep {
  stage:          "initial" | "middle" | "emergent";
  questionText:   string;
  keywords:       string[];
  driftFromPrev?: number;  // 0–100, 이전 단계 대비 의미 이동률
}

export interface QuestionEvolutionAnalysis {
  initialQuestion:       string;
  emergentQuestion:      string;
  driftType:             TopicDriftType;
  driftPercent:          number;   // 0–100
  sharedConceptOverlap:  number;   // 0–100 (Jaccard × 100)
  newlyDominantConcepts: string[];
  vanishedConcepts:      string[];
  evolutionPath:         QuestionEvolutionStep[];
  questionPressures:     QuestionPressureEntry[];
  lockedActors:          QuestionLockActor[];
  dominantRedirectActor?: Author;
  transformationStage:   string;
}

export interface DiscussionAnalysis {
  summary:           string;
  outcome:           "decided" | "deadlock" | "paused";
  dominantStance:    string;
  dominantReason:    string;
  stanceChanges:     ActorStanceHistory[];
  repetitions:       RepetitionPattern[];
  noveltyHighlights: NoveltyHighlight[];
  progressDrivers:   ProgressDriver[];
  consensusReason?:  string;
  deadlockAnalysis?: DeadlockAnalysis;
  // ── 품질 지표 (Phase 1) ──────────────────────────────────────
  noveltyDecayRates:   number[];
  convergenceHistory:  number[];
  stagnationRounds:    number;
  unresolvedConflicts: UnresolvedConflict[];
  softConsensusNote?:  string;
  // ── 합성 결론 ─────────────────────────────────────────────
  synthesizedConsensus?: SynthesizedConsensus;
  // ── 수렴 포화 감지 ───────────────────────────────────────
  saturation?:           ConsensusSaturation;
  repetitionClusters?:   RepetitionCluster[];
  // ── 최종 결론 (selectedOption과 분리된 진화 결론) ────────
  finalConclusion?:      FinalConclusion;
  // ── Argument Graph Layer ──────────────────────────────
  argumentGraph?:        ArgumentGraph;
  argumentEvolution?:    ArgumentEvolution;
  // ── Branch Survival ───────────────────────────────────
  branchSurvival?:       BranchSurvivalAnalysis;
  // ── Convergence Freeze ────────────────────────────────
  convergenceFreeze?:    ConvergenceFreezeAnalysis;
  // ── Evolution Pressure ────────────────────────────────
  evolutionPressure?:    EvolutionPressureAnalysis;
  // ── Semantic Loop ─────────────────────────────────────
  semanticLoop?:         SemanticLoopAnalysis;
  // ── Concept Gravity ───────────────────────────────────
  conceptGravity?:       ConceptGravityMap;
  // ── Structural Consensus ──────────────────────────────
  structuralConsensus?:  StructuralConsensus;
  // ── Question Evolution ────────────────────────────────
  questionEvolution?:    QuestionEvolutionAnalysis;
  // ── Final Resolution (최상위 진화 결론) ───────────────
  finalResolution?:      FinalResolution;
  // ── Cognitive Framework ───────────────────────────────
  cognitiveFramework?:   CognitiveFramework;
}

/**
 * Segment 단위 분석 뷰 — AnalysisModal의 세그먼트 탭 렌더링용.
 * evaluator/score는 해당 segment revision 범위 내에서만 계산됨.
 */
export interface SegmentAnalysisView {
  segmentId:             number;
  startRevisionId:       number;
  endRevisionId?:        number;
  proposalRevisionIds:   number[];   // segment 범위 내 proposal revision id 목록
  analysis:              DiscussionAnalysis;
  interjectionMessage?:  string;     // 이 segment를 시작한 user_interjection 메시지 (seg1은 undefined)
  summary?: {
    dominantConclusion?: string;
    convergenceType?:    string;
    survivingBranch?:    string;
  };
}

// ─── Meta Evolution Analysis ─────────────────────────────────────
// 세그먼트 간 사고 흐름 변화를 분석하는 meta-layer.
// "어떤 결론이 이겼는가"가 아니라 "논점이 어떻게 이동했는가"를 보여줌.

export type TopicShiftType =
  | "refinement"    // 동일 프레임 내 정교화
  | "pivot"         // 핵심 논점 교체
  | "expansion"     // 논의 범위 확장
  | "contradiction" // 이전 결론과 상충
  | "synthesis";    // 복수 입장 통합

export interface MetaEvolutionStage {
  segmentId:          number;
  dominantConclusion: string;
  dominantKeywords:   string[];
  convergenceType?:   string;
  survivingBranch?:   string;
  entropy?:           number;
}

export interface ConceptTransition {
  fromSegment:        number;
  toSegment:          number;
  persistedConcepts:  string[];
  abandonedConcepts:  string[];
  introducedConcepts: string[];
  semanticShiftScore: number;   // 0.0 ~ 1.0 (높을수록 큰 전환)
}

export interface InterjectionImpact {
  segmentId:               number;
  interjection:            string;
  impactType:
    | "topic_redirect"
    | "constraint_addition"
    | "scope_expansion"
    | "perspective_shift";
  changedConcepts:         string[];
  reasoningImpactSummary:  string;
}

export interface MetaEvolutionAnalysis {
  evolutionStages:       MetaEvolutionStage[];
  topicShiftType:        TopicShiftType;
  dominantEvolutionPath: string[];   // 결론 텍스트 흐름 (Seg1→Seg2→…)
  conceptTransitions:    ConceptTransition[];
  interjectionImpacts:   InterjectionImpact[];
  metaSummary:           string;
  finalMetaConclusion:   string;
}

// ─── Semantic Loop Analysis ───────────────────────────────────────
// 표면 불일치 이면에 의미 수렴이 이미 일어난 "pseudo-debate" 상태 탐지

export interface RepeatedFrame {
  concept:     string;
  actors:      string[];
  repeatCount: number;
  firstRound:  number;
  lastRound:   number;
}

export interface SemanticLoopAnalysis {
  isPseudoDebate:          boolean;
  semanticDriftScore:      number;        // 0=완전 루프, 1=활발한 이동
  sharedCoreConcepts:      string[];      // 양측이 공통 사용하는 핵심 개념
  repeatedFrames:          RepeatedFrame[];
  collapseReason?:         string;
  pseudoDebateStartRound?: number;
  loopRevisionRange?:      { from: number; to: number };
}

// ─── Concept Gravity ─────────────────────────────────────────────
// "누가 이겼는가"가 아니라 "무슨 개념이 토론을 지배했는가" 분석

export interface ConceptGravityEntry {
  concept:                string;
  gravityScore:           number;
  firstActor:             string;
  survivedRounds:         number;
  adoptersCount:          number;
  concedeInfluence:       number;     // 이 개념이 concede를 유발한 횟수
  synthesisParticipation: boolean;    // 합성 결론에 포함됐는지
}

export interface ConceptGravityMap {
  topConcepts:     ConceptGravityEntry[];
  dominantConcept: string;
  gravityNote:     string;
}

// ─── Structural Consensus ────────────────────────────────────────
// 표면 충돌 이면의 공유 구조 추출

export interface SurfaceConflict {
  actor:                       string;
  surfacePosition:             string;
  sharedStructureContribution: string[];
}

export interface StructuralConsensus {
  sharedStructure:  string[];
  surfaceConflicts: SurfaceConflict[];
  structuralNote:   string;
}
