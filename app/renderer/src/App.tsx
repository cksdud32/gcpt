import { useState, useMemo, useEffect, useRef, Component, Fragment } from "react";
import type { ReactNode, ErrorInfo, PointerEvent as ReactPointerEvent } from "react";
import type { RunResult } from "../../../src/test-modes";
import type { Author, Revision, Topic, Proposal, DiscussionDepth, ConsensusMode, DiscussionAnalysis, InteractionStyle, ConvergenceSource } from "../../../src/types";
import { DEPTH_LABELS, CONSENSUS_LABELS } from "../../../src/types";
import { analyzeDiscussion } from "../../../src/analysis";
import { AnalysisModal } from "./AnalysisModal";
import type { Metrics } from "../../../src/metrics";
import { computeAggregation, computeStances, computeStanceHistory, normalizeProposal } from "../../../src/aggregation";
import type { WorkspacePlan, WorkspacePlanStep } from "../../../src/workspace-providers";

// ─── Session 파일 형식 ────────────────────────────────────────────

interface Session {
  version:  "1";
  type?:    "gcpt-session" | "gcpt-topic-session";
  savedAt:  string;
  mode:     string;
  goals:    string[];
  summary: {
    revisionCount: number;
    decided:       number;
    undecided:     number;
    gptCalls:      number;
    claudeCalls:   number;
  };
  metrics:   Metrics;
  topics:    Topic[];
  revisions: Revision[];
  editLog?:  WsLogEntry[];
}

// ─── Topic → Workspace 연결 컨텍스트 ────────────────────────────────

interface TopicContext {
  goal:          string;
  selectedValue: string;
  selectedBy:    string;
  alternatives:  Array<{ value: string; author: string }>;
  mode?:         DiscussionMode;
}

// ─── Workspace 타입 ───────────────────────────────────────────────

interface WsLogEntry {
  id: number;
  type: "file_edit_proposed" | "file_edit_applied";
  relativePath: string;
  summary: string;
  timestamp: string;
}

interface WsChatMessage {
  id:        number;
  role:      "user" | "assistant";
  content:   string;
  timestamp: string;
  type?:     "system";
}

type DiffLine = { type: "same" | "add" | "remove"; text: string };

interface WsEditorState {
  workspacePath:   string | null;
  files:           string[];
  skipped:         number;
  selectedFile:    string | null;
  original:        string | null;
  proposed:        string | null;
  proposeSummary:  string;
  expandedFolders: Set<string>;
}

const WS_EDITOR_INITIAL: WsEditorState = {
  workspacePath:   null,
  files:           [],
  skipped:         0,
  selectedFile:    null,
  original:        null,
  proposed:        null,
  proposeSummary:  "",
  expandedFolders: new Set(),
};

type FileTreeNode =
  | { type: "folder"; name: string; path: string; children: FileTreeNode[] }
  | { type: "file";   name: string; path: string };
type WorkspaceFallbackReason = "missing_api_key" | "provider_error";

declare global {
  interface Window {
    api: {
      // Engine
      runMode:     (mode: string, dm: DiscussionMode)     => Promise<RunResult>;
      runCustom:   (goalText: string, dm: DiscussionMode) => Promise<RunResult>;
      runAll:      ()                 => Promise<RunResult[]>;
      saveSession: (json: string)     => Promise<{ canceled: boolean; filePath?: string }>;
      loadSession: () => Promise<
        | { ok: true;  content: string }
        | { ok: false; canceled?: boolean; error?: string }
      >;
      // Workspace
      selectWorkspace: () => Promise<
        | { canceled: true }
        | { canceled: false; workspacePath: string }
      >;
      scanWorkspace: (workspacePath: string) => Promise<{ files: string[]; skipped: number }>;
      readWorkspaceFile: (workspacePath: string, relativePath: string) => Promise<
        | { ok: true; content: string }
        | { ok: false; error: string }
      >;
      writeWorkspaceFile: (workspacePath: string, relativePath: string, content: string) => Promise<
        | { ok: true }
        | { ok: false; error: string }
      >;
      workspaceChat: (payload: {
        messages:     { role: "user" | "assistant"; content: string }[];
        linkedTopic?: TopicContext;
      }) => Promise<
        | { ok: true;  content: string; provider: "claude" | "mock"; fallbackReason?: WorkspaceFallbackReason }
        | { ok: false; error: string }
      >;
      generateWorkspacePlan: (payload: {
        linkedTopic?: TopicContext;
      }) => Promise<
        | { ok: true;  plan: WorkspacePlan; provider: "claude" | "mock"; fallbackReason?: WorkspaceFallbackReason }
        | { ok: false; error: string }
      >;
      // Provider Settings
      getProviderSettings: () => Promise<ProvidersConfig>;
      saveProviderSettings: (s: ProvidersConfig) => Promise<{ ok: boolean; error?: string }>;
      testProviderConnection: (p: "gpt" | "claude" | "gemini") => Promise<{ ok: boolean; latency?: number; error?: string }>;
      // Live Discussion
      startLiveDiscussion: (payload: {
        goals: string[];
        mode?: DiscussionMode;
        depth?: DiscussionDepth;
        consensusMode?: ConsensusMode;
        safetyLimitEnabled?: boolean;
      }) => Promise<{ ok: boolean; error?: string }>;
      sendInterjection:    (payload: { message: string; safetyLimitEnabled?: boolean }) => Promise<{ ok: boolean }>;
      stopDiscussion:      ()                     => Promise<{ ok: boolean }>;
      acceptConsensus:     ()                     => Promise<{ ok: boolean }>;
      selectProposal:      (revisionId: number)  => Promise<{ ok: boolean }>;
      onFirstRun:         (cb: () => void) => () => void;
      onDiscussionUpdate: (cb: (u: { history: Revision[]; topics: Topic[] }) => void) => () => void;
      onDiscussionStatus: (cb: (msg: string) => void) => () => void;
      onDiscussionDone:   (cb: (result: RunResult | null) => void) => () => void;
    };
  }
}

// ─── Mock 편집 로직 ───────────────────────────────────────────────

function mockEdit(
  relativePath: string,
  content: string,
): { result: string; summary: string } | { error: string } {
  const ext = relativePath.split(".").pop()?.toLowerCase() ?? "";
  const date = new Date().toISOString().slice(0, 10);

  if (["ts", "tsx", "js", "jsx"].includes(ext)) {
    const changes: string[] = [];
    let proposed = content;

    if (!proposed.startsWith("// [gcpt mock]")) {
      proposed = `// [gcpt mock] reviewed: ${date}\n` + proposed;
      changes.push("헤더 주석 추가");
    }

    const before = proposed;
    proposed = proposed.replace(/^(\s*)console\.log\(/gm, "$1// console.log(");
    if (proposed !== before) changes.push("console.log 주석 처리");

    if (!proposed.includes("// TODO:")) {
      proposed = proposed.trimEnd() + "\n// TODO: 코드 리뷰 후 확인하세요\n";
      changes.push("TODO 주석 추가");
    }

    return { result: proposed, summary: changes.join(", ") || "변경 없음" };
  }

  if (ext === "json") {
    try {
      const parsed = JSON.parse(content);
      const result = JSON.stringify(parsed, null, 2) + "\n";
      return { result, summary: result === content ? "변경 없음" : "JSON pretty formatting 적용" };
    } catch {
      return { error: "JSON 파싱 실패 — 수정 제안을 만들 수 없습니다" };
    }
  }

  if (ext === "md") {
    const changes: string[] = [];
    let proposed = content;

    if (!proposed.match(/^#\s+/m)) {
      proposed = `# 문서 제목\n\n${proposed}`;
      changes.push("제목 추가");
    }

    if (!proposed.includes("_Generated by gcpt mock editor_")) {
      proposed = proposed.trimEnd() + "\n\n---\n_Generated by gcpt mock editor_\n";
      changes.push("푸터 추가");
    }

    return { result: proposed, summary: changes.join(", ") || "변경 없음" };
  }

  if (ext === "css") {
    const changes: string[] = [];
    let proposed = content;

    if (!proposed.startsWith("/* [gcpt mock]")) {
      proposed = `/* [gcpt mock] reviewed: ${date} */\n` + proposed;
      changes.push("헤더 주석 추가");
    }

    if (!proposed.includes("/* TODO:")) {
      proposed = proposed.trimEnd() + "\n/* TODO: 미사용 스타일을 정리하세요 */\n";
      changes.push("TODO 주석 추가");
    }

    return { result: proposed, summary: changes.join(", ") || "변경 없음" };
  }

  if (ext === "html") {
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const header = `<!-- [gcpt mock] reviewed: ${date} -->`;
    if (normalized.startsWith("<!-- [gcpt mock] reviewed:")) {
      return { result: normalized, summary: "변경 없음" };
    }
    return { result: `${header}\n${normalized}`, summary: "헤더 주석 추가" };
  }

  return { result: content, summary: "지원되지 않는 파일 형식 — 변경 없음" };
}

// ─── Diff 계산 ────────────────────────────────────────────────────

const normalizeForDiff = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);

  const path: DiffLine[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) {
      path.push({ type: "same",   text: a[i-1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      path.push({ type: "add",    text: b[j-1] }); j--;
    } else {
      path.push({ type: "remove", text: a[i-1] }); i--;
    }
  }
  return path.reverse();
}

function computeDiff(original: string, proposed: string): DiffLine[] {
  const oldNorm = normalizeForDiff(original);
  const newNorm = normalizeForDiff(proposed);
  const a = oldNorm.split("\n");
  const b = newNorm.split("\n");

  // LCS: max(m,n) ≤ 1200 — 1000줄 파일에 1~2줄 추가/삭제 케이스 포함 (1.44M ops, ~10ms)
  if (Math.max(a.length, b.length) <= 1200) return lcsDiff(a, b);

  // 초대형 파일 positional fallback (삽입/삭제가 없는 in-place 수정 전용)
  const result: DiffLine[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (i >= a.length)      result.push({ type: "add",    text: b[i] });
    else if (i >= b.length) result.push({ type: "remove", text: a[i] });
    else if (a[i] === b[i]) result.push({ type: "same",   text: a[i] });
    else { result.push({ type: "remove", text: a[i] }); result.push({ type: "add", text: b[i] }); }
  }
  return result;
}

// ─── File Tree ────────────────────────────────────────────────────

function buildTree(files: string[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const folderMap = new Map<string, FileTreeNode & { type: "folder" }>();

  for (const file of files) {
    const parts = file.split("/");
    let siblings = root;
    let cumPath = "";

    for (let i = 0; i < parts.length - 1; i++) {
      cumPath = cumPath ? `${cumPath}/${parts[i]}` : parts[i];
      if (!folderMap.has(cumPath)) {
        const node: FileTreeNode & { type: "folder" } = {
          type: "folder", name: parts[i], path: cumPath, children: [],
        };
        folderMap.set(cumPath, node);
        siblings.push(node);
      }
      siblings = folderMap.get(cumPath)!.children;
    }

    siblings.push({ type: "file", name: parts[parts.length - 1], path: file });
  }

  return root;
}

// ─── Session accumulation helpers ────────────────────────────────

type CallMetrics = { total: number; parseOk: number; parseFail: number; apiError: number };

function addCallMetrics(a: CallMetrics, b: CallMetrics): CallMetrics {
  return {
    total:     a.total     + b.total,
    parseOk:   a.parseOk   + b.parseOk,
    parseFail: a.parseFail + b.parseFail,
    apiError:  a.apiError  + b.apiError,
  };
}

// 두 RunResult를 뒤에 append — revision ID를 offset 적용해 충돌 방지
function mergeResult(existing: RunResult, incoming: RunResult): RunResult {
  const maxId = existing.history.length > 0
    ? Math.max(...existing.history.map(r => r.id))
    : 0;

  const reId    = (id: number)        => id + maxId;
  const reIdOpt = (id: number | null) => id !== null ? id + maxId : null;

  const offsetRevisions: Revision[] = incoming.history.map(rev => ({
    ...rev,
    id:     reId(rev.id),
    parent: reIdOpt(rev.parent),
    patch: {
      ...rev.patch,
      references: rev.patch.references ? [...rev.patch.references].map(reId) : undefined,
    },
  }));

  const offsetTopics: Topic[] = incoming.topics.map(topic => ({
    ...topic,
    startRevId: reId(topic.startRevId),
    proposals: topic.proposals.map(p => ({ ...p, revisionId: reId(p.revisionId) })),
    selectedOption: topic.selectedOption
      ? { ...topic.selectedOption, revisionId: reId(topic.selectedOption.revisionId) }
      : null,
  }));

  const m1 = existing.metrics;
  const m2 = incoming.metrics;
  const noCall: CallMetrics = { total: 0, parseOk: 0, parseFail: 0, apiError: 0 };

  return {
    mode:          "accumulated",
    revisionCount: existing.revisionCount + incoming.revisionCount,
    metrics: {
      calls: {
        gpt:    addCallMetrics(m1.calls.gpt,             m2.calls.gpt),
        claude: addCallMetrics(m1.calls.claude,          m2.calls.claude),
        gemini: addCallMetrics(m1.calls.gemini ?? noCall, m2.calls.gemini ?? noCall),
      },
      latencyMs: [...m1.latencyMs, ...m2.latencyMs],
      tokens:    { prompt: m1.tokens.prompt + m2.tokens.prompt, completion: m1.tokens.completion + m2.tokens.completion },
      topics:    { decided: m1.topics.decided + m2.topics.decided, undecided: m1.topics.undecided + m2.topics.undecided },
    },
    history: [...existing.history, ...offsetRevisions],
    topics:  [...existing.topics,  ...offsetTopics],
  };
}

// 특정 topic과 해당 revision 범위를 제거한 새 RunResult 반환
function deleteTopicFromResult(result: RunResult, localIdx: number): RunResult {
  const topics = result.topics;
  const ranges = topics.map((t, i) => ({
    startId: t.startRevId,
    endId:   i + 1 < topics.length ? topics[i + 1].startRevId : Infinity,
  }));
  const { startId, endId } = ranges[localIdx];

  const newHistory = result.history.filter(r => r.id < startId || r.id >= endId);
  const newTopics  = topics.filter((_, i) => i !== localIdx);
  const decided    = newTopics.filter(t => t.status === "decided").length;
  const undecided  = newTopics.filter(t => t.status !== "decided").length;

  return {
    ...result,
    revisionCount: newHistory.length,
    history: newHistory,
    topics:  newTopics,
    metrics: { ...result.metrics, topics: { decided, undecided } },
  };
}

// 누적 sessions에서 globalIdx가 속한 session과 local index를 반환
function findSessionForTopic(sessions: RunResult[], globalIdx: number): { sessionIdx: number; localIdx: number } | null {
  let cumulative = 0;
  for (let si = 0; si < sessions.length; si++) {
    const count = sessions[si].topics.length;
    if (globalIdx < cumulative + count)
      return { sessionIdx: si, localIdx: globalIdx - cumulative };
    cumulative += count;
  }
  return null;
}

// ─── Error Boundary ───────────────────────────────────────────────

interface EBState { hasError: boolean; message: string }

class ErrorBoundary extends Component<{ label: string; children: ReactNode }, EBState> {
  state: EBState = { hasError: false, message: "" };

  static getDerivedStateFromError(err: unknown): EBState {
    return { hasError: true, message: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(_err: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary:${this.props.label}]`, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="panel" style={{ color: "#f44", padding: 16 }}>
          <div className="panel-title">{this.props.label} — 렌더 오류</div>
          <div style={{ fontFamily: "monospace", fontSize: 12, marginTop: 8 }}>
            {this.state.message}
          </div>
          <button
            style={{ marginTop: 12 }}
            onClick={() => this.setState({ hasError: false, message: "" })}
          >
            재시도
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── Resizable Panels ─────────────────────────────────────────────

type ResizablePane = {
  id: string;
  minWidth: number;
  initialFlex: number;
  children: ReactNode;
};

function ResizablePanels({ panes }: { panes: ResizablePane[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const paneRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [widths, setWidths] = useState<number[] | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || widths) return;

    const styles = window.getComputedStyle(container);
    const horizontalPadding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
    const available = container.clientWidth - horizontalPadding - (panes.length - 1) * 18;
    if (available <= 0) return;

    setWidths(panes.map(p => Math.max(p.minWidth, Math.round(available * p.initialFlex))));
  }, [panes, widths]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !widths) return;

    const resizeObserver = new ResizeObserver(() => {
      const nextContainerWidth = container.clientWidth;
      const totalWidth = widths.reduce((sum, width) => sum + width, 0);
      const handleWidth = (panes.length - 1) * 18;
      const styles = window.getComputedStyle(container);
      const horizontalPadding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
      const available = nextContainerWidth - horizontalPadding - handleWidth;
      if (available <= 0 || totalWidth <= 0) return;

      const minTotal = panes.reduce((sum, pane) => sum + pane.minWidth, 0);
      if (available < minTotal) return;

      setWidths(prev => {
        if (!prev) return prev;
        const prevTotal = prev.reduce((sum, width) => sum + width, 0);
        if (prevTotal <= 0 || Math.abs(prevTotal - available) < 2) return prev;

        const scaled = prev.map((width, idx) => Math.max(panes[idx].minWidth, Math.round(width * available / prevTotal)));
        const diff = available - scaled.reduce((sum, width) => sum + width, 0);
        scaled[scaled.length - 1] += diff;
        return scaled;
      });
    });

    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [panes, widths]);

  function startResize(handleIdx: number, e: ReactPointerEvent<HTMLDivElement>) {
    if (window.matchMedia("(max-width: 900px)").matches) return;

    const leftEl = paneRefs.current[handleIdx];
    const rightEl = paneRefs.current[handleIdx + 1];
    if (!leftEl || !rightEl) return;

    e.preventDefault();
    const startX = e.clientX;
    const leftStart = leftEl.getBoundingClientRect().width;
    const rightStart = rightEl.getBoundingClientRect().width;
    const pairTotal = leftStart + rightStart;
    const leftMin = panes[handleIdx].minWidth;
    const rightMin = panes[handleIdx + 1].minWidth;

    function onPointerMove(ev: PointerEvent) {
      const dx = ev.clientX - startX;
      const nextLeft = Math.min(Math.max(leftStart + dx, leftMin), pairTotal - rightMin);
      const nextRight = pairTotal - nextLeft;

      setWidths(prev => {
        const base = prev ?? paneRefs.current.map(el => el?.getBoundingClientRect().width ?? 0);
        const next = [...base];
        next[handleIdx] = nextLeft;
        next[handleIdx + 1] = nextRight;
        return next;
      });
    }

    function finishResize() {
      document.body.classList.remove("is-resizing-panels");
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      window.removeEventListener("blur", finishResize);
    }

    document.body.classList.add("is-resizing-panels");
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishResize, { once: true });
    window.addEventListener("pointercancel", finishResize, { once: true });
    window.addEventListener("blur", finishResize, { once: true });
  }

  return (
    <div className="panels resizable-panels" ref={containerRef}>
      {panes.map((pane, idx) => (
        <Fragment key={pane.id}>
          <div
            className="resizable-pane"
            ref={el => { paneRefs.current[idx] = el; }}
            style={widths ? { flexBasis: widths[idx], minWidth: pane.minWidth } : { minWidth: pane.minWidth }}
          >
            {pane.children}
          </div>
          {idx < panes.length - 1 && (
            <div
              className="panel-resize-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label={`${pane.id} 패널 크기 조절`}
              onPointerDown={e => startResize(idx, e)}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}

// ─── 상수 ─────────────────────────────────────────────────────────

const MODES = ["normal", "parsefail", "apierror", "delay", "mixed", "stress"];
const LS_KEY = "gcpt-ws-state";
const LS_VER = 2;
const ONBOARDING_KEY = "gcpt-onboarding-seen-v1";
const DEMO_PLACEHOLDER_VALUES = new Set(["Option-A", "Option-B", "Option-C", "Alt-X", "Alt-Y", "Alt-Z"]);

type DemoResultMeta = {
  isDemo: boolean;
  hasPlaceholder: boolean;
};

function getConsensusSourceFromRevision(rev: Revision): ConvergenceSource {
  const payload = rev.patch.payload as { convergenceSource?: ConvergenceSource };
  if (payload.convergenceSource) return payload.convergenceSource;
  if (rev.patch.rationale === "User accepted best proposal (auto-policy)") return "manual_policy";
  if (rev.patch.rationale === "User directly selected this proposal") return "manual_select";
  return "auto_evaluator";
}

function getConsensusSourceLabel(source?: ConvergenceSource): string {
  if (source === "manual_policy") return "수동 채택";
  if (source === "manual_select") return "직접 선택";
  return "자동 수렴";
}

function getConsensusSourceDescription(source?: ConvergenceSource): string {
  if (source === "manual_policy") return "사용자가 현재 최고 점수 제안을 채택했습니다.";
  if (source === "manual_select") return "사용자가 이 제안을 직접 선택했습니다.";
  return "평가기가 합의 조건을 충족해 종료했습니다.";
}

function isKnownDemoMode(mode: string | undefined): boolean {
  if (!mode) return false;
  return mode === "custom" || MODES.includes(mode) || mode.startsWith("mock:");
}

function resultHasDemoPlaceholders(result: RunResult | null): boolean {
  if (!result) return false;
  return result.history.some(rev => {
    const payload = rev.patch.payload as { value?: unknown; selected?: unknown; goal?: unknown; message?: unknown };
    const value = typeof payload.value === "string"
      ? payload.value
      : typeof payload.selected === "string"
      ? payload.selected
      : "";
    return DEMO_PLACEHOLDER_VALUES.has(value);
  });
}

function getDemoResultMeta(result: RunResult | null): DemoResultMeta {
  const hasPlaceholder = resultHasDemoPlaceholders(result);
  const hasDemoMode = isKnownDemoMode(result?.mode);
  return {
    isDemo: hasDemoMode || hasPlaceholder,
    hasPlaceholder,
  };
}

// Live mode 실행 시 모드별 기본 goal 목록
const GOAL_SETS: Record<string, string[]> = {
  normal:    ["데이터베이스 기술 스택 결정"],
  parsefail: ["프레임워크 선택"],
  apierror:  ["배포 전략 결정"],
  delay:     ["인증 방식 선택"],
  mixed:     ["상태 관리 라이브러리 선택"],
  stress:    ["데이터베이스 기술 스택 결정", "프레임워크 선택"],
};

// Actor 메타데이터 — label + color (새 actor 추가 시 여기만 수정)
const ACTOR_META: Record<string, { label: string; color: string }> = {
  user:   { label: "사용자", color: "#858585" },
  gpt:    { label: "GPT",    color: "#4ec9b0" },
  claude: { label: "Claude", color: "#c586c0" },
  gemini: { label: "Gemini", color: "#f4a261" },
  system: { label: "최종 정리", color: "#6a9fb5" },
};
type PassMap = Record<string, "pass" | "fail" | null>;
type AppView = "engine" | "workspace";
type DiscussionMode = "general" | "development" | "idea";

interface ProviderSettings {
  enabled: boolean;
  apiKey:  string;
  model:   string;
}
interface ProvidersConfig {
  gpt:    ProviderSettings;
  claude: ProviderSettings;
  gemini: ProviderSettings;
}
type ProviderName = keyof ProvidersConfig;
const DEFAULT_PROVIDERS: ProvidersConfig = {
  gpt:    { enabled: false, apiKey: "", model: "gpt-5-mini" },
  claude: { enabled: false, apiKey: "", model: "claude-haiku-4-5-20251001" },
  gemini: { enabled: false, apiKey: "", model: "gemini-2.5-flash" },
};
const PROVIDER_NAMES: ProviderName[] = ["gpt", "claude", "gemini"];
const PROVIDER_LABELS: Record<ProviderName, string> = {
  gpt:    "GPT",
  claude: "Claude",
  gemini: "Gemini",
};

function runnableProviderNames(settings: ProvidersConfig): ProviderName[] {
  return PROVIDER_NAMES.filter(p => settings[p].enabled && !!settings[p].apiKey.trim());
}

function enabledProvidersWithoutApiKey(settings: ProvidersConfig): ProviderName[] {
  return PROVIDER_NAMES.filter(p => settings[p].enabled && !settings[p].apiKey.trim());
}

function formatProviderNames(providers: ProviderName[]): string {
  return providers.map(p => PROVIDER_LABELS[p]).join(", ");
}

const DISC_MODE_LABELS: Record<DiscussionMode, string> = {
  general:     "일반",
  development: "개발",
  idea:        "아이디어",
};

// ─── App ──────────────────────────────────────────────────────────

export default function App() {
  const [view,             setView]             = useState<AppView>("engine");
  const [selected,         setSelected]         = useState("normal");
  // 누적 세션 — 각 RunResult는 독립적인 토론 세션 (새 실행마다 append)
  const [sessions,         setSessions]         = useState<RunResult[]>([]);
  const [passMap,          setPassMap]          = useState<PassMap>({});
  const [running,          setRunning]          = useState(false);
  const [runLabel,         setRunLabel]         = useState("");
  const [selectedTopicIdx, setSelectedTopicIdx] = useState<number | null>(null);
  const [selectedRevId,    setSelectedRevId]    = useState<number | null>(null);
  const [customGoal,       setCustomGoal]       = useState("");
  const [sessionStatus,    setSessionStatus]    = useState<string>("");
  const [wsLog,         setWsLog]         = useState<WsLogEntry[]>([]);
  const [wsState,       setWsState]       = useState<WsEditorState>(WS_EDITOR_INITIAL);
  const [wsLinkedTopic, setWsLinkedTopic] = useState<TopicContext | null>(null);
  const wsLogId            = useRef(0);
  const initialSaveSkipped = useRef(false);
  // interjection(continuation) 중인지 추적 — done 시 append vs replace 결정
  const isInterjectionRef  = useRef(false);

  // ── 토론 모드 / 깊이 / 수렴 방식 / 대화 방식 ──────────────────────
  const [discussionMode,      setDiscussionMode]      = useState<DiscussionMode>("general");
  const [discussionDepth,     setDiscussionDepth]     = useState<DiscussionDepth>("balanced");
  const [consensusMode,       setConsensusMode]       = useState<ConsensusMode>("auto");
  const [safetyLimitEnabled,  setSafetyLimitEnabled]  = useState(true);
  const [interactionStyle,    setInteractionStyle]    = useState<InteractionStyle>("debate");

  // ── Provider Settings ─────────────────────────────────────────────
  const [providerSettings, setProviderSettings] = useState<ProvidersConfig>(DEFAULT_PROVIDERS);
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(() => localStorage.getItem(ONBOARDING_KEY) !== "1");

  // ── Analysis Modal ────────────────────────────────────────────────
  const [analysisModal, setAnalysisModal] = useState<{ topic: Topic; analysis: DiscussionAnalysis } | null>(null);

  // ── Live Discussion 상태 ─────────────────────────────────────────
  const [liveEnabled,    setLiveEnabled]    = useState(false); // 실행 방식 토글
  const [aiProcessing,   setAiProcessing]   = useState(false); // AI worker가 실제 연산 중인지
  const [liveResult,     setLiveResult]     = useState<RunResult | null>(null);
  const [liveStatus,     setLiveStatus]     = useState("");
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("gcpt-theme");
    return saved === "dark" ? "dark" : "light";
  });

  // sessions → 단일 merged RunResult (기존 코드 인터페이스 유지)
  const result = useMemo(
    () => sessions.length === 0 ? null : sessions.reduce(mergeResult),
    [sessions],
  );

  // 마지막 세션이 live 모드면 continuation 가능
  const liveSessionActive = sessions.length > 0 && sessions[sessions.length - 1].mode === "live";

  function addWsLog(entry: Omit<WsLogEntry, "id">) {
    setWsLog(prev => [{ ...entry, id: ++wsLogId.current }, ...prev]);
  }

  function clearWsLog() {
    setWsLog([]);
    wsLogId.current = 0;
  }

  // ── Live Discussion IPC 이벤트 구독 ─────────────────────────────
  useEffect(() => {
    const cleanUpdate = window.api.onDiscussionUpdate(({ history, topics }) => {
      setLiveResult({
        mode:          "live",
        metrics:       { calls: { gpt: { total:0,parseOk:0,parseFail:0,apiError:0 }, claude: { total:0,parseOk:0,parseFail:0,apiError:0 }, gemini: { total:0,parseOk:0,parseFail:0,apiError:0 } }, latencyMs: [], tokens: { prompt:0,completion:0 }, topics: { decided:0,undecided:0 } },
        revisionCount: history.length,
        topics,
        history,
      });
    });
    const cleanStatus = window.api.onDiscussionStatus(msg => setLiveStatus(msg));

    // 토론 완료: 최종 결과(metrics 포함)로 세션 배열 업데이트 후 AI 처리 상태 해제
    const cleanDone = window.api.onDiscussionDone(finalResult => {
      if (finalResult) {
        if (isInterjectionRef.current) {
          // continuation — 마지막 세션을 새 snapshot으로 교체 (live orch가 전체 누적 포함)
          setSessions(prev => prev.length > 0 ? [...prev.slice(0, -1), finalResult] : [finalResult]);
        } else {
          // 새 실행 — 기존 세션에 append
          setSessions(prev => [...prev, finalResult]);
        }
        setLiveStatus("");
      } else {
        // null = 오류 또는 timeout — 진행 상태만 해제, 이전 sessions 유지
        console.warn("[renderer] discussion ended without result (error or timeout)");
        setLiveStatus("토론이 비정상 종료되었습니다");
        setTimeout(() => setLiveStatus(""), 4000);
      }
      isInterjectionRef.current = false;
      setAiProcessing(false);
      setLiveResult(null);
    });

    return () => { cleanUpdate(); cleanStatus(); cleanDone(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Provider Settings 로드 (mount 1회) ──────────────────────────
  useEffect(() => {
    window.api.getProviderSettings()
      .then(cfg => setProviderSettings(cfg))
      .catch(e => console.error("[renderer] getProviderSettings failed:", e));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 최초 실행 — API 설정 패널 자동 오픈 ────────────────────────
  useEffect(() => {
    const cleanup = window.api.onFirstRun(() => setProviderSettingsOpen(true));
    return cleanup;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    localStorage.setItem("gcpt-theme", theme);
  }, [theme]);

  function closeOnboarding() {
    localStorage.setItem(ONBOARDING_KEY, "1");
    setOnboardingOpen(false);
  }

  // ── localStorage 복원 (mount 1회) ───────────────────────────────
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      console.log("[ws localStorage] restore raw", raw ? raw.slice(0, 300) : null);
      if (!raw) return;

      const saved = JSON.parse(raw);
      console.log("[ws localStorage] restore parsed version=", saved.version, "workspacePath=", saved.workspacePath, "selectedFile=", saved.selectedFile, "files.length=", saved.files?.length);

      if (saved.version !== LS_VER) {
        console.log("[ws localStorage] version mismatch (saved:", saved.version, "expected:", LS_VER, ") → clearing");
        localStorage.removeItem(LS_KEY);
        return;
      }

      const restored: WsEditorState = {
        workspacePath:   saved.workspacePath   ?? null,
        files:           Array.isArray(saved.files) ? saved.files : [],
        skipped:         saved.skipped         ?? 0,
        selectedFile:    saved.selectedFile    ?? null,
        original:        saved.original        ?? null,
        proposed:        null,    // 항상 초기화 (파일이 바뀌었을 수 있음)
        proposeSummary:  "",
        expandedFolders: new Set<string>(
          Array.isArray(saved.expandedFolders) ? saved.expandedFolders : [],
        ),
      };
      setWsState(restored);

      if (Array.isArray(saved.wsLog) && saved.wsLog.length > 0) {
        setWsLog(saved.wsLog as WsLogEntry[]);
        wsLogId.current = Math.max(...(saved.wsLog as WsLogEntry[]).map(e => e.id), 0);
      }

      // 선택 파일이 있으면 최신 내용으로 재취득
      console.log("[ws restore] selectedFile", restored.selectedFile);
      if (restored.workspacePath && restored.selectedFile) {
        window.api.readWorkspaceFile(restored.workspacePath, restored.selectedFile)
          .then(res => {
            console.log("[ws restore] reread ok=", res.ok);
            if (res.ok) {
              setWsState(prev => ({ ...prev, original: res.content.replace(/\r\n/g, "\n") }));
            } else {
              setWsState(prev => ({ ...prev, selectedFile: null, original: null }));
            }
          })
          .catch(e => {
            console.error("[ws restore] reread error", e);
            setWsState(prev => ({ ...prev, selectedFile: null, original: null }));
          });
      }
    } catch (e) {
      console.error("[ws localStorage] restore error", e);
      localStorage.removeItem(LS_KEY);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── localStorage 저장 (wsState/wsLog 변경 시) ───────────────────
  // 첫 번째 실행은 반드시 건너뜀: restore effect가 같은 render pass에서 이미 실행됐으므로
  // wsState가 여전히 WS_EDITOR_INITIAL인 상태에서 저장하면 기존 데이터가 덮힘
  useEffect(() => {
    if (!initialSaveSkipped.current) {
      initialSaveSkipped.current = true;
      return;
    }
    try {
      const snapshot = {
        version:         LS_VER,
        workspacePath:   wsState.workspacePath,
        files:           wsState.files,
        skipped:         wsState.skipped,
        selectedFile:    wsState.selectedFile,
        original:        wsState.original,
        expandedFolders: Array.from(wsState.expandedFolders),
        wsLog,
      };
      localStorage.setItem(LS_KEY, JSON.stringify(snapshot));
    } catch {
      // QuotaExceededError 등 무시
    }
  }, [wsState, wsLog]);

  const topicRevRanges = useMemo(() => {
    if (!result) return [];
    return result.topics.map((topic, i) => ({
      startId: topic.startRevId,
      endId:   i + 1 < result.topics.length ? result.topics[i + 1].startRevId : Infinity,
    }));
  }, [result]);

  const displayedRevisions = useMemo(() => {
    if (!result) return [];
    if (selectedTopicIdx === null) return result.history;
    const r = topicRevRanges[selectedTopicIdx];
    if (!r) return result.history;
    return result.history.filter(rev => rev.id >= r.startId && rev.id < r.endId);
  }, [result, selectedTopicIdx, topicRevRanges]);

  // revision id → Revision 조회 (ref 표시용)
  const revMap = useMemo(
    () => new Map((result?.history ?? []).map(r => [r.id, r])),
    [result],
  );

  function handleTopicClick(idx: number) {
    setSelectedTopicIdx(prev => prev === idx ? null : idx);
    setSelectedRevId(null);
  }

  function handleRevClick(revId: number) {
    setSelectedRevId(prev => prev === revId ? null : revId);
    const idx = topicRevRanges.findIndex(r => revId >= r.startId && revId < r.endId);
    setSelectedTopicIdx(idx >= 0 ? idx : null);
  }

  async function runSelected() {
    if (selected === "custom") {
      await runCustom();
      return;
    }
    if (liveEnabled) {
      await startLiveRun(GOAL_SETS[selected] ?? ["데이터베이스 기술 스택 결정"], discussionMode);
    } else {
      setRunning(true);
      setRunLabel(`mock:${selected}`);
      setSelectedTopicIdx(null);
      setSelectedRevId(null);
      const r = await window.api.runMode(selected, discussionMode);
      setSessions(prev => [...prev, r]);
      setRunning(false);
    }
  }

  async function runCustom() {
    const goal = customGoal.trim();
    if (!goal) return;
    if (liveEnabled) {
      setSelected("custom");
      await startLiveRun([goal], discussionMode);
    } else {
      setRunning(true);
      setRunLabel(`"${goal.slice(0, 20)}${goal.length > 20 ? "…" : ""}"`);
      setSelected("custom");
      setSelectedTopicIdx(null);
      setSelectedRevId(null);
      const r = await window.api.runCustom(goal, discussionMode);
      setSessions(prev => [...prev, r]);
      setRunning(false);
    }
  }

  async function saveSession() {
    if (!result) return;
    const goals = result.history
      .filter(r => r.patch.payload.type === "set_goal")
      .map(r => (r.patch.payload as { goal: string }).goal);

    const session: Session = {
      version: "1",
      type:    "gcpt-session",
      savedAt: new Date().toISOString(),
      mode:    result.mode,
      goals,
      summary: {
        revisionCount: result.revisionCount,
        decided:       result.metrics.topics.decided,
        undecided:     result.metrics.topics.undecided,
        gptCalls:      result.metrics.calls.gpt.total,
        claudeCalls:   result.metrics.calls.claude.total,
      },
      metrics:   result.metrics,
      topics:    result.topics,
      revisions: result.history,
      editLog:   wsLog.length > 0 ? wsLog : undefined,
    };

    const json = JSON.stringify(session, null, 2);
    const res  = await window.api.saveSession(json);
    if (!res.canceled && res.filePath) {
      const name = res.filePath.split(/[\\/]/).pop() ?? res.filePath;
      setSessionStatus(`저장됨: ${name}`);
      setTimeout(() => setSessionStatus(""), 4000);
    }
  }

  async function loadSession() {
    const showError = (msg: string) => {
      console.error("[renderer] loadSession:", msg);
      setSessionStatus(`오류: ${msg}`);
      setTimeout(() => setSessionStatus(""), 6000);
    };

    try {
      const res = await window.api.loadSession();
      if (!res.ok) {
        if (!res.canceled) showError(res.error ?? "파일 읽기 실패");
        return;
      }

      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(res.content) as Record<string, unknown>;
      } catch {
        showError("JSON 파싱 실패 — 파일이 손상됐을 수 있습니다");
        return;
      }

      if (raw.version !== "1") {
        showError(`지원하지 않는 버전: "${raw.version}" (현재: "1")`);
        return;
      }

      const fileType = (raw.type as string | undefined) ?? "gcpt-session";

      // ── gcpt-topic-session: 단일 토픽 파일 ──────────────────────────
      if (fileType === "gcpt-topic-session" || fileType === "gcpt-topic") {
        const missing: string[] = [];
        if (!raw.topic || typeof raw.topic !== "object") missing.push("topic");
        if (!Array.isArray(raw.revisions))               missing.push("revisions");
        if (missing.length > 0) {
          showError(`gcpt-topic 파일 오류 — 누락 필드: ${missing.join(", ")}`);
          return;
        }

        const topic     = raw.topic     as Topic;
        const revisions = raw.revisions as Revision[];
        const emptyCall = () => ({ total: 0, parseOk: 0, parseFail: 0, apiError: 0 });
        const restored: RunResult = {
          mode: "custom",
          metrics: {
            calls:     { gpt: emptyCall(), claude: emptyCall(), gemini: emptyCall() },
            latencyMs: [],
            tokens:    { prompt: 0, completion: 0 },
            topics:    { decided: topic.status === "decided" ? 1 : 0, undecided: topic.status === "decided" ? 0 : 1 },
          },
          revisionCount: revisions.length,
          topics:        [topic],
          history:       revisions,
        };

        setSessions([restored]);
        setSelectedTopicIdx(null);
        setSelectedRevId(null);
        setSelected("custom");
        setCustomGoal(topic.goal);

        setSessionStatus(`불러옴 (topic): ${topic.goal}`);
        setTimeout(() => setSessionStatus(""), 4000);
        return;
      }

      // ── gcpt-session: 전체 세션 파일 (또는 구 포맷, type 없음) ───────
      if (fileType === "gcpt-session") {
        const session = raw as unknown as Session;
        const missing: string[] = [];
        if (!Array.isArray(session.topics))    missing.push("topics");
        if (!Array.isArray(session.revisions)) missing.push("revisions");
        if (missing.length > 0) {
          showError(`gcpt-session 파일 오류 — 누락 필드: ${missing.join(", ")}`);
          return;
        }

        const loadedMetrics = session.metrics;
        if (!loadedMetrics.calls.gemini) {
          loadedMetrics.calls.gemini = { total: 0, parseOk: 0, parseFail: 0, apiError: 0 };
        }

        const restored: RunResult = {
          mode:          session.mode,
          metrics:       loadedMetrics,
          revisionCount: session.summary.revisionCount,
          topics:        session.topics,
          history:       session.revisions,
        };

        setSessions([restored]);
        setSelectedTopicIdx(null);
        setSelectedRevId(null);
        setSelected(session.mode === "custom" ? "custom" : session.mode);
        if (session.mode === "custom" && session.goals.length > 0)
          setCustomGoal(session.goals.join("\n"));
        if (Array.isArray(session.editLog) && session.editLog.length > 0) {
          setWsLog(session.editLog);
          wsLogId.current = Math.max(...session.editLog.map(e => e.id), 0);
        }

        const goalSummary = session.goals.slice(0, 2).join(", ") + (session.goals.length > 2 ? " …" : "");
        setSessionStatus(`불러옴: ${goalSummary}`);
        setTimeout(() => setSessionStatus(""), 4000);
        return;
      }

      showError(`알 수 없는 파일 형식: "${fileType}" (지원: gcpt-session, gcpt-topic-session)`);

    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    }
  }

  async function runAll() {
    // Live ON 상태에서는 전체 테스트 미지원 (버튼이 비활성화되므로 도달하지 않음)
    if (liveEnabled) return;
    setRunning(true);
    setRunLabel("전체 테스트");
    setSelectedTopicIdx(null);
    setSelectedRevId(null);
    const results = await window.api.runAll();
    const map: PassMap = {};
    for (const r of results) map[r.mode] = r.metrics.topics.undecided === 0 ? "pass" : "fail";
    setPassMap(map);
    setSessions(prev => [...prev, ...results]);
    setRunning(false);
  }

  // 새 토론 — 입력(홈) 화면으로 초기화. 진행 중에는 안전하게 무시한다.
  function goHome() {
    if (running || aiProcessing) return;
    setSessions([]);
    setLiveResult(null);
    setSelectedTopicIdx(null);
    setSelectedRevId(null);
    setPassMap({});
    setSelected("custom");
    setCustomGoal("");
  }

  // Live 버튼 — 실행 방식 토글만 담당 (실행 자체는 runSelected/runCustom에서 처리)
  function toggleLive() {
    setLiveEnabled(prev => !prev);
  }

  // Live 실행 — runSelected/runCustom에서 liveEnabled 시 호출
  async function startLiveRun(goals: string[], dm: DiscussionMode = discussionMode, depth: DiscussionDepth = discussionDepth, cm: ConsensusMode = consensusMode) {
    const enabledWithoutKey = enabledProvidersWithoutApiKey(providerSettings);
    if (enabledWithoutKey.length > 0) {
      setLiveStatus(`API 키가 없는 provider가 활성화되어 있습니다: ${formatProviderNames(enabledWithoutKey)}`);
      setTimeout(() => setLiveStatus(""), 4000);
      return;
    }

    const runnableCount = runnableProviderNames(providerSettings).length;
    if (runnableCount < 2) {
      setLiveStatus("실시간 토론에는 API 키가 설정된 AI provider가 최소 2개 필요합니다");
      setTimeout(() => setLiveStatus(""), 4000);
      return;
    }

    try {
      isInterjectionRef.current = false; // 새 실행 = append 모드
      setAiProcessing(true);
      setLiveResult(null);
      setLiveStatus("토론 시작 중...");
      setRunLabel("live");
      setSelectedTopicIdx(null);
      setSelectedRevId(null);

      console.log("[ui] selected interactionStyle =", interactionStyle);
      const _ipcPayload = { goals, mode: dm, depth, consensusMode: cm, safetyLimitEnabled, interactionStyle };
      console.log("[ipc payload]", _ipcPayload);
      const res = await window.api.startLiveDiscussion(_ipcPayload);
      if (!res.ok) {
        console.error("[renderer] startLiveDiscussion failed:", res.error);
        setAiProcessing(false);
        setLiveStatus(res.error ?? "실시간 토론을 시작하지 못했습니다");
        setTimeout(() => setLiveStatus(""), 4000);
      }
      // 완료/정리는 onDiscussionDone 핸들러에서 처리
    } catch (e) {
      console.error("[renderer] startLive error:", e);
      setAiProcessing(false);
      setLiveStatus("");
    }
  }

  // Revision → Workspace 연결: decided topic의 컨텍스트를 추출해 Workspace로 전환
  function handleOpenInWorkspace(topicIdx: number) {
    const topic = displayResult?.topics[topicIdx];
    if (!topic || !topic.selectedOption) return;

    const selectedVal = (topic.selectedOption.content as { value: string }).value;
    const alternatives = topic.proposals
      .filter(p => (p.content as { value: string }).value !== selectedVal)
      .map(p => ({ value: (p.content as { value: string }).value, author: p.author }));

    setWsLinkedTopic({
      goal:          topic.goal,
      selectedValue: selectedVal,
      selectedBy:    topic.selectedOption.selectedBy,
      alternatives,
      mode:          topic.mode,
    });
    setView("workspace");
  }

  // 특정 topic 삭제 — 해당 revision 범위도 함께 제거
  function handleDeleteTopic(globalTopicIdx: number) {
    if (running || aiProcessing) return;
    const topic = result?.topics[globalTopicIdx];
    if (!topic) return;

    const confirmed = window.confirm(
      `"${topic.goal}" 토론을 삭제할까요?\n이 토론과 관련된 revision 기록도 함께 삭제됩니다.\n이 작업은 되돌릴 수 없습니다.`,
    );
    if (!confirmed) return;

    const loc = findSessionForTopic(sessions, globalTopicIdx);
    if (!loc) return;

    setSessions(prev => {
      const next = [...prev];
      const updated = deleteTopicFromResult(next[loc.sessionIdx], loc.localIdx);
      if (updated.topics.length === 0) {
        next.splice(loc.sessionIdx, 1);
      } else {
        next[loc.sessionIdx] = updated;
      }
      return next;
    });

    // 선택 인덱스 조정
    if (selectedTopicIdx === globalTopicIdx) {
      setSelectedTopicIdx(null);
      setSelectedRevId(null);
    } else if (selectedTopicIdx !== null && selectedTopicIdx > globalTopicIdx) {
      setSelectedTopicIdx(selectedTopicIdx - 1);
    }

    // Workspace 연결 정리
    if (wsLinkedTopic && wsLinkedTopic.goal === topic.goal) setWsLinkedTopic(null);
  }

  // 선택한 topic만 저장
  async function saveTopic() {
    if (selectedTopicIdx === null || !result) return;
    const topic = result.topics[selectedTopicIdx];
    const ranges = result.topics.map((t, i) => ({
      startId: t.startRevId,
      endId:   i + 1 < result.topics.length ? result.topics[i + 1].startRevId : Infinity,
    }));
    const range = ranges[selectedTopicIdx];
    const revisions = result.history.filter(r => r.id >= range.startId && r.id < range.endId);

    const data = {
      version:   "1",
      type:      "gcpt-topic-session",
      savedAt:   new Date().toISOString(),
      topic,
      revisions,
    };

    const res = await window.api.saveSession(JSON.stringify(data, null, 2));
    if (!res.canceled && res.filePath) {
      const name = res.filePath.split(/[\\/]/).pop() ?? res.filePath;
      setSessionStatus(`저장됨: ${name}`);
      setTimeout(() => setSessionStatus(""), 4000);
    }
  }

  // until_consensus 모드 — 토론 중지 (paused 상태로 전환 후 수동 채택 대기)
  async function handleStopDiscussion() {
    await window.api.stopDiscussion();
  }

  // Manual 모드 — policy 최고 점수 자동 채택 (토론 중에도 호출 가능)
  async function handleAcceptConsensus() {
    const wasIdle = !aiProcessing;
    if (wasIdle) setAiProcessing(true);
    const res = await window.api.acceptConsensus();
    if (!res.ok) {
      console.warn("[renderer] acceptConsensus failed");
      if (wasIdle) setAiProcessing(false);
    }
  }

  // Manual 모드 — 특정 proposal 직접 채택 (토론 중에도 호출 가능)
  async function handleSelectProposal(revisionId: number) {
    const wasIdle = !aiProcessing;
    if (wasIdle) setAiProcessing(true);
    const res = await window.api.selectProposal(revisionId);
    if (!res.ok) {
      console.warn("[renderer] selectProposal failed revisionId=", revisionId);
      if (wasIdle) setAiProcessing(false);
    }
  }

  // interjection 전송 — 세션 활성 여부 확인 후 live view 재활성화
  async function handleInterjection(msg: string) {
    console.log("[renderer] interjection payload", { safetyLimitEnabled });
    const res = await window.api.sendInterjection({ message: msg, safetyLimitEnabled });
    if (!res.ok) {
      console.warn("[renderer] interjection ignored — no active session");
      return;
    }
    // continuation: done 시 마지막 세션을 교체 (orch가 전체 snapshot 포함 전송)
    isInterjectionRef.current = true;
    setLiveResult(result);
    setAiProcessing(true);
    setLiveStatus("토론 재개 중...");
  }

  // AI 처리 중: liveResult (실시간) / idle: result (최종 스냅샷)
  // aiProcessing 중에 liveResult가 null이면 result로 fallback (초기 로딩 공백 방지)
  const displayResult = aiProcessing ? (liveResult ?? result) : result;
  const demoMeta = useMemo(() => getDemoResultMeta(displayResult), [displayResult]);
  const showDemoRunNotice = view === "engine" && !liveEnabled && !aiProcessing;

  // until_consensus 실행 중 상태 텍스트 — API 호출 수 + 현재 우세 의견 표시
  const enhancedLiveStatus = useMemo(() => {
    if (!aiProcessing || discussionDepth !== "until_consensus") return liveStatus;
    if (!liveResult) return liveStatus || "합의 도달 모드 실행 중...";
    const proposals = liveResult.history.filter(r =>
      r.patch.payload.type === "propose_decision" ||
      r.patch.payload.type === "propose_alternative",
    );
    const apiCalls = proposals.length;
    const lastTopic = liveResult.topics[liveResult.topics.length - 1];
    const agg = lastTopic && lastTopic.interactionStyle !== "conversation" ? computeAggregation(lastTopic) : [];
    const leadingValue = agg.length > 0 ? agg[0].value : null;
    return `합의 도달 모드 · API ${apiCalls}회${leadingValue ? ` · 현재 우세: ${leadingValue}` : ""}`;
  }, [aiProcessing, discussionDepth, liveStatus, liveResult]);

  return (
    <div className={`app theme-${theme} ${!displayResult && !aiProcessing ? "app-empty" : "app-active"}`}>
      {analysisModal && (
        <>
          {demoMeta.isDemo && <AnalysisDemoNotice hasPlaceholder={demoMeta.hasPlaceholder} />}
          <AnalysisModal
            goal={analysisModal.topic.goal}
            analysis={analysisModal.analysis}
            topic={analysisModal.topic}
            history={result?.history}
            onClose={() => setAnalysisModal(null)}
          />
        </>
      )}
      {providerSettingsOpen && (
        <SettingsModal
          providerSettings={providerSettings}
          onProviderSettingsChange={async (next) => {
            setProviderSettings(next);
            await window.api.saveProviderSettings(next);
          }}
          running={running || aiProcessing}
          onClose={() => setProviderSettingsOpen(false)}
        />
      )}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      {onboardingOpen && !providerSettingsOpen && (
        <OnboardingModal
          onStart={closeOnboarding}
          onDismiss={closeOnboarding}
        />
      )}
      <Header
        view={view}
        onViewChange={setView}
        executionRunning={running || aiProcessing}
        liveSessionActive={liveSessionActive}
        liveStatus={enhancedLiveStatus}
        label={runLabel}
        onRun={runSelected}
        onRunAll={runAll}
        liveEnabled={liveEnabled}
        onToggleLive={toggleLive}
        canSave={!!result}
        onSave={saveSession}
        canSaveTopic={selectedTopicIdx !== null && !aiProcessing && !running}
        onSaveTopic={saveTopic}
        onLoad={loadSession}
        sessionStatus={sessionStatus}
        discussionDepth={discussionDepth}
        onStopDiscussion={handleStopDiscussion}
        theme={theme}
        onToggleTheme={() => setTheme(prev => prev === "dark" ? "light" : "dark")}
        onOpenHelp={() => setHelpOpen(true)}
      />
      {view === "engine" ? (
        <>
          <div className="body">
            <Sidebar
              modes={MODES}
              selected={selected}
              passMap={passMap}
              onSelect={setSelected}
              onNewDiscussion={goHome}
              running={running || aiProcessing}
              discussionMode={discussionMode}
              onDiscussionModeChange={setDiscussionMode}
              discussionDepth={discussionDepth}
              onDiscussionDepthChange={setDiscussionDepth}
              consensusMode={consensusMode}
              onConsensusModeChange={setConsensusMode}
              safetyLimitEnabled={safetyLimitEnabled}
              onSafetyLimitEnabledChange={setSafetyLimitEnabled}
              interactionStyle={interactionStyle}
              onInteractionStyleChange={setInteractionStyle}
              providerSettings={providerSettings}
              onProviderSettingsChange={async (next) => {
                setProviderSettings(next);
                await window.api.saveProviderSettings(next);
              }}
              providerSettingsOpen={providerSettingsOpen}
              onProviderSettingsToggle={() => setProviderSettingsOpen(true)}
              recentTopics={(displayResult?.topics ?? []).slice(-6).reverse()}
            />
            <div className="engine-main">
              {showDemoRunNotice && <DemoRunNotice />}
              {!displayResult && !aiProcessing ? (
                <WelcomeScreen
                  customGoal={customGoal}
                  onCustomGoalChange={setCustomGoal}
                  onCustomRun={runCustom}
                  running={running || aiProcessing}
                />
              ) : (
              <>
              {demoMeta.isDemo && <DemoResultNotice hasPlaceholder={demoMeta.hasPlaceholder} />}
              <ResizablePanels
              panes={[
                {
                  id: "토론 주제",
                  minWidth: 180,
                  initialFlex: 0.28,
                  children: (
                    <ErrorBoundary label="Topic Panel">
                      <TopicPanel
                        result={displayResult}
                        demoMeta={demoMeta}
                        selectedTopicIdx={selectedTopicIdx}
                        onTopicClick={handleTopicClick}
                        onOpenInWorkspace={handleOpenInWorkspace}
                        onDeleteTopic={!running && !aiProcessing ? handleDeleteTopic : undefined}
                        executionRunning={running || aiProcessing}
                        onShowAnalysis={(topic, analysis) => setAnalysisModal({ topic, analysis })}
                      />
                    </ErrorBoundary>
                  ),
                },
                {
                  id: "AI 토론",
                  minWidth: 260,
                  initialFlex: 0.44,
                  children: (
                    <ErrorBoundary label="Discussion Panel">
                      <DiscussionPanel
                        result={displayResult}
                        demoMeta={demoMeta}
                        selectedTopicIdx={selectedTopicIdx}
                        liveStatus={enhancedLiveStatus}
                        liveRunning={aiProcessing}
                        isLiveSession={liveSessionActive}
                        onInterjection={handleInterjection}
                        isManualMode={consensusMode === "manual" || displayResult?.topics[displayResult.topics.length - 1]?.status === "paused"}
                        onAcceptConsensus={handleAcceptConsensus}
                        onSelectProposal={handleSelectProposal}
                        onStopDiscussion={aiProcessing ? handleStopDiscussion : undefined}
                      />
                    </ErrorBoundary>
                  ),
                },
                {
                  id: "변경 기록",
                  minWidth: 180,
                  initialFlex: 0.28,
                  children: (
                    <ErrorBoundary label="Timeline Panel">
                      <TimelinePanel
                        revisions={aiProcessing ? (liveResult?.history ?? []) : displayedRevisions}
                        totalCount={displayResult?.revisionCount ?? 0}
                        isFiltered={!aiProcessing && selectedTopicIdx !== null}
                        demoMeta={demoMeta}
                        selectedRevId={selectedRevId}
                        onRevClick={handleRevClick}
                        wsLog={wsLog}
                        revMap={revMap}
                      />
                    </ErrorBoundary>
                  ),
                },
              ]}
            />
              </>
            )}
            </div>
          </div>
          <MetricsBar result={displayResult} />
        </>
      ) : (
        <ErrorBoundary label="Workspace">
          <WorkspaceEditor
            wsState={wsState}
            setWsState={setWsState}
            wsLog={wsLog}
            addWsLog={addWsLog}
            clearWsLog={clearWsLog}
            linkedTopic={wsLinkedTopic}
            onClearLinkedTopic={() => setWsLinkedTopic(null)}
          />
        </ErrorBoundary>
      )}
    </div>
  );
}

function DemoModeBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`demo-mode-badge${compact ? " compact" : ""}`} title="실제 AI 응답이 아닌 테스트용 결과입니다.">
      데모 모드
    </span>
  );
}

function DemoRunNotice() {
  return (
    <div className="demo-run-notice" role="status">
      실시간 모드가 꺼져 있어 데모 응답으로 실행됩니다.
    </div>
  );
}

function DemoResultNotice({ hasPlaceholder }: { hasPlaceholder: boolean }) {
  return (
    <div className="demo-result-notice" role="status">
      <div>
        <DemoModeBadge />
        <strong>실제 AI 응답이 아닌 테스트용 결과입니다.</strong>
      </div>
      {hasPlaceholder && (
        <p>테스트용 선택지가 감지되었습니다. 실제 판단이 필요하면 실시간 모드를 켜 주세요.</p>
      )}
    </div>
  );
}

function AnalysisDemoNotice({ hasPlaceholder }: { hasPlaceholder: boolean }) {
  return (
    <div className="analysis-demo-notice" role="status">
      <DemoModeBadge />
      <span>이 분석은 데모 응답을 기반으로 합니다.</span>
      {hasPlaceholder && <span> 테스트용 선택지가 감지되었습니다.</span>}
    </div>
  );
}

function WelcomeScreen({ customGoal, onCustomGoalChange, onCustomRun, running }: {
  customGoal: string;
  onCustomGoalChange: (v: string) => void;
  onCustomRun: () => void;
  running: boolean;
}) {
  const examples = [
    "새 SaaS 제품의 첫 기능 우선순위를 정해줘",
    "우리 팀에 맞는 데이터베이스 기술 스택을 토론해줘",
    "주말에 할 만한 창의적인 프로젝트 아이디어를 골라줘",
  ];

  return (
    <main className="welcome-screen">
      <section className="prompt-hero">
        <div className="prompt-kicker">AI 협업 토론 워크스페이스</div>
        <h2>무엇을 결정할까요?</h2>
        <p>주제를 입력하면 GPT, Claude, Gemini가 각자의 관점으로 검토하고 하나의 결론으로 정리합니다.</p>
        <div className="prompt-box">
          <textarea
            className="prompt-input"
            placeholder="예: 다음 분기 제품 로드맵에서 가장 먼저 집중할 기능을 정해줘"
            value={customGoal}
            onChange={e => onCustomGoalChange(e.target.value)}
            onKeyDown={e => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !running) onCustomRun();
            }}
            disabled={running}
          />
          <button
            className="prompt-submit"
            onClick={onCustomRun}
            disabled={running || !customGoal.trim()}
          >
            {running ? "토론 준비 중..." : "토론 시작하기"}
          </button>
        </div>
        <div className="example-grid">
          {examples.map(text => (
            <button
              key={text}
              className="example-card"
              onClick={() => onCustomGoalChange(text)}
              disabled={running}
            >
              {text}
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}

const HELP_ITEMS = [
  {
    name: "토론",
    does: "AI들이 주제에 대해 제안, 반박, 합의를 진행하는 기본 화면입니다.",
    when: "결정할 문제나 비교할 선택지가 있을 때 사용하세요.",
  },
  {
    name: "워크스페이스",
    does: "토론 결론을 바탕으로 파일 작업이나 구현 계획을 이어가는 화면입니다.",
    when: "결론을 실제 코드나 문서 작업으로 옮기고 싶을 때 사용하세요.",
  },
  {
    name: "다크",
    does: "앱 색상을 어두운 테마와 밝은 테마로 전환합니다.",
    when: "눈부심을 줄이거나 밝은 화면으로 바꾸고 싶을 때 사용하세요.",
  },
  {
    name: "실행",
    does: "현재 선택한 모드 또는 입력한 주제로 AI 토론을 시작합니다.",
    when: "주제를 정했거나 테스트 모드를 선택한 뒤 누르세요.",
  },
  {
    name: "실시간 켜기/꺼짐",
    does: "AI 발언이 진행되는 과정을 실시간으로 볼지 선택합니다.",
    when: "토론 흐름을 중간중간 보며 개입하고 싶을 때 켜세요.",
  },
  {
    name: "더보기",
    does: "전체 테스트, 저장, 불러오기 같은 추가 명령을 엽니다.",
    when: "결과를 보관하거나 이전 세션을 다시 열 때 사용하세요.",
  },
  {
    name: "새 토론",
    does: "입력 화면으로 돌아가 새 주제를 시작할 준비를 합니다.",
    when: "현재 결과와 별개로 새 결정을 시작하고 싶을 때 사용하세요.",
  },
  {
    name: "최근 토론",
    does: "현재 세션에서 최근에 만든 토론 주제를 보여줍니다.",
    when: "방금 만든 결과를 빠르게 다시 확인할 때 사용하세요.",
  },
  {
    name: "고급 설정",
    does: "토론 방식, 깊이, 합의 방식, 안전 한도를 조정합니다.",
    when: "더 빠르게 끝내거나 더 깊게 토론시키고 싶을 때 사용하세요.",
  },
  {
    name: "분석 보기",
    does: "AI들의 의견이 어떻게 수렴했는지 분석 화면을 엽니다.",
    when: "결론의 근거와 논리 흐름을 더 자세히 보고 싶을 때 사용하세요.",
  },
  {
    name: "변경 기록",
    does: "토론 중 생긴 목표, 제안, 선택 같은 모든 변화를 시간순으로 보여줍니다.",
    when: "어떤 발언이나 선택이 언제 생겼는지 추적할 때 사용하세요.",
  },
];

function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="guide-backdrop" onMouseDown={onClose}>
      <section className="guide-modal help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title" onMouseDown={e => e.stopPropagation()}>
        <div className="guide-header">
          <div>
            <h2 id="help-title">GCPT 도움말</h2>
            <p>주요 버튼이 하는 일과 언제 쓰면 좋은지 간단히 정리했습니다.</p>
          </div>
          <button className="guide-close" type="button" onClick={onClose}>닫기</button>
        </div>
        <div className="help-list">
          {HELP_ITEMS.map(item => (
            <article key={item.name} className="help-item">
              <h3>{item.name}</h3>
              <p>{item.does}</p>
              <small>{item.when}</small>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function OnboardingModal({ onStart, onDismiss }: { onStart: () => void; onDismiss: () => void }) {
  return (
    <div className="guide-backdrop">
      <section className="guide-modal onboarding-modal" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <div className="guide-header">
          <div>
            <h2 id="onboarding-title">GCPT 시작하기</h2>
            <p>처음이라면 아래 흐름대로 진행하면 됩니다.</p>
          </div>
        </div>
        <ol className="onboarding-steps">
          <li><strong>토론 주제 입력</strong><span>결정하고 싶은 질문을 한 문장으로 적습니다.</span></li>
          <li><strong>실행 클릭</strong><span>AI들이 제안과 반박을 시작합니다.</span></li>
          <li><strong>결과 확인</strong><span>선택된 결론과 제안 목록을 확인합니다.</span></li>
          <li><strong>깊게 보기</strong><span>분석 보기로 근거를 확인하거나 워크스페이스에서 후속 작업을 이어갑니다.</span></li>
        </ol>
        <div className="guide-actions">
          <button className="primary" type="button" onClick={onStart}>시작하기</button>
          <button className="settings-secondary" type="button" onClick={onDismiss}>다시 보지 않기</button>
        </div>
      </section>
    </div>
  );
}

function sanitizeProviderError(message: unknown) {
  return String(message ?? "실패").replace(/sk-[A-Za-z0-9_-]+/g, "API_KEY");
}

function SettingsModal({ providerSettings, onProviderSettingsChange, running, onClose }: {
  providerSettings: ProvidersConfig;
  onProviderSettingsChange: (s: ProvidersConfig) => void;
  running: boolean;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [testStatus, setTestStatus] = useState<Record<string, string>>({});

  async function handleTestConnection(provider: "gpt" | "claude" | "gemini") {
    setTestStatus(prev => ({ ...prev, [provider]: "확인 중..." }));
    const res = await window.api.testProviderConnection(provider);
    setTestStatus(prev => ({
      ...prev,
      [provider]: res.ok ? `연결됨 · ${res.latency}ms` : sanitizeProviderError(res.error).slice(0, 80),
    }));
  }

  const providerLabel = (p: "gpt" | "claude" | "gemini") =>
    p === "gpt" ? "OpenAI" : p === "claude" ? "Claude" : "Gemini";

  return (
    <div className="settings-backdrop" onMouseDown={onClose}>
      <div className="settings-modal" onMouseDown={e => e.stopPropagation()}>
        <div className="settings-header">
          <div>
            <h2>설정</h2>
            <p>AI 연결 상태와 모델을 관리합니다. API 키는 저장된 설정에서만 사용됩니다.</p>
          </div>
          <button className="settings-close" onClick={onClose}>닫기</button>
        </div>
        <div className="settings-provider-grid">
          {(["gpt", "claude", "gemini"] as const).map(p => {
            const cfg = providerSettings[p];
            const label = providerLabel(p);
            const models = p === "gpt"
              ? ["gpt-5-mini", "gpt-5", "gpt-4o"]
              : p === "claude"
              ? ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-8"]
              : ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-pro"];

            return (
              <section key={p} className={`settings-provider-card ${cfg.enabled ? "is-on" : "is-off"}`}>
                <div className="settings-provider-top">
                  <strong>{label}</strong>
                  <span className={`settings-status ${cfg.enabled && cfg.apiKey ? "ready" : "idle"}`}>
                    {cfg.enabled && cfg.apiKey ? "사용 가능" : cfg.enabled ? "키 필요" : "꺼짐"}
                  </span>
                </div>
                <p>{cfg.model}</p>
                {testStatus[p] && <div className="settings-test-result">{testStatus[p]}</div>}
                {editing && (
                  <div className="settings-edit-fields">
                    <label>
                      활성화
                      <input
                        type="checkbox"
                        checked={cfg.enabled}
                        onChange={e => onProviderSettingsChange({ ...providerSettings, [p]: { ...cfg, enabled: e.target.checked } })}
                        disabled={running}
                      />
                    </label>
                    <input
                      className="provider-apikey-input"
                      type="password"
                      placeholder={`${label} API Key`}
                      value={cfg.apiKey}
                      onChange={e => onProviderSettingsChange({ ...providerSettings, [p]: { ...cfg, apiKey: e.target.value } })}
                      disabled={running}
                      autoComplete="off"
                    />
                    <select
                      className="provider-model-select"
                      value={cfg.model}
                      onChange={e => onProviderSettingsChange({ ...providerSettings, [p]: { ...cfg, model: e.target.value } })}
                      disabled={running}
                    >
                      {models.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                )}
                <button
                  className="settings-test-btn"
                  onClick={() => handleTestConnection(p)}
                  disabled={running || !cfg.apiKey}
                >
                  연결 확인
                </button>
              </section>
            );
          })}
        </div>
        <div className="settings-footer">
          <button className="settings-secondary" onClick={() => setEditing(v => !v)}>
            {editing ? "저장하기" : "수정하기"}
          </button>
          <button className="primary" onClick={onClose}>완료</button>
        </div>
      </div>
    </div>
  );
}

// ─── Header ──────────────────────────────────────────────────────

function Header({ view, onViewChange, executionRunning, liveSessionActive, liveStatus, label,
                  onRun, onRunAll, liveEnabled, onToggleLive,
                  canSave, onSave, canSaveTopic, onSaveTopic, onLoad, sessionStatus,
                  discussionDepth, onStopDiscussion, theme, onToggleTheme, onOpenHelp }: {
  view: AppView; onViewChange: (v: AppView) => void;
  executionRunning: boolean;
  liveSessionActive: boolean;
  liveStatus: string;
  label: string;
  onRun: () => void; onRunAll: () => void;
  liveEnabled: boolean; onToggleLive: () => void;
  canSave: boolean; onSave: () => void;
  canSaveTopic: boolean; onSaveTopic: () => void;
  onLoad: () => void;
  sessionStatus: string;
  discussionDepth?: DiscussionDepth;
  onStopDiscussion?: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onOpenHelp: () => void;
}) {
  const statusText = executionRunning
    ? `● ${liveStatus || `AI 토론 중... ${label}`}`
    : liveSessionActive
    ? "● 실시간 세션 활성화"
    : sessionStatus
    ? sessionStatus
    : view === "engine" && label
    ? `완료: ${label}`
    : "대기 중";

  const statusClass = executionRunning
    ? "running"
    : liveSessionActive
    ? "live-idle"
    : sessionStatus
    ? "session-msg"
    : "";

  return (
    <div className="header">
      <h1>gcpt</h1>
      <div className="view-tabs">
        <button
          className={`view-tab ${view === "engine" ? "active" : ""}`}
          onClick={() => onViewChange("engine")}
          title="토론 화면으로 이동합니다. 주제를 입력하고 AI 토론 결과를 확인할 때 사용하세요."
        >토론</button>
        <button
          className={`view-tab ${view === "workspace" ? "active" : ""}`}
          onClick={() => onViewChange("workspace")}
          title="결론을 바탕으로 파일 수정이나 작업 계획을 이어갈 때 사용하세요."
        >워크스페이스</button>
      </div>
      <button
        className="theme-toggle"
        onClick={onToggleTheme}
        title={theme === "dark" ? "화이트 모드로 전환" : "다크 모드로 전환"}
      >
        {theme === "dark" ? "다크" : "화이트"}
      </button>
      <button
        className="help-button"
        type="button"
        onClick={onOpenHelp}
        title="GCPT 주요 버튼과 화면 사용법을 봅니다"
        aria-label="도움말 열기"
      >
        도움말
      </button>
      {view === "engine" && (
        <>
          <button
            className="primary"
            onClick={onRun}
            disabled={executionRunning}
            title="선택한 테스트 모드나 입력한 주제로 AI 토론을 시작합니다."
          >
            실행
          </button>
          <button
            className={`live-btn ${liveEnabled ? "active" : ""}`}
            onClick={onToggleLive}
            disabled={executionRunning}
            title={liveEnabled ? "실시간 토론을 끄고 일반 실행으로 돌아갑니다." : "AI 발언이 진행되는 과정을 실시간으로 보며 토론합니다."}
          >
            {liveEnabled ? "실시간 켜짐" : "실시간 꺼짐"}
          </button>
          {discussionDepth === "until_consensus" && executionRunning && (
            <button
              className="stop-discussion-btn"
              onClick={onStopDiscussion}
              title="토론 중지 — 현재까지의 제안을 수동 채택 대기 상태로 일시 정지합니다"
            >
              토론 중지
            </button>
          )}
          <details className="header-more">
            <summary title="저장, 불러오기, 전체 테스트 같은 추가 명령을 엽니다.">더보기</summary>
            <div className="header-more-menu">
              <button
                onClick={onRunAll}
                disabled={executionRunning || liveEnabled}
                title={liveEnabled ? "전체 테스트는 실시간 모드 미지원" : ""}
              >전체 테스트</button>
              <button
                onClick={onSaveTopic}
                disabled={executionRunning || !canSaveTopic}
                title={canSaveTopic ? "선택한 토론 저장 (JSON)" : "저장할 토론을 선택하세요"}
              >
                선택 토론 저장
              </button>
              <button
                onClick={onSave}
                disabled={executionRunning || !canSave}
                title="전체 세션 저장 (JSON)"
              >
                전체 저장
              </button>
              <button onClick={onLoad} disabled={executionRunning} title="세션 불러오기">불러오기</button>
            </div>
          </details>
        </>
      )}
      <span className={`status ${statusClass}`}>{statusText}</span>
    </div>
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────

function Sidebar({ modes, selected, passMap, onSelect,
                   running,
                   discussionMode, onDiscussionModeChange,
                   discussionDepth, onDiscussionDepthChange,
                   consensusMode, onConsensusModeChange,
                   safetyLimitEnabled, onSafetyLimitEnabledChange,
                   interactionStyle, onInteractionStyleChange,
                   providerSettings, onProviderSettingsChange,
                   providerSettingsOpen, onProviderSettingsToggle,
                   onNewDiscussion,
                   recentTopics = [] }: {
  modes: string[]; selected: string; passMap: PassMap;
  onSelect: (m: string) => void;
  onNewDiscussion: () => void;
  running: boolean;
  discussionMode: DiscussionMode; onDiscussionModeChange: (m: DiscussionMode) => void;
  discussionDepth: DiscussionDepth; onDiscussionDepthChange: (d: DiscussionDepth) => void;
  consensusMode: ConsensusMode; onConsensusModeChange: (c: ConsensusMode) => void;
  safetyLimitEnabled: boolean; onSafetyLimitEnabledChange: (v: boolean) => void;
  interactionStyle: InteractionStyle; onInteractionStyleChange: (s: InteractionStyle) => void;
  providerSettings: ProvidersConfig;
  onProviderSettingsChange: (s: ProvidersConfig) => void;
  providerSettingsOpen: boolean;
  onProviderSettingsToggle: () => void;
  recentTopics?: Topic[];
}) {
  void onProviderSettingsChange;
  void providerSettingsOpen;
  const runnableProviders = runnableProviderNames(providerSettings);
  const missingKeyProviders = enabledProvidersWithoutApiKey(providerSettings);
  const providerLabel = (p: ProviderName) => PROVIDER_LABELS[p];

  return (
    <div className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-mark">G</div>
        <div>
          <strong>GCPT</strong>
          <span>AI 토론 워크스페이스</span>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="주요 메뉴">
        <button
          className={`side-nav-item ${selected === "custom" ? "active" : ""}`}
          onClick={onNewDiscussion}
          title="입력 화면으로 돌아가 새 토론을 시작합니다."
        >
          새 토론
        </button>
        <button className="side-nav-item" type="button" title="현재 세션의 최근 토론 목록을 확인합니다.">
          최근 토론
        </button>
        <button className="side-nav-item" type="button" onClick={onProviderSettingsToggle} title="AI 연결과 고급 설정을 관리합니다.">
          설정
        </button>
      </nav>

      <section className="sidebar-recent">
        <div className="sidebar-section-head">
          <span>최근 토론</span>
          <small>{recentTopics.length}</small>
        </div>
        {recentTopics.length === 0 ? (
          <div className="sidebar-empty">아직 저장된 토론이 없습니다</div>
        ) : recentTopics.map((topic, idx) => (
          <button key={`${topic.startRevId}-${idx}`} className="recent-topic" type="button">
            <strong>{topic.goal}</strong>
            <em>{topic.status === "decided" ? "완료" : topic.status === "active" ? "진행 중" : topic.status}</em>
          </button>
        ))}
      </section>

      <section className="sidebar-provider-summary">
        <div className="sidebar-section-head">
          <span>연결 상태</span>
          <button type="button" onClick={onProviderSettingsToggle}>관리</button>
        </div>
        <div className="provider-pill-row">
          {PROVIDER_NAMES.map(p => (
            <span key={p} className={`provider-pill ${providerSettings[p].enabled ? "connected" : ""}`}>
              {providerLabel(p)}
            </span>
          ))}
        </div>
        <p>
          {missingKeyProviders.length > 0
            ? `API 키 필요: ${formatProviderNames(missingKeyProviders)}`
            : runnableProviders.length >= 2
              ? `${runnableProviders.length}개 모델로 토론할 수 있습니다`
              : "토론에는 API 키가 설정된 모델이 최소 2개 필요합니다"}
        </p>
      </section>

      <details className="discussion-settings">
        <summary title="토론 방식, 깊이, 합의 방식을 조정하는 고급 설정입니다.">고급 설정</summary>

        <div className="disc-mode-section">
          <div className="sidebar-title">대화 방식</div>
          <div className="disc-mode-btns">
            <button
              className={`disc-mode-btn ${interactionStyle === "debate" ? "active" : ""}`}
              onClick={() => onInteractionStyleChange("debate")}
              disabled={running}
              title="논거 제시, 반박, 수렴 - 최적 결론을 도출하는 구조적 토론"
            >
              토론
            </button>
            <button
              className={`disc-mode-btn ${interactionStyle === "conversation" ? "active" : ""}`}
              onClick={() => onInteractionStyleChange("conversation")}
              disabled={running}
              title="자연스러운 대화 - 3턴 후 자동 종료, 수렴 평가 없음"
            >
              대화
            </button>
          </div>
          {interactionStyle === "conversation" && (
            <div className="until-consensus-warn">
              대화 모드: 수렴 평가 없이 자연스럽게 대화합니다. 3턴 후 자동 종료됩니다.
            </div>
          )}
        </div>

        <div className="disc-mode-section">
          <div className="sidebar-title">토론 모드</div>
          <div className="disc-mode-btns">
            {(["general", "development", "idea"] as const).map(m => (
              <button
                key={m}
                className={`disc-mode-btn ${discussionMode === m ? "active" : ""}`}
                onClick={() => onDiscussionModeChange(m)}
                disabled={running || interactionStyle === "conversation"}
                title={m === "general" ? "일상적인 주제, 단순 응답" : m === "development" ? "기술 스택·아키텍처 중심" : "창의적 제안·아이디어 발산"}
              >
                {DISC_MODE_LABELS[m]}
              </button>
            ))}
          </div>
        </div>

        <div className="disc-mode-section">
          <div className="sidebar-title">
            토론 깊이
            {(discussionDepth === "deep" || discussionDepth === "until_consensus") && (
              <span className="depth-cost-hint"> 토큰 증가</span>
            )}
          </div>
          <div className="disc-mode-btns">
            {(["fast", "balanced", "deep"] as const).map(d => (
              <button
                key={d}
                className={`disc-mode-btn ${discussionDepth === d ? "active" : ""}`}
                onClick={() => onDiscussionDepthChange(d)}
                disabled={running || interactionStyle === "conversation"}
                title={
                  d === "fast"     ? "1라운드 · 빠른 결론" :
                  d === "balanced" ? "2라운드 · 기본" :
                                     "5라운드 · 심층 토론 · 토큰 증가"
                }
              >
                {DEPTH_LABELS[d]}
              </button>
            ))}
          </div>
          <div className="disc-mode-btns" style={{ marginTop: 4 }}>
            <button
              className={`disc-mode-btn until-consensus-btn ${discussionDepth === "until_consensus" ? "active" : ""}`}
              onClick={() => onDiscussionDepthChange("until_consensus")}
              disabled={running || interactionStyle === "conversation"}
              title="합의 도달까지 최대 20라운드 · 30분 안전 타임아웃 · 실험 모드"
            >
              {DEPTH_LABELS["until_consensus"]}
            </button>
          </div>
          {discussionDepth === "until_consensus" && (
            <div className="until-consensus-warn">
              실험 모드: 합의 도달 시까지 자동 토론을 계속합니다. API 호출이 많아질 수 있습니다.
            </div>
          )}
        </div>

        <div className="disc-mode-section">
          <div className="sidebar-title">수렴 방식</div>
          <div className="disc-mode-btns">
            {(["auto", "manual"] as const).map(c => (
              <button
                key={c}
                className={`disc-mode-btn ${consensusMode === c ? "active" : ""}`}
                onClick={() => onConsensusModeChange(c)}
                disabled={running || interactionStyle === "conversation"}
                title={c === "auto" ? "조건 충족 시 시스템이 자동으로 결론을 확정" : "사용자가 채택 버튼을 눌러야 결론 확정"}
              >
                {CONSENSUS_LABELS[c]}
              </button>
            ))}
          </div>
        </div>

        <div className="disc-mode-section">
          <label className="safety-limit-toggle" title="OFF 시 라운드 한도 도달 후에도 토론을 계속합니다. 내부 절대 타임아웃은 항상 유지됩니다.">
            <input
              type="checkbox"
              checked={safetyLimitEnabled}
              onChange={e => onSafetyLimitEnabledChange(e.target.checked)}
              disabled={running}
            />
            <span>안전 한도 사용</span>
            {!safetyLimitEnabled && <span className="depth-cost-hint"> 라운드 무제한</span>}
          </label>
        </div>

        <div className="sidebar-modes">
          <div className="sidebar-title">테스트 모드</div>
          {modes.map((m) => (
            <div
              key={m}
              className={`mode-item ${m === selected ? "active" : ""}`}
              onClick={() => onSelect(m)}
            >
              <span className={`mode-dot ${passMap[m] ?? ""}`} />
              mock:{m}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

// ─── Topic Panel ─────────────────────────────────────────────────

function TopicPanel({ result, demoMeta, selectedTopicIdx, onTopicClick, onOpenInWorkspace, onDeleteTopic, executionRunning, onShowAnalysis }: {
  result: RunResult | null;
  demoMeta: DemoResultMeta;
  selectedTopicIdx: number | null;
  onTopicClick: (idx: number) => void;
  onOpenInWorkspace?: (idx: number) => void;
  onDeleteTopic?: (idx: number) => void;
  executionRunning?: boolean;
  onShowAnalysis?: (topic: Topic, analysis: DiscussionAnalysis) => void;
}) {
  const hint = selectedTopicIdx !== null
    ? "클릭하여 필터 해제"
    : result ? "Topic 클릭 → 저장 활성화 / Timeline 필터링" : "";

  return (
    <div className="panel">
      <div className="panel-title">
        토론 주제
        {demoMeta.isDemo && <DemoModeBadge />}
        {result && <span className="panel-hint">{result.topics.length}개 토론</span>}
        {hint && <span className="panel-hint">{hint}</span>}
      </div>
      <div className="panel-body">
        {!result ? (
          <div className="empty">모드 선택 후 실행하세요</div>
        ) : result.topics.length === 0 ? (
          <div className="empty">토론이 없습니다</div>
        ) : result.topics.map((topic, i) => (
          <TopicCard
            key={`${topic.startRevId}-${i}`}
            topic={topic}
            demoMeta={demoMeta}
            analysis={result.analyses?.[i]}
            isSelected={selectedTopicIdx === i}
            onClick={() => onTopicClick(i)}
            onOpenInWorkspace={!executionRunning ? () => onOpenInWorkspace?.(i) : undefined}
            onDelete={onDeleteTopic ? () => onDeleteTopic(i) : undefined}
            onShowAnalysis={onShowAnalysis ? (a) => onShowAnalysis(topic, a) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Aggregation Summary ─────────────────────────────────────────

function AggregationSummary({ topic, demoMeta }: { topic: Topic; demoMeta: DemoResultMeta }) {
  // useMemo: topic 참조가 바뀔 때만 재계산 (live 토론 중 매 update마다 호출 방지)
  const agg     = useMemo(() => computeAggregation(topic), [topic]);
  const stances = useMemo(() => computeStances(topic),     [topic]);

  // 3개 미만 proposal 또는 1종류만 있을 때는 표시 불필요
  if (topic.proposals.length < 3 || agg.length < 2) return null;

  const aiActors = (["gpt", "claude", "gemini"] as const).filter(a => stances.has(a));

  return (
    <div className="agg-summary">
      <div className="agg-title">
        현재 우세 의견
        {demoMeta.isDemo && <DemoModeBadge compact />}
      </div>
      {demoMeta.hasPlaceholder && (
        <div className="demo-inline-warning">테스트용 선택지가 감지되었습니다. 실제 판단이 필요하면 실시간 모드를 켜 주세요.</div>
      )}
      <div className="agg-proposals">
        {agg.slice(0, 3).map((ap, i) => (
          <div key={ap.normalKey} className={`agg-row${ap.isSelected ? " agg-selected" : ""}`}>
            <span className="agg-rank">#{i + 1}</span>
            <span className="agg-value">{ap.value}</span>
            <span className="agg-score">{ap.score}</span>
            <span className="agg-supporters">
              {[...ap.supporters]
                .sort((a, b) => b.count - a.count)
                .map(s => (
                  <span
                    key={s.author}
                    className="agg-supporter"
                    style={{ color: ACTOR_META[s.author]?.color ?? "#858585" }}
                  >
                    {ACTOR_META[s.author]?.label ?? s.author}×{s.count}
                  </span>
                ))}
            </span>
          </div>
        ))}
      </div>
      {aiActors.length > 0 && (
        <div className="agg-stances">
          {aiActors.map(actor => (
            <span key={actor} className="agg-stance">
              <span style={{ color: ACTOR_META[actor].color }}>{ACTOR_META[actor].label}</span>
              {" → "}
              <span className="agg-stance-val">{stances.get(actor)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Stance History View ──────────────────────────────────────────

// shift 횟수 임계값: 이 이상이면 "탐색 중" 안내 표시
const DRIFT_WARN_THRESHOLD = 3;

function StanceHistoryView({ topic }: { topic: Topic }) {
  const histories = useMemo(() => computeStanceHistory(topic), [topic]);
  if (histories.length === 0) return null;

  const driftActors = histories.filter(h => h.shifts.length >= DRIFT_WARN_THRESHOLD);

  return (
    <div className="stance-history">
      <div className="stance-history-title">입장 변화</div>
      {driftActors.length > 0 && (
        <div className="stance-drift-notice">
          {driftActors.map(h => {
            const meta = ACTOR_META[h.actor] ?? { label: h.actor, color: "#858585" };
            return (
              <span key={h.actor} style={{ color: meta.color }}>{meta.label}</span>
            );
          }).reduce<ReactNode[]>((acc, el, i) => i === 0 ? [el] : [...acc, ", ", el], [])}
          {" "}이(가) 여러 대안을 탐색 중입니다. 결론 수렴이 지연될 수 있습니다.
        </div>
      )}
      {histories.map(h => {
        const meta = ACTOR_META[h.actor] ?? { label: h.actor, color: "#858585" };
        return (
          <div key={h.actor} className="stance-actor-row">
            <span className="stance-actor-label" style={{ color: meta.color }}>
              {meta.label}
            </span>
            <span className="stance-trail">
              {h.trail.map((v, i) => (
                <span key={i}>
                  {i > 0 && <span className="stance-arrow">→</span>}
                  <span className={i === h.trail.length - 1 ? "stance-current" : "stance-past"}>
                    {v}
                  </span>
                </span>
              ))}
            </span>
            <span className={`stance-shift-count${h.shifts.length >= DRIFT_WARN_THRESHOLD ? " stance-shift-warn" : ""}`}>
              {h.shifts.length}회
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── ConversationChatView ─────────────────────────────────────────

const AUTHOR_COLOR: Record<string, string> = {
  gpt:    "#10a37f",
  claude: "#d97706",
  gemini: "#4f46e5",
  user:   "#6b7280",
  system: "#9ca3af",
};

function ConversationChatView({ proposals }: { proposals: Proposal[] }) {
  if (proposals.length === 0) return null;
  return (
    <div className="conv-chat-view">
      {proposals.map((p, i) => {
        const value = (p.content as { value: string }).value;
        const color = AUTHOR_COLOR[p.author] ?? "#6b7280";
        return (
          <div key={i} className="conv-chat-bubble">
            <span className="conv-chat-author" style={{ color }}>{p.author.toUpperCase()}</span>
            <span className="conv-chat-text">{value}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Topic Card ───────────────────────────────────────────────────

function TopicCard({ topic, demoMeta, analysis: propAnalysis, isSelected, onClick, onOpenInWorkspace, onDelete, onShowAnalysis }: {
  topic: Topic;
  demoMeta: DemoResultMeta;
  analysis?: DiscussionAnalysis;
  isSelected: boolean;
  onClick: () => void;
  onOpenInWorkspace?: () => void;
  onDelete?: () => void;
  onShowAnalysis?: (analysis: DiscussionAnalysis) => void;
}) {
  const isUndecided   = topic.selectedOption === null && topic.status !== "reopened";
  const isTerminal    = topic.status === "decided" || topic.status === "paused" || topic.status === "closed";
  // 저장된 분석이 없으면 즉석 계산 (세션 로드 등 구버전 호환) — 현재 세그먼트만 평가
  const analysis      = propAnalysis ?? (isTerminal && topic.interactionStyle !== "conversation"
    ? analyzeDiscussion(topic, undefined, { segmentStartRevId: topic.currentSegmentStartRevId })
    : undefined);

  return (
    <div
      className={`topic-card ${isSelected ? "selected" : ""} ${isUndecided ? "undecided" : ""}`}
      onClick={onClick}
    >
      <div className="topic-header">
        <span className="topic-goal">{topic.goal}</span>
        <span className={`badge ${topic.status}`}>
          {topic.status === "decided" ? "완료" :
           topic.status === "paused" ? "중지됨" :
           topic.status === "closed" ? "종료" :
           topic.status === "active" ? "진행 중" :
           topic.status === "reopened" ? "재개" : topic.status}
        </span>
        {topic.interactionStyle === "conversation" && (
          <span className="topic-mode-badge mode-conversation">💬 대화</span>
        )}
        {topic.mode && topic.mode !== "general" && topic.interactionStyle !== "conversation" && (
          <span className={`topic-mode-badge mode-${topic.mode}`}>
            {DISC_MODE_LABELS[topic.mode]}
          </span>
        )}
        {topic.segments && topic.segments.length > 1 && (
          <span className="topic-segment-badge">
            Segment {topic.segments.length} / 평가 초기화됨
          </span>
        )}
        {onDelete && (
          <button
            className="topic-del-btn"
            onClick={e => { e.stopPropagation(); onDelete(); }}
            title="이 토론 삭제"
          >
            삭제
          </button>
        )}
      </div>
      {(() => {
        // finalResolution > finalConclusion > synthesizedConsensus 우선순위
        const fr  = analysis?.finalResolution;
        const evo = analysis && topic.interactionStyle !== "conversation"
          ? fr
            ? {
                text:   fr.primaryConclusion,
                conf:   fr.confidence,
                source: fr.resolutionType,
                isFinalResolution: true,
              }
            : analysis.finalConclusion && analysis.finalConclusion.source !== "selected_option"
            ? { text: analysis.finalConclusion.text, conf: analysis.finalConclusion.confidence, source: analysis.finalConclusion.source, isFinalResolution: false }
            : analysis.synthesizedConsensus
            ? { text: analysis.synthesizedConsensus.text, conf: analysis.synthesizedConsensus.confidence, source: "synthesized_consensus" as const, isFinalResolution: false }
            : null
          : null;

        const selectedVal = topic.selectedOption
          ? (topic.selectedOption.content as { value: string }).value
          : null;

        if (evo) {
          const freeze = analysis?.convergenceFreeze;

          // FinalResolution 배지 레이블
          const RES_BADGE: Record<string, string> = {
            stable_answer:              "안정 수렴",
            synthesized_resolution:     "합성 해결",
            transformed_resolution:     "최종 진화 구조",
            unresolved_dynamic_tension: "동적 긴장",
            synthesized_consensus: "진화된 합의",
            surviving_branch: freeze?.freezeType === "discussion_exhausted"
              ? "논리 수렴 완료"
              : freeze?.freezeType === "semantic_convergence"
              ? "의미 수렴 완료"
              : freeze?.freezeType === "branch_frozen"
              ? "Branch 동결"
              : "진화 생존 합의",
          };
          const badgeLabel = RES_BADGE[evo.source] ?? "진화 결론";

          const BADGE_CLASS: Record<string, string> = {
            stable_answer:              "evo-branch",
            synthesized_resolution:     "evo-synthesis",
            transformed_resolution:     "evo-transformed",
            unresolved_dynamic_tension: "evo-tension",
            synthesized_consensus: "evo-synthesis",
            surviving_branch:      "evo-branch",
          };
          const badgeClass = BADGE_CLASS[evo.source] ?? "evo-hybrid";

          const isFrozen = !evo.isFinalResolution && freeze?.frozen && evo.source === "surviving_branch";

          return (
            <div className="topic-evo-main" onClick={e => e.stopPropagation()}>
              <div className="topic-evo-row">
                <span className={`topic-evo-badge ${badgeClass}`}>
                  {badgeLabel}
                </span>
                {demoMeta.isDemo && <DemoModeBadge compact />}
                <span className="topic-evo-conf">분석 신뢰도 {Math.round(evo.conf * 100)}%</span>
                {analysis && onShowAnalysis && (
                  <button
                    className="topic-analysis-btn topic-evo-btn"
                    onClick={() => onShowAnalysis(analysis)}
                    title="결론이 나온 과정과 수렴 이유를 자세히 봅니다."
                  >
                    분석 보기
                  </button>
                )}
              </div>
              {isFrozen && (
                <div className="topic-freeze-hint">
                  새로운 논리 진화 없음 — 최종 surviving branch
                </div>
              )}
              <div className="topic-evo-text">{evo.text}</div>
              {selectedVal && !evo.isFinalResolution && (
                <div className="topic-winner-secondary">
                  <span className="topic-winner-label">{getConsensusSourceLabel(topic.selectedOption?.convergenceSource)}</span>
                  <span className="topic-winner-val">{selectedVal}</span>
                  <span className="topic-winner-by">— {topic.selectedOption!.selectedBy}</span>
                </div>
              )}
            </div>
          );
        }

        return (
          <>
            {selectedVal && (
              <div className="topic-selected">
                ✓ {selectedVal}
                <span className="topic-selected-by">{getConsensusSourceLabel(topic.selectedOption?.convergenceSource)} · {topic.selectedOption!.selectedBy}</span>
              </div>
            )}
            {analysis && topic.interactionStyle !== "conversation" && (
              <div className="topic-analysis-bar" onClick={e => e.stopPropagation()}>
                {demoMeta.isDemo && <DemoModeBadge compact />}
                {analysis.saturation?.saturated ? (
                  <>
                    <span className="topic-saturation-badge">포화 수렴</span>
                    <span className="topic-analysis-summary">{analysis.saturation.reason}</span>
                  </>
                ) : (
                  <span className="topic-analysis-summary">{analysis.summary}</span>
                )}
                <button
                  className="topic-analysis-btn"
                  onClick={() => onShowAnalysis?.(analysis)}
                  title="토론 요약, 수렴 상태, 논리 흐름을 분석 화면에서 봅니다."
                >
                  토론 분석 보기
                </button>
              </div>
            )}
          </>
        );
      })()}
      {topic.status === "decided" && topic.selectedOption && onOpenInWorkspace && (
        <button
          className="topic-ws-btn"
          onClick={e => { e.stopPropagation(); onOpenInWorkspace(); }}
          title="이 결론을 기반으로 Workspace에서 파일 수정 작업을 시작합니다"
        >
          워크스페이스에서 이어서 작업
        </button>
      )}
      {isUndecided && topic.status !== "decided" && (
        <div className="topic-undecided-label">⚠ 미결정</div>
      )}
      {topic.interactionStyle !== "conversation" && <AggregationSummary topic={topic} demoMeta={demoMeta} />}
      {topic.interactionStyle !== "conversation" && <StanceHistoryView topic={topic} />}
      <div className="proposals">
        {topic.interactionStyle === "conversation"
          ? <ConversationChatView proposals={topic.proposals} />
          : topic.proposals.map((p, j) => {
              const c = p.content as { value: string; reason: string };
              return (
                <div key={j}>
                  <div className="proposal-row">
                    <span className="proposal-author">[{p.author}]</span>
                    <span className="proposal-value">{c.value}</span>
                    {c.reason && <span className="proposal-reason">— {c.reason}</span>}
                  </div>
                  {p.rationale && <div className="proposal-rationale">↳ {p.rationale}</div>}
                </div>
              );
            })
        }
      </div>
    </div>
  );
}

// ─── Timeline Panel ───────────────────────────────────────────────

function TimelinePanel({ revisions, totalCount, isFiltered, demoMeta, selectedRevId, onRevClick, wsLog, revMap }: {
  revisions: Revision[]; totalCount: number;
  isFiltered: boolean; selectedRevId: number | null;
  demoMeta: DemoResultMeta;
  onRevClick: (id: number) => void;
  wsLog?: WsLogEntry[];
  revMap?: Map<number, Revision>;
}) {
  const title = isFiltered
    ? `변경 기록 (${revisions.length} / ${totalCount}개 필터됨)`
    : `변경 기록 (${totalCount})`;

  return (
    <div className="panel timeline-panel">
      <div className="panel-title">
        {title}
        {demoMeta.isDemo && <DemoModeBadge />}
        {isFiltered && <span className="panel-filter-badge">필터 중</span>}
      </div>
      <div className="panel-body" style={{ padding: 0 }}>
        {revisions.length === 0 ? (
          <div className="empty">—</div>
        ) : revisions.map((rev) => (
          <RevisionRow
            key={rev.id}
            rev={rev}
            isSelected={selectedRevId === rev.id}
            onClick={() => onRevClick(rev.id)}
            revMap={revMap}
          />
        ))}
        {wsLog && wsLog.length > 0 && (
          <>
            <div className="timeline-ws-sep">— File Edits ({wsLog.length}) —</div>
            {wsLog.map(entry => (
              <WsLogRow key={entry.id} entry={entry} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ─── DiscussionPanel display model ───────────────────────────────

// 컴포넌트 외부 상수 — 렌더마다 재생성 방지
const DISC_TYPES = new Set([
  "propose_decision", "propose_alternative", "consensus_reached",
  "user_interjection", "discussion_deadlock", "discussion_paused",
]);

type DiscMessageItem = { kind: "message"; rev: Revision };
type DiscGroupItem = {
  kind:         "group";
  key:          string;
  actor:        Author;
  normalKey:    string;
  displayValue: string;
  revs:         Revision[];
  latestReason: string;
};
type DiscItem = DiscMessageItem | DiscGroupItem;

function buildDiscussionItems(msgs: Revision[]): DiscItem[] {
  const items: DiscItem[] = [];
  const groupMap = new Map<string, DiscGroupItem>();

  for (const rev of msgs) {
    const t = rev.patch.payload.type;
    if (t !== "propose_decision" && t !== "propose_alternative") {
      items.push({ kind: "message", rev });
      continue;
    }
    const p = rev.patch.payload as { value: string; reason: string };
    const normalKey = normalizeProposal(p.value);
    const key = `${rev.author}:${normalKey}`;

    if (!groupMap.has(key)) {
      const g: DiscGroupItem = {
        kind: "group", key,
        actor: rev.author,
        normalKey,
        displayValue: p.value,
        revs: [rev],
        latestReason: p.reason,
      };
      groupMap.set(key, g);
      items.push(g);
    } else {
      const g = groupMap.get(key)!;
      g.revs.push(rev);
      g.latestReason = p.reason;
    }
  }

  return items;
}

// ─── AI Discussion Panel ──────────────────────────────────────────

function DiscussionPanel({ result, demoMeta, selectedTopicIdx, liveStatus, liveRunning, isLiveSession,
                           onInterjection, isManualMode, onAcceptConsensus, onSelectProposal,
                           onStopDiscussion }: {
  result: RunResult | null;
  demoMeta: DemoResultMeta;
  selectedTopicIdx: number | null;
  liveStatus?: string;
  liveRunning?: boolean;
  isLiveSession?: boolean;
  onInterjection?: (msg: string) => void;
  isManualMode?: boolean;
  onAcceptConsensus?: () => void;
  onSelectProposal?: (revisionId: number) => void;
  onStopDiscussion?: () => void;
}) {
  const [interjectText,  setInterjectText]  = useState("");
  const interjectRef = useRef<HTMLInputElement>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [deadlockDismissed, setDeadlockDismissed] = useState(false);

  function toggleGroup(key: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  // Live 모드: 전체 history의 proposals 표시
  // 배치 모드: 선택된 topic의 proposals 표시
  const msgs = useMemo(() => {
    if (!result) return [];
    if (liveRunning || isLiveSession) {
      return result.history.filter(r => DISC_TYPES.has(r.patch.payload.type));
    }
    if (selectedTopicIdx === null) return [];
    const topic  = result.topics[selectedTopicIdx];
    if (!topic) return [];
    const nextStart = result.topics[selectedTopicIdx + 1]?.startRevId ?? Infinity;
    return result.history.filter(
      r => r.id >= topic.startRevId && r.id < nextStart && DISC_TYPES.has(r.patch.payload.type),
    );
  }, [result, selectedTopicIdx, liveRunning, isLiveSession]);

  const items = useMemo(() => buildDiscussionItems(msgs), [msgs]);

  // decided 값 추출 (입력창 안내 문구용)
  const decidedValue = msgs.find(r => r.patch.payload.type === "consensus_reached" || r.patch.payload.type === "select_option")
    ? (msgs.find(r => r.patch.payload.type === "consensus_reached" || r.patch.payload.type === "select_option")!
        .patch.payload as { selected?: string; value?: string }).selected
      ?? (msgs.find(r => r.patch.payload.type === "consensus_reached" || r.patch.payload.type === "select_option")!
        .patch.payload as { selected?: string; value?: string }).value
      ?? null
    : null;

  // 현재 토픽 분석 — evolutionary consensus 추출 (consensus_reached 카드 재구성용)
  const currentTopicForPanel = useMemo(() => {
    if (!result) return null;
    const idx = selectedTopicIdx !== null ? selectedTopicIdx : result.topics.length - 1;
    const t = result.topics[idx] ?? null;
    if (!t || t.interactionStyle === "conversation") return null;
    const isTerminal = t.status === "decided" || t.status === "paused" || t.status === "closed";
    return isTerminal ? t : null;
  }, [result, selectedTopicIdx]);

  const topicAnalysis = useMemo(
    () => currentTopicForPanel
      ? analyzeDiscussion(currentTopicForPanel, undefined, { segmentStartRevId: currentTopicForPanel.currentSegmentStartRevId })
      : null,
    [currentTopicForPanel],
  );

  const evoConclusion = topicAnalysis
    ? topicAnalysis.finalConclusion && topicAnalysis.finalConclusion.source !== "selected_option"
      ? topicAnalysis.finalConclusion.text
      : topicAnalysis.synthesizedConsensus?.text ?? null
    : null;

  const hint = liveRunning
    ? "토론 진행 중..."
    : selectedTopicIdx !== null && result
    ? `Topic: ${result.topics[selectedTopicIdx]?.goal ?? ""}`
    : "Topic을 선택하면 토론 흐름이 표시됩니다";

  // 입력창 표시 조건: live 진행 중 OR 이전 live 세션 결과 있음
  const showInput = !!(liveRunning || isLiveSession);

  // Manual 모드: 특정 revision이 속한 topic의 활성 여부 확인 (채택 버튼 표시 조건)
  function isRevTopicActive(revId: number): boolean {
    if (!result) return false;
    for (let i = result.topics.length - 1; i >= 0; i--) {
      const nextStart = result.topics[i + 1]?.startRevId ?? Infinity;
      if (revId >= result.topics[i].startRevId && revId < nextStart) {
        const s = result.topics[i].status;
        return s === "active" || s === "reopened";
      }
    }
    return false;
  }

  // liveRunning이 꺼지면 deadlock 상태 초기화 (다음 실행에 대비)
  const prevLiveRunning = useRef(liveRunning);
  useEffect(() => {
    if (!liveRunning && prevLiveRunning.current) setDeadlockDismissed(false);
    prevLiveRunning.current = liveRunning;
  }, [liveRunning]);

  const hasActiveDeadlock = liveRunning && msgs.some(r => r.patch.payload.type === "discussion_deadlock");

  function sendInterjection() {
    const msg = interjectText.trim();
    if (!msg || !onInterjection) return;
    onInterjection(msg);
    setInterjectText("");
    // 한글 IME 조합 잔상 방지: 컨트롤드 state 초기화와 별개로 DOM value도 즉시 비운다
    if (interjectRef.current) interjectRef.current.value = "";
  }

  return (
    <div className="panel discussion-panel">
      <div className="panel-title">
        AI 토론
        {demoMeta.isDemo && <DemoModeBadge compact />}
        {msgs.length > 0 && <span className="panel-hint">{msgs.length}개 발언</span>}
        {liveStatus && <span className="disc-live-status">{liveStatus}</span>}
      </div>
      <div className="panel-body discussion-body">
        {items.length === 0 ? (
          <div className="empty">{hint}</div>
        ) : items.map(item => {
          // ── collapsed/expanded group (2개 이상 반복 제안) ──
          if (item.kind === "group" && item.revs.length >= 2) {
            const g          = item;
            const isExpanded = expandedGroups.has(g.key);
            const meta       = ACTOR_META[g.actor] ?? { label: g.actor, color: "#858585" };
            const latestRevId = g.revs[g.revs.length - 1].id;
            const isCounter  = g.revs[0].patch.payload.type === "propose_alternative";
            const showGroupSelectBtn =
              isManualMode && isRevTopicActive(latestRevId) && !!onSelectProposal;

            return (
              <div key={g.key} className="disc-group">
                {isExpanded ? (
                  <>
                    {g.revs.map(rev => {
                      const rp = rev.patch.payload as { value: string; reason: string };
                      const showSelectBtn =
                        isManualMode && isRevTopicActive(rev.id) && !!onSelectProposal;
                      return (
                        <div key={rev.id} className={`disc-msg${isCounter ? "" : ""}`}>
                          <div className="disc-header">
                            <span className="disc-actor" style={{ color: meta.color }}>{meta.label}</span>
                            <span className="disc-badge">{isCounter ? "반박" : "제안"}</span>
                            {showSelectBtn && (
                              <button className="disc-select-btn" onClick={() => onSelectProposal!(rev.id)} title={`이 제안을 채택합니다: ${rp.value}`}>채택</button>
                            )}
                          </div>
                          <div className="disc-value">{rp.value}</div>
                          {rp.reason && <div className="disc-reason">{rp.reason}</div>}
                        </div>
                      );
                    })}
                    <button className="disc-group-toggle" onClick={() => toggleGroup(g.key)}>▲ 접기</button>
                  </>
                ) : (
                  <div className="disc-msg disc-group-collapsed">
                    <div className="disc-header">
                      <span className="disc-actor" style={{ color: meta.color }}>{meta.label}</span>
                      <span className="disc-badge">{isCounter ? "반박" : "제안"}</span>
                      <span className="disc-group-count">×{g.revs.length}</span>
                      {showGroupSelectBtn && (
                        <button className="disc-select-btn" onClick={() => onSelectProposal!(latestRevId)} title={`이 제안을 채택합니다: ${g.displayValue}`}>채택</button>
                      )}
                    </div>
                    <div className="disc-value">{g.displayValue}</div>
                    {g.latestReason && <div className="disc-reason">{g.latestReason}</div>}
                    <button className="disc-group-toggle" onClick={() => toggleGroup(g.key)}>▾ 발언 {g.revs.length}개 펼치기</button>
                  </div>
                )}
              </div>
            );
          }

          // ── 단일 메시지 (count=1 포함) ──
          const rev = item.kind === "group" ? item.revs[0] : item.rev;
          const p    = rev.patch.payload as unknown as Record<string, unknown>;
          const meta = ACTOR_META[rev.author] ?? { label: rev.author, color: "#858585" };
          const t    = rev.patch.payload.type;
          const isConsensus    = t === "consensus_reached";
          const isInterjection = t === "user_interjection";
          const isCounter      = t === "propose_alternative";

          const isDeadlock  = t === "discussion_deadlock";
          const isPaused    = t === "discussion_paused";

          const consensusSource = isConsensus ? getConsensusSourceFromRevision(rev) : undefined;
          const badgeLabel =
            isConsensus    ? getConsensusSourceLabel(consensusSource) :
            isDeadlock     ? "교착 감지" :
            isPaused       ? "토론 중지" :
            isInterjection ? "의견"     :
            isCounter      ? "반박"     : "제안";

          const displayValue =
            isDeadlock     ? (p.reason as string ?? "교착 상태") :
            isPaused       ? (
              (p as Record<string, unknown>).reason === "user_stop"       ? "사용자가 토론을 중지했습니다" :
              (p as Record<string, unknown>).reason === "safety_limit"    ? "안전 한도에 도달했습니다" :
              (p as Record<string, unknown>).reason === "hard_timeout"    ? "강제 보호 종료됨 (앱 한도)" :
              (p as Record<string, unknown>).reason === "stagnation"      ? "새 논거가 소진되어 토론이 자동 종료되었습니다" :
              (p as Record<string, unknown>).reason === "soft_consensus"  ? "AI 참여자 논거가 의미적으로 수렴하여 자동 종료되었습니다" :
                                                                            "응답 지연으로 일시 중지됨"
            ) :
            isInterjection ? (p.message as string ?? "") :
            isConsensus    ? (evoConclusion ?? (p.selected as string ?? "")) :
                             (p.value    as string ?? "");

          const displayReason = isConsensus
            ? evoConclusion
              ? `${getConsensusSourceDescription(consensusSource)} 분석 결론은 별도 계산입니다. 초기 선택: ${p.selected as string ?? ""} — ${p.winner ?? ""}`
              : `${getConsensusSourceDescription(consensusSource)} 결정: ${p.winner ?? ""}`
            : (!isInterjection && !isDeadlock && !isPaused ? (p.reason as string ?? "") : "");

          const showSelectBtn =
            isManualMode && !isConsensus && !isInterjection &&
            isRevTopicActive(rev.id) && !!onSelectProposal;

          return (
            <div
              key={rev.id}
              className={`disc-msg${isConsensus ? " disc-consensus" : ""}${isInterjection ? " disc-interjection" : ""}${isDeadlock ? " disc-deadlock" : ""}${isPaused ? " disc-paused" : ""}`}
            >
              <div className="disc-header">
                <span className="disc-actor" style={{ color: meta.color }}>{meta.label}</span>
                <span className={`disc-badge${isConsensus ? " consensus" : ""}${isInterjection ? " interjection" : ""}${isDeadlock ? " deadlock" : ""}${isPaused ? " paused" : ""}`}>
                  {badgeLabel}
                </span>
                {isConsensus && demoMeta.isDemo && <DemoModeBadge compact />}
                {showSelectBtn && (
                  <button
                    className="disc-select-btn"
                    onClick={() => onSelectProposal!(rev.id)}
                    title={`이 제안을 채택합니다: ${displayValue}`}
                  >
                    채택
                  </button>
                )}
              </div>
              <div className="disc-value">{displayValue}</div>
              {displayReason && <div className="disc-reason">{displayReason}</div>}
            </div>
          );
        })}
      </div>
      {hasActiveDeadlock && !deadlockDismissed && (
        <div className="disc-deadlock-cta">
          <span className="disc-deadlock-cta-msg">교착 상태가 감지됐습니다 — 계속 진행하거나 토론을 중지하세요</span>
          <div className="disc-deadlock-cta-btns">
            <button className="disc-deadlock-stop-btn" onClick={() => onStopDiscussion?.()}>토론 중지</button>
            <button className="disc-deadlock-continue-btn" onClick={() => setDeadlockDismissed(true)}>계속 진행</button>
          </div>
        </div>
      )}
      {showInput && (
        <div className="disc-interject-area">
          {/* decided 이후 continuation 안내 */}
          {isLiveSession && !liveRunning && (evoConclusion || decidedValue) && (
            <div className="disc-decided-hint">
              {topicAnalysis?.convergenceFreeze?.frozen ? (
                <>
                  <span className="disc-freeze-badge">논리 수렴 완료</span>
                  {evoConclusion && <strong>{evoConclusion}</strong>}
                </>
              ) : evoConclusion ? (
                <>진화된 합의: <strong>{evoConclusion}</strong></>
              ) : (
                <>✔ 현재 결론: <strong>{decidedValue}</strong></>
              )}
              <span className="disc-decided-hint-sub"> — 추가 의견을 입력하면 토론이 다시 열립니다</span>
            </div>
          )}
          <div className="disc-interject">
            <input
              ref={interjectRef}
              className="disc-interject-input"
              placeholder={liveRunning ? "의견 입력 (예: 비용보다 유지보수 우선)" : "추가 의견 / 재토론 주제 입력..."}
              value={interjectText}
              onChange={e => setInterjectText(e.target.value)}
              onKeyDown={e => {
                if (e.nativeEvent.isComposing) return; // 한글 조합 중 Enter는 전송하지 않음
                if (e.key === "Enter" && !liveRunning) sendInterjection();
              }}
              disabled={liveRunning} // AI가 응답 중일 때는 입력 비활성화
            />
            <button
              className="disc-interject-btn"
              onClick={sendInterjection}
              disabled={!interjectText.trim() || liveRunning}
            >
              {liveRunning ? "..." : "보내기"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function WsLogRow({ entry }: { entry: WsLogEntry }) {
  const isApplied = entry.type === "file_edit_applied";
  return (
    <div className="rev-row ws-edit-row">
      <span className="rev-id">ws</span>
      <span className={`rev-author ${isApplied ? "claude" : "gpt"}`}>
        {isApplied ? "applied" : "proposed"}
      </span>
      <div className="rev-content">
        <span className="rev-type">{entry.type}</span>
        <span className="rev-value">{entry.relativePath}</span>
        {entry.summary && <span className="rev-rat">{entry.summary}</span>}
      </div>
    </div>
  );
}

function RevisionRow({ rev, isSelected, onClick, revMap }: {
  rev: Revision; isSelected: boolean; onClick: () => void;
  revMap?: Map<number, Revision>;
}) {
  const p = rev.patch;
  const payload = p.payload as unknown as Record<string, unknown>;
  const value = (payload.value ?? payload.goal ?? payload.selected ?? payload.message ?? "") as string;
  const meta = ACTOR_META[rev.author] ?? { label: rev.author, color: "#858585" };

  // 반박 대상: refs[0]의 author를 표시
  const replyToRev = p.references?.[0] != null ? revMap?.get(p.references[0]) : undefined;
  const replyMeta  = replyToRev ? (ACTOR_META[replyToRev.author] ?? { label: replyToRev.author, color: "#858585" }) : null;

  return (
    <div className={`rev-row ${isSelected ? "selected" : ""}`} onClick={onClick}>
      <span className="rev-id">#{rev.id}</span>
      <span className="rev-author" style={{ color: meta.color }}>{meta.label}</span>
      <div className="rev-content">
        {replyMeta && (
          <span className="rev-reply">↩ <span style={{ color: replyMeta.color }}>{replyMeta.label}</span></span>
        )}
        <span className={`rev-type${p.type === "consensus_reached" ? " consensus" : p.type === "user_interjection" ? " interjection" : p.type === "discussion_deadlock" ? " deadlock" : p.type === "discussion_paused" ? " paused" : ""}`}>
          {p.type}
        </span>
        {value && <span className="rev-value">{value}</span>}
        {p.rationale && <span className="rev-rat">{p.rationale}</span>}
      </div>
    </div>
  );
}

// ─── Metrics Bar ─────────────────────────────────────────────────

function MetricsBar({ result }: { result: RunResult | null }) {
  const m = result?.metrics;
  const lat = m?.latencyMs ?? [];
  const avg = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0;
  const max = lat.length ? Math.max(...lat) : 0;

  return (
    <details className="metrics">
      <summary>고급 정보</summary>
      <div className="metrics-panel">
      <MetricGroup label="GPT">
        <MetricItem name="calls"     value={m?.calls.gpt.total     ?? 0} />
        <MetricItem name="ok"        value={m?.calls.gpt.parseOk   ?? 0} accent="ok" />
        <MetricItem name="parseFail" value={m?.calls.gpt.parseFail ?? 0} accent={(m?.calls.gpt.parseFail ?? 0) > 0 ? "warn" : undefined} />
        <MetricItem name="apiErr"    value={m?.calls.gpt.apiError  ?? 0} accent={(m?.calls.gpt.apiError  ?? 0) > 0 ? "err"  : undefined} />
      </MetricGroup>
      <div className="metrics-sep" />
      <MetricGroup label="Claude">
        <MetricItem name="calls"     value={m?.calls.claude.total     ?? 0} />
        <MetricItem name="ok"        value={m?.calls.claude.parseOk   ?? 0} accent="ok" />
        <MetricItem name="parseFail" value={m?.calls.claude.parseFail ?? 0} accent={(m?.calls.claude.parseFail ?? 0) > 0 ? "warn" : undefined} />
        <MetricItem name="apiErr"    value={m?.calls.claude.apiError  ?? 0} accent={(m?.calls.claude.apiError  ?? 0) > 0 ? "err"  : undefined} />
      </MetricGroup>
      {(m?.calls.gemini?.total ?? 0) > 0 && (
        <>
          <div className="metrics-sep" />
          <MetricGroup label="Gemini">
            <MetricItem name="calls"     value={m!.calls.gemini.total} />
            <MetricItem name="ok"        value={m!.calls.gemini.parseOk}   accent="ok" />
            <MetricItem name="parseFail" value={m!.calls.gemini.parseFail} accent={m!.calls.gemini.parseFail > 0 ? "warn" : undefined} />
            <MetricItem name="apiErr"    value={m!.calls.gemini.apiError}  accent={m!.calls.gemini.apiError  > 0 ? "err"  : undefined} />
          </MetricGroup>
        </>
      )}
      <div className="metrics-sep" />
      <MetricGroup label="Latency">
        <MetricItem name="avg"    value={`${avg}ms`} />
        <MetricItem name="max"    value={`${max}ms`} />
        <MetricItem name="tokens" value={(m?.tokens.prompt ?? 0) + (m?.tokens.completion ?? 0)} />
      </MetricGroup>
      <div className="metrics-sep" />
      <MetricGroup label="Topics">
        <MetricItem name="decided"   value={m?.topics.decided   ?? 0} accent={(m?.topics.decided   ?? 0) > 0 ? "ok"  : undefined} />
        <MetricItem name="undecided" value={m?.topics.undecided ?? 0} accent={(m?.topics.undecided ?? 0) > 0 ? "err" : undefined} />
      </MetricGroup>
      </div>
    </details>
  );
}

function MetricGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="metric-group">
      <span className="metric-group-label">{label}</span>
      <div className="metric-group-items">{children}</div>
    </div>
  );
}

function MetricItem({ name, value, accent }: {
  name: string; value: string | number; accent?: "ok" | "warn" | "err";
}) {
  return (
    <span className="metric">
      {name}<span className={accent ?? ""}> {value}</span>
    </span>
  );
}

function getWorkspaceFallbackMessage(reason?: WorkspaceFallbackReason): string {
  if (reason === "missing_api_key")
    return "Claude API 키가 없어 워크스페이스 데모 응답으로 실행됩니다.";
  if (reason === "provider_error")
    return "Claude 호출에 실패해 워크스페이스 데모 응답으로 전환되었습니다.";
  return "워크스페이스 데모 응답으로 전환되었습니다.";
}

// ─── Workspace AI Chat Panel ──────────────────────────────────────

function WsChatPanel({ messages, linkedTopic, provider, plan, planBusy, busy, onSend, onGeneratePlan, onToggleStep }: {
  messages:        WsChatMessage[];
  linkedTopic:     TopicContext | null | undefined;
  provider:        "claude" | "mock" | null;
  plan:            WorkspacePlan | null;
  planBusy:        boolean;
  busy:            boolean;
  onSend:          (text: string) => void;
  onGeneratePlan:  () => void;
  onToggleStep:    (stepId: string) => void;
}) {
  const [input, setInput] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (bodyRef.current)
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages]);

  function send() {
    const t = input.trim();
    if (!t || busy) return;
    onSend(t);
    setInput("");
    // 한글 IME 조합 잔상 방지: DOM value도 즉시 비운다
    if (inputRef.current) inputRef.current.value = "";
  }

  const planIsMock = plan?.provider === "mock";

  return (
    <div className="ws-chat">
      <div className="ws-chat-title">
        AI Chat
        {provider && (
          <span className={`ws-chat-provider ws-chat-provider-${provider}`}>
            {provider === "claude" ? "Claude" : "Mock (offline)"}
          </span>
        )}
        {linkedTopic && <span className="ws-chat-linked">● linked</span>}
      </div>
      {linkedTopic && (
        <div className="ws-chat-context">
          <div className="ws-chat-context-goal">{linkedTopic.goal}</div>
          <div className="ws-chat-context-decision">
            → <span>{linkedTopic.selectedValue}</span>
          </div>
          {linkedTopic.alternatives.length > 0 && (
            <div className="ws-chat-context-alts">
              대안: {linkedTopic.alternatives.map(a => a.value).join(", ")}
            </div>
          )}
          <div className="ws-plan-gen-row">
            <button
              className="ws-plan-gen-btn"
              onClick={onGeneratePlan}
              disabled={planBusy || busy}
            >
              {planBusy ? "계획 생성 중..." : plan ? "↻ 재생성" : "구현 계획 생성"}
            </button>
          </div>
        </div>
      )}
      {plan && (
        <div className="ws-plan-section">
          <div className="ws-plan-header">
            <span className="ws-plan-title">{plan.title}</span>
            <div className="ws-plan-header-meta">
              <span className={`ws-plan-provider ws-plan-provider-${plan.provider}`}>
                {plan.provider === "claude" ? "Claude" : "Mock plan"}
              </span>
              <span className="ws-plan-meta">
                {plan.steps.filter(s => s.status === "completed").length}/{plan.steps.length}
              </span>
            </div>
          </div>
          {planIsMock && (
            <div className="ws-plan-warning">
              Claude API를 사용할 수 없어 데모 계획으로 생성되었습니다.
            </div>
          )}
          {plan.steps.map((step: WorkspacePlanStep) => (
            <div key={step.id} className={`ws-plan-step ws-plan-${step.status}`}>
              <button
                className="ws-plan-check"
                onClick={() => onToggleStep(step.id)}
                title={step.status === "completed" ? "완료 취소" : "완료 표시"}
              >
                {step.status === "completed" ? "✓" : "○"}
              </button>
              <span className="ws-plan-step-title">{step.title}</span>
              <button
                className="ws-plan-ask"
                onClick={() => onSend(`"${step.title}" 단계를 자세히 설명해줘`)}
                title="AI에게 물어보기"
              >
                ?
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="ws-chat-body" ref={bodyRef}>
        {messages.length === 0 ? (
          <div className="ws-chat-empty">
            {linkedTopic
              ? `"${linkedTopic.selectedValue}" 기준으로 질문하세요`
              : "파일 또는 코드에 대해 질문하세요"}
          </div>
        ) : messages.map(m =>
          m.type === "system" ? (
            <div key={m.id} className="ws-chat-msg ws-chat-system">
              <div className="ws-chat-msg-content">{m.content}</div>
            </div>
          ) : (
            <div key={m.id} className={`ws-chat-msg ws-chat-${m.role}`}>
              <div className="ws-chat-msg-header">
                <span className="ws-chat-msg-role">{m.role === "user" ? "나" : "AI"}</span>
                <span className="ws-chat-msg-time">{m.timestamp}</span>
              </div>
              <div className="ws-chat-msg-content">{m.content}</div>
            </div>
          )
        )}
        {busy && (
          <div className="ws-chat-msg ws-chat-assistant ws-chat-thinking">
            <div className="ws-chat-msg-header">
              <span className="ws-chat-msg-role">AI</span>
            </div>
            <div className="ws-chat-msg-content">생각 중...</div>
          </div>
        )}
      </div>
      <div className="ws-chat-input-area">
        <textarea
          ref={inputRef}
          className="ws-chat-input"
          placeholder={busy ? "응답 대기 중..." : "구현, 코드, 구조에 대해 질문하세요 (Enter 전송)"}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing) return; // 한글 조합 중 Enter는 전송하지 않음
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={busy}
          rows={3}
        />
        <button
          className="ws-chat-send"
          onClick={send}
          disabled={!input.trim() || busy}
        >
          {busy ? "..." : "전송"}
        </button>
      </div>
    </div>
  );
}

// ─── Workspace Editor ─────────────────────────────────────────────

function WorkspaceEditor({ wsState, setWsState, wsLog, addWsLog, clearWsLog,
                           linkedTopic, onClearLinkedTopic }: {
  wsState:    WsEditorState;
  setWsState: React.Dispatch<React.SetStateAction<WsEditorState>>;
  wsLog:      WsLogEntry[];
  addWsLog:   (entry: Omit<WsLogEntry, "id">) => void;
  clearWsLog: () => void;
  linkedTopic?:       TopicContext | null;
  onClearLinkedTopic?: () => void;
}) {
  const { workspacePath, files, skipped, selectedFile, original, proposed, proposeSummary, expandedFolders } = wsState;

  // 트랜지언트 UI state — 탭 전환 시 초기화돼도 무방
  const [status,    setStatus]    = useState("");
  const [statusType,setStatusType]= useState<"" | "ok" | "err" | "info">("");
  const [busy,      setBusy]      = useState(false);

  const [wsChatMessages, setWsChatMessages] = useState<WsChatMessage[]>([]);
  const [wsChatBusy,     setWsChatBusy]     = useState(false);
  const [wsChatProvider, setWsChatProvider] = useState<"claude" | "mock" | null>(null);
  const [wsPlan,         setWsPlan]         = useState<WorkspacePlan | null>(null);
  const [planBusy,       setPlanBusy]       = useState(false);
  const wsChatMsgId      = useRef(0);
  const prevProviderRef  = useRef<"claude" | "mock" | null>(null);

  const tree = useMemo(() => buildTree(files), [files]);

  function patch<K extends keyof WsEditorState>(key: K, val: WsEditorState[K]) {
    setWsState(prev => ({ ...prev, [key]: val }));
  }

  function toggleFolder(path: string) {
    setWsState(prev => {
      const next = new Set(prev.expandedFolders);
      next.has(path) ? next.delete(path) : next.add(path);
      return { ...prev, expandedFolders: next };
    });
  }

  function showStatus(msg: string, type: "ok" | "err" | "info" = "info") {
    setStatus(msg); setStatusType(type);
  }

  async function openWorkspace() {
    const res = await window.api.selectWorkspace();
    if (res.canceled) return;
    const wp = res.workspacePath;
    setWsState(prev => ({
      ...prev,
      workspacePath: wp,
      selectedFile: null, original: null, proposed: null, proposeSummary: "",
    }));
    clearWsLog();
    showStatus("스캔 중...", "info");
    setBusy(true);
    const scan = await window.api.scanWorkspace(wp);
    const topLevel = buildTree(scan.files)
      .filter((n): n is FileTreeNode & { type: "folder" } => n.type === "folder")
      .map(n => n.path);
    setWsState(prev => ({
      ...prev,
      files: scan.files,
      skipped: scan.skipped,
      expandedFolders: new Set(topLevel),
    }));
    setBusy(false);
    showStatus(
      `${scan.files.length}개 파일${scan.skipped > 0 ? ` (+${scan.skipped}개 제외)` : ""}`,
      "ok",
    );
  }

  async function selectFile(rel: string) {
    if (!workspacePath) return;
    setWsState(prev => ({ ...prev, selectedFile: rel, original: null, proposed: null, proposeSummary: "" }));
    showStatus("파일 읽는 중...", "info");
    const res = await window.api.readWorkspaceFile(workspacePath, rel);
    if (!res.ok) { showStatus(res.error, "err"); return; }
    patch("original", res.content.replace(/\r\n/g, "\n"));
    showStatus(rel, "ok");
  }

  function proposeEdit() {
    if (!selectedFile || original === null) return;
    const res = mockEdit(selectedFile, original);
    if ("error" in res) { showStatus(res.error, "err"); return; }
    setWsState(prev => ({ ...prev, proposed: res.result, proposeSummary: res.summary }));
    addWsLog({
      type: "file_edit_proposed",
      relativePath: selectedFile,
      summary: res.summary,
      timestamp: new Date().toLocaleTimeString(),
    });
    showStatus(`제안: ${res.summary}`, "info");
  }

  async function applyEdit() {
    if (!workspacePath || !selectedFile || proposed === null) return;
    const confirmed = window.confirm(
      `이 변경을 실제 파일에 적용할까요?\n\n파일: ${selectedFile}\n변경: ${proposeSummary || "수정 제안"}`,
    );
    if (!confirmed) return;
    setBusy(true);
    showStatus("저장 중...", "info");
    const res = await window.api.writeWorkspaceFile(workspacePath, selectedFile, proposed);
    setBusy(false);
    if (!res.ok) { showStatus(res.error, "err"); return; }
    const saved = proposed;
    setWsState(prev => ({ ...prev, original: saved, proposed: null, proposeSummary: "" }));
    addWsLog({
      type: "file_edit_applied",
      relativePath: selectedFile,
      summary: "사용자가 diff 확인 후 변경을 적용함",
      timestamp: new Date().toLocaleTimeString(),
    });
    showStatus(`저장됨: ${selectedFile}`, "ok");
  }

  async function handleChatSend(text: string) {
    const userMsg: WsChatMessage = {
      id:        ++wsChatMsgId.current,
      role:      "user",
      content:   text,
      timestamp: new Date().toLocaleTimeString(),
    };
    setWsChatMessages(prev => [...prev, userMsg]);
    setWsChatBusy(true);

    const apiMessages = [...wsChatMessages, userMsg].map(m => ({
      role:    m.role as "user" | "assistant",
      content: m.content,
    }));

    const res = await window.api.workspaceChat({
      messages:    apiMessages,
      linkedTopic: linkedTopic ?? undefined,
    });

    if (res.ok) {
      const isFirstFallback = res.provider === "mock" && prevProviderRef.current !== "mock";
      prevProviderRef.current = res.provider;
      setWsChatProvider(res.provider);

      setWsChatMessages(prev => {
        const appended: WsChatMessage[] = [];
        if (isFirstFallback) {
          appended.push({
            id:        ++wsChatMsgId.current,
            role:      "assistant",
            content:   getWorkspaceFallbackMessage(res.fallbackReason),
            timestamp: new Date().toLocaleTimeString(),
            type:      "system",
          });
        }
        appended.push({
          id:        ++wsChatMsgId.current,
          role:      "assistant",
          content:   res.content,
          timestamp: new Date().toLocaleTimeString(),
        });
        return [...prev, ...appended];
      });
    } else {
      setWsChatMessages(prev => [...prev, {
        id:        ++wsChatMsgId.current,
        role:      "assistant",
        content:   `오류: ${res.error}`,
        timestamp: new Date().toLocaleTimeString(),
        type:      "system",
      }]);
    }
    setWsChatBusy(false);
  }

  async function handleGeneratePlan() {
    setPlanBusy(true);
    const res = await window.api.generateWorkspacePlan({
      linkedTopic: linkedTopic ?? undefined,
    });
    if (res.ok) {
      setWsPlan(res.plan);
      if (res.provider === "mock") {
        setWsChatMessages(prev => [...prev, {
          id:        ++wsChatMsgId.current,
          role:      "assistant",
          content:   `구현 계획: ${getWorkspaceFallbackMessage(res.fallbackReason)}`,
          timestamp: new Date().toLocaleTimeString(),
          type:      "system",
        }]);
      }
    } else {
      setWsChatMessages(prev => [...prev, {
        id:        ++wsChatMsgId.current,
        role:      "assistant",
        content:   `계획 생성 실패: ${res.error}`,
        timestamp: new Date().toLocaleTimeString(),
        type:      "system",
      }]);
    }
    setPlanBusy(false);
  }

  function handleToggleStep(stepId: string) {
    setWsPlan(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        steps: prev.steps.map(s =>
          s.id === stepId
            ? { ...s, status: s.status === "pending" ? "completed" : "pending" }
            : s,
        ),
      };
    });
  }

  const diff = useMemo(
    () => original !== null && proposed !== null ? computeDiff(original, proposed) : null,
    [original, proposed],
  );

  const diffStats = useMemo(() => {
    if (!diff) return null;
    return {
      added:     diff.filter(l => l.type === "add").length,
      removed:   diff.filter(l => l.type === "remove").length,
      unchanged: diff.filter(l => l.type === "same").length,
    };
  }, [diff]);

  const noChange = diff !== null && diffStats?.added === 0 && diffStats?.removed === 0;

  return (
    <div className="workspace-editor">
      {/* Revision 연결 컨텍스트 배너 */}
      {linkedTopic && (
        <div className="ws-linked-banner">
          <div className="ws-linked-main">
            <span className="ws-linked-label">연결된 토론</span>
            <span className="ws-linked-goal">{linkedTopic.goal}</span>
            <span className="ws-linked-arrow">→</span>
            <span className="ws-linked-decision">{linkedTopic.selectedValue}</span>
            <span className="ws-linked-by">by {linkedTopic.selectedBy}</span>
          </div>
          {linkedTopic.alternatives.length > 0 && (
            <div className="ws-linked-alts">
              대안: {linkedTopic.alternatives.map(a => a.value).join(" / ")}
            </div>
          )}
          <button className="ws-linked-clear" onClick={onClearLinkedTopic} title="연결 해제">✕</button>
        </div>
      )}
      {/* Toolbar */}
      <div className="ws-toolbar">
        <button onClick={openWorkspace} disabled={busy}>워크스페이스 열기</button>
        <span className="ws-path">
          {workspacePath
            ? workspacePath
            : "폴더를 선택하면 파일 목록이 표시됩니다"}
        </span>
      </div>

      {/* Body */}
      <div className="ws-body">

        {/* File Explorer */}
        <div className="ws-explorer">
          <div className="ws-explorer-title">
            Files
            {files.length > 0 && (
              <span className="ws-file-count">{files.length}</span>
            )}
          </div>
          <div className="ws-file-list">
            {!workspacePath ? (
              <div className="ws-empty-hint">워크스페이스를 먼저 선택하세요</div>
            ) : files.length === 0 ? (
              <div className="ws-empty-hint">파일 없음</div>
            ) : (
              <FileTree
                nodes={tree}
                depth={0}
                expandedFolders={expandedFolders}
                selectedFile={selectedFile}
                busy={busy}
                onToggleFolder={toggleFolder}
                onSelectFile={path => !busy && selectFile(path)}
              />
            )}
            {skipped > 0 && (
              <div className="ws-skipped">+{skipped}개 생략 (제한 초과)</div>
            )}
          </div>
        </div>

        {/* Panels */}
        <div className="ws-panels">

          {/* 원본 */}
          <div className="ws-panel">
            <div className="ws-panel-title">원본</div>
            <div className="ws-panel-body">
              {original === null ? (
                <div className="empty">파일을 선택하세요</div>
              ) : (
                <textarea className="ws-code" readOnly value={original} />
              )}
            </div>
          </div>

          {/* 수정 제안 / diff */}
          <div className="ws-panel">
            <div className="ws-panel-title">수정 제안</div>
            <div className="ws-panel-body">
              {proposed === null ? (
                <div className="empty">
                  {original !== null
                    ? "수정 제안 버튼을 누르세요"
                    : "파일을 선택하세요"}
                </div>
              ) : noChange ? (
                <div className="empty">변경 없음 (내용 동일)</div>
              ) : (
                <>
                  <div className="diff-stats-bar">
                    <span className="diff-stat add">+{diffStats!.added} added</span>
                    <span className="diff-stat remove">-{diffStats!.removed} removed</span>
                    <span className="diff-stat same">{diffStats!.unchanged} unchanged</span>
                  </div>
                  <div className="diff-view">
                    {diff!.map((line, i) => (
                      <div key={i} className={`diff-line ${line.type}`}>
                        <span className="diff-sign">
                          {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
                        </span>
                        <span className="diff-text">{line.text}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* 수정 기록 */}
          <div className="ws-log-panel">
            <div className="ws-panel-title">수정 기록</div>
            <div className="ws-panel-body">
              {wsLog.length === 0 ? (
                <div className="empty">기록 없음</div>
              ) : wsLog.map(entry => (
                <div key={entry.id} className="ws-log-entry">
                  <div className={`ws-log-type ${entry.type === "file_edit_proposed" ? "proposed" : "applied"}`}>
                    {entry.type === "file_edit_proposed" ? "제안됨" : "적용됨"}
                  </div>
                  <div className="ws-log-path" title={entry.relativePath}>
                    {entry.relativePath.length > 32
                      ? "…" + entry.relativePath.slice(-29)
                      : entry.relativePath}
                  </div>
                  {entry.type === "file_edit_proposed" && (
                    <div className="ws-log-summary">{entry.summary}</div>
                  )}
                  <div className="ws-log-time">{entry.timestamp}</div>
                </div>
              ))}
            </div>
          </div>

        </div>

        <WsChatPanel
          messages={wsChatMessages}
          linkedTopic={linkedTopic}
          provider={wsChatProvider}
          plan={wsPlan}
          planBusy={planBusy}
          busy={wsChatBusy}
          onSend={handleChatSend}
          onGeneratePlan={handleGeneratePlan}
          onToggleStep={handleToggleStep}
        />
      </div>

      {/* Footer */}
      <div className="ws-footer">
        <button
          className="primary"
          onClick={proposeEdit}
          disabled={busy || original === null}
        >
          수정 제안
        </button>
        <button
          onClick={applyEdit}
          disabled={busy || proposed === null || noChange}
        >
          Apply
        </button>
        {proposeSummary && <span className="ws-propose-summary">{proposeSummary}</span>}
        <span className={`ws-status ${statusType}`}>{status}</span>
      </div>
    </div>
  );
}

// ─── File Tree Component ──────────────────────────────────────────

function FileTree({ nodes, depth, expandedFolders, selectedFile, busy, onToggleFolder, onSelectFile }: {
  nodes: FileTreeNode[];
  depth: number;
  expandedFolders: Set<string>;
  selectedFile: string | null;
  busy: boolean;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  return (
    <>
      {nodes.map(node =>
        node.type === "folder" ? (
          <div key={node.path}>
            <div
              className="ws-tree-folder"
              style={{ paddingLeft: `${6 + depth * 14}px` }}
              onClick={() => onToggleFolder(node.path)}
              title={node.path}
            >
              <span className="ws-tree-arrow">
                {expandedFolders.has(node.path) ? "▾" : "▸"}
              </span>
              {node.name}
            </div>
            {expandedFolders.has(node.path) && (
              <FileTree
                nodes={node.children}
                depth={depth + 1}
                expandedFolders={expandedFolders}
                selectedFile={selectedFile}
                busy={busy}
                onToggleFolder={onToggleFolder}
                onSelectFile={onSelectFile}
              />
            )}
          </div>
        ) : (
          <div
            key={node.path}
            className={`ws-file-item ${selectedFile === node.path ? "selected" : ""}`}
            style={{ paddingLeft: `${18 + depth * 14}px` }}
            onClick={() => !busy && onSelectFile(node.path)}
            title={node.path}
          >
            {node.name}
          </div>
        )
      )}
    </>
  );
}
