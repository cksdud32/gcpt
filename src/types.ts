export type Author = "user" | "gpt" | "claude";

// --- Payload 타입 분리 (discriminated union) ---

export interface SetGoalPayload {
  type: "set_goal";
  goal: string;
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

export interface UserOverridePayload {
  type: "user_override";
  goal?: string;
}

export type TypedPayload =
  | SetGoalPayload
  | ProposeDecisionPayload
  | ProposeAlternativePayload
  | SelectOptionPayload
  | UserOverridePayload;

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

export type TopicStatus = "active" | "decided" | "overridden" | "closed";

export interface Proposal {
  revisionId: number;
  author: Author;
  content: ProposeDecisionPayload | ProposeAlternativePayload;
  rationale?: string;
}

export interface Topic {
  goal: string;
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
