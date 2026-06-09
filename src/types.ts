export type Author = "user" | "gpt" | "claude" | "gemini" | "system";

export type DiscussionMode = "general" | "development" | "idea";

// ─── Discussion Budget ────────────────────────────────────────────

export type DiscussionDepth = "fast" | "balanced" | "deep" | "manual";

export interface DiscussionBudget {
  maxRoundsPerWorker: number; // AI 워커 1개당 최대 발언 횟수
  autoConsensus: boolean;     // false = 사용자가 직접 결론 확정
}

export const DEPTH_BUDGETS: Record<DiscussionDepth, DiscussionBudget> = {
  fast:     { maxRoundsPerWorker: 1, autoConsensus: true  },
  balanced: { maxRoundsPerWorker: 2, autoConsensus: true  }, // 현재 기본값
  deep:     { maxRoundsPerWorker: 5, autoConsensus: true  },
  manual:   { maxRoundsPerWorker: 5, autoConsensus: false },
};

export const DEPTH_LABELS: Record<DiscussionDepth, string> = {
  fast:     "빠르게",
  balanced: "보통",
  deep:     "깊게",
  manual:   "수동",
};

// --- Payload 타입 분리 (discriminated union) ---

export interface SetGoalPayload {
  type: "set_goal";
  goal: string;
  mode?: DiscussionMode; // 미입력 시 "general"로 처리
}

export interface ProposeDecisionPayload {
  type: "propose_decision";
  value: string;
  reason: string;
}

export interface ProposeAlternativePayload {
  type: "propose_alternative";
  value: string;
  reason: string;
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

export type TypedPayload =
  | SetGoalPayload
  | ProposeDecisionPayload
  | ProposeAlternativePayload
  | SelectOptionPayload
  | ConsensusReachedPayload
  | UserOverridePayload
  | UserInterjectionPayload;

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

export type TopicStatus = "active" | "decided" | "reopened" | "overridden" | "closed";

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
