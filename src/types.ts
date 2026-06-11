export type Author = "user" | "gpt" | "claude" | "gemini" | "system";

// ─── Provider Settings ────────────────────────────────────────────

export interface ProviderSettings {
  enabled: boolean;
  apiKey:  string;
  model:   string;
}

export interface ProvidersConfig {
  gpt:    ProviderSettings;
  claude: ProviderSettings;
  gemini: ProviderSettings;
}

export const DEFAULT_PROVIDER_MODELS: Record<keyof ProvidersConfig, string> = {
  gpt:    "gpt-4o-mini",
  claude: "claude-haiku-4-5-20251001",
  gemini: "gemini-2.5-flash",
};

export type DiscussionMode = "general" | "development" | "idea";

// ─── Discussion Budget ────────────────────────────────────────────

/** 토론 길이 — 결론 확정 방식과 무관 */
export type DiscussionDepth = "fast" | "balanced" | "deep" | "until_consensus";

/** 결론 확정 방식 — 토론 길이와 무관 */
export type ConsensusMode = "auto" | "manual";

export interface DiscussionBudget {
  maxRoundsPerWorker:   number; // AI 워커 1개당 최대 발언 횟수
  maxDistinctProposals: number; // actor당 신규 후보 제안 가능 횟수 (초과 시 defend/concede로 전환)
  stabilityMode:        boolean; // true = 높은 임계값으로 수렴 판단 (until_consensus 전용)
  safetyTimeoutMs:      number;  // 전체 세션 강제 종료 한도 (ms)
}

export const DEPTH_BUDGETS: Record<DiscussionDepth, DiscussionBudget> = {
  fast:            { maxRoundsPerWorker:  1, maxDistinctProposals: 1, stabilityMode: false, safetyTimeoutMs: 10 * 60 * 1000 },
  balanced:        { maxRoundsPerWorker:  2, maxDistinctProposals: 2, stabilityMode: false, safetyTimeoutMs: 10 * 60 * 1000 },
  deep:            { maxRoundsPerWorker:  5, maxDistinctProposals: 3, stabilityMode: false, safetyTimeoutMs: 10 * 60 * 1000 },
  until_consensus: { maxRoundsPerWorker: 20, maxDistinctProposals: 3, stabilityMode: true,  safetyTimeoutMs: 30 * 60 * 1000 },
};

export const DEPTH_LABELS: Record<DiscussionDepth, string> = {
  fast:            "빠르게",
  balanced:        "보통",
  deep:            "깊게",
  until_consensus: "합의 도달",
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

// 오케스트레이터 자동 수렴 — 실제 사용자 선택과 구분
export interface ConsensusReachedPayload {
  type: "consensus_reached";
  selected: string; // 승리 제안의 value
  winner: Author;   // 승리 제안의 author (gpt/gemini/claude)
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
  reason: "user_stop" | "safety_limit" | "timeout";
}

/**
 * until_consensus 모드 교착 상태 경고 — topic은 계속 "active"
 * AI 발언이 아닌 engine이 판정해 append; 사용자에게 중지 여부 선택지 제공
 */
export interface DiscussionDeadlockPayload {
  type:   "discussion_deadlock";
  reason: string;
}

export type TypedPayload =
  | SetGoalPayload
  | ProposeDecisionPayload
  | ProposeAlternativePayload
  | SelectOptionPayload
  | ConsensusReachedPayload
  | UserOverridePayload
  | UserInterjectionPayload
  | DiscussionPausedPayload
  | DiscussionDeadlockPayload;

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
  content: ProposeDecisionPayload | ProposeAlternativePayload;
  rationale?: string;
}

export interface Topic {
  goal: string;
  mode?: DiscussionMode;     // set_goal payload에서 복사 (없으면 "general")
  startRevId: number;        // 이 topic의 set_goal revision id
  status: TopicStatus;
  proposals: Proposal[];
  selectedOption: {
    revisionId: number;
    selectedBy: Author;
    content: ProposeDecisionPayload | ProposeAlternativePayload;
  } | null;
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
