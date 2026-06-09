import { contextBridge, ipcRenderer } from "electron";
import type { RunResult } from "../../src/test-modes";
import type { Revision, Topic, DiscussionMode, DiscussionDepth } from "../../src/types";

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

  // ─── Live Discussion ─────────────────────────────────────────────
  // fire-and-forget: main이 즉시 { ok: true } 반환 → await에 묶이지 않음
  startLiveDiscussion: (goals: string[], dm: DiscussionMode, depth: DiscussionDepth): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("start-live-discussion", goals, dm, depth),

  sendInterjection: (message: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("discussion:interject", message),

  acceptConsensus: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("discussion:accept"),

  selectProposal: (revisionId: number): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("discussion:select-proposal", revisionId),

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
