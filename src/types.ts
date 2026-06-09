export type Author = "user" | "gpt" | "claude" | "gemini" | "system";

export type DiscussionMode = "general" | "development" | "idea";

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
