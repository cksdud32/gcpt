import { contextBridge, ipcRenderer } from "electron";
import type { RunResult } from "../../src/test-modes";
import type { Revision, Topic, DiscussionMode, DiscussionDepth, ConsensusMode, ProvidersConfig, InteractionStyle } from "../../src/types";
import type { WorkspacePlan } from "../../src/workspace-providers";

type DiscussionUpdate = { history: Revision[]; topics: Topic[] };

contextBridge.exposeInMainWorld("api", {
  // ─── Revision Engine ─────────────────────────────────────────────
  runMode:     (mode: string, dm: DiscussionMode): Promise<RunResult>    => ipcRenderer.invoke("run-mode",   mode, dm),
  runCustom:   (goalText: string, dm: DiscussionMode): Promise<RunResult> => ipcRenderer.invoke("run-custom", goalText, dm),
  runAll:      ():                 Promise<RunResult[]>                         => ipcRenderer.invoke("run-all"),
  saveSession: (json: string):     Promise<{ canceled: boolean; filePath?: string }> => ipcRenderer.invoke("save-session", json),
  loadSession: (): Promise<{ ok: true; content: string } | { ok: false; canceled?: boolean; error?: string }> => ipcRenderer.invoke("load-session"),

  // ─── Workspace Editor ────────────────────────────────────────────
  selectWorkspace: (): Promise<
    | { canceled: true }
    | { canceled: false; workspacePath: string }
  > => ipcRenderer.invoke("select-workspace"),

  scanWorkspace: (workspacePath: string): Promise<{
    files: string[]; skipped: number;
  }> => ipcRenderer.invoke("scan-workspace", workspacePath),

  readWorkspaceFile: (workspacePath: string, relativePath: string): Promise<
    | { ok: true; content: string }
    | { ok: false; error: string }
  > => ipcRenderer.invoke("read-workspace-file", workspacePath, relativePath),

  writeWorkspaceFile: (workspacePath: string, relativePath: string, content: string): Promise<
    | { ok: true }
    | { ok: false; error: string }
  > => ipcRenderer.invoke("write-workspace-file", workspacePath, relativePath, content),

  workspaceChat: (payload: {
    messages:     { role: "user" | "assistant"; content: string }[];
    linkedTopic?: {
      goal:          string;
      selectedValue: string;
      selectedBy:    string;
      alternatives:  Array<{ value: string; author: string }>;
      mode?:         string;
    };
  }): Promise<
    | { ok: true;  content: string; provider: "claude" | "mock" }
    | { ok: false; error: string }
  > => ipcRenderer.invoke("workspace:chat", payload),

  generateWorkspacePlan: (payload: {
    linkedTopic?: {
      goal:          string;
      selectedValue: string;
      selectedBy:    string;
      alternatives:  Array<{ value: string; author: string }>;
      mode?:         string;
    };
  }): Promise<
    | { ok: true;  plan: WorkspacePlan }
    | { ok: false; error: string }
  > => ipcRenderer.invoke("workspace:generate-plan", payload),

  // ─── Live Discussion ─────────────────────────────────────────────
  // fire-and-forget: main이 즉시 { ok: true } 반환 → await에 묶이지 않음
  startLiveDiscussion: (payload: {
    goals: string[];
    mode?: DiscussionMode;
    depth?: DiscussionDepth;
    consensusMode?: ConsensusMode;
    safetyLimitEnabled?: boolean;
    interactionStyle?: InteractionStyle;
  }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("start-live-discussion", payload),

  sendInterjection: (payload: { message: string; safetyLimitEnabled?: boolean }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("discussion:interject", payload),

  stopDiscussion: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("discussion:stop"),

  acceptConsensus: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("discussion:accept"),

  selectProposal: (revisionId: number): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("discussion:select-proposal", revisionId),

  // ─── Provider Settings ───────────────────────────────────────────
  getProviderSettings: (): Promise<ProvidersConfig> =>
    ipcRenderer.invoke("provider:getSettings"),

  saveProviderSettings: (settings: ProvidersConfig): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("provider:saveSettings", settings),

  testProviderConnection: (provider: "gpt" | "claude" | "gemini"): Promise<{ ok: boolean; latency?: number; error?: string }> =>
    ipcRenderer.invoke("provider:testConnection", provider),

  // 최초 실행 이벤트 — API 키가 설정되지 않은 상태로 앱이 처음 시작될 때
  onFirstRun: (cb: () => void): (() => void) => {
    const fn = () => cb();
    ipcRenderer.once("app:first-run", fn);
    return () => ipcRenderer.removeListener("app:first-run", fn);
  },

  // 이벤트 리스너 — cleanup 함수를 반환합니다
  // 단일 이벤트: history + topics 동시 전달 → 렌더러 단일 setState
  onDiscussionUpdate: (cb: (u: DiscussionUpdate) => void): (() => void) => {
    const fn = (_: Electron.IpcRendererEvent, u: DiscussionUpdate) => cb(u);
    ipcRenderer.on("discussion:update", fn);
    return () => ipcRenderer.removeListener("discussion:update", fn);
  },
  onDiscussionStatus: (cb: (msg: string) => void): (() => void) => {
    const fn = (_: Electron.IpcRendererEvent, msg: string) => cb(msg);
    ipcRenderer.on("discussion:status", fn);
    return () => ipcRenderer.removeListener("discussion:status", fn);
  },
  // 토론 완료 이벤트 — discussion:done
  onDiscussionDone: (cb: (result: RunResult | null) => void): (() => void) => {
    const fn = (_: Electron.IpcRendererEvent, result: RunResult | null) => cb(result);
    ipcRenderer.on("discussion:done", fn);
    return () => ipcRenderer.removeListener("discussion:done", fn);
  },
});
