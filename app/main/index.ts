import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { promises as fsp } from "fs";
import { join } from "path";
import { runMode, runCustomGoal } from "../../src/test-modes";
import type { DiscussionMode, DiscussionDepth } from "../../src/types";
import { DEPTH_BUDGETS } from "../../src/types";
import { MOCK_CONFIGS } from "../../src/orchestrator";
import { LiveOrchestrator } from "../../src/live-orchestrator";

let mainWindow: BrowserWindow | null = null;

// webContents.send 안전 래퍼 — 창이 닫힌 후 orphan 이벤트가 도달해도 crash 방지
function safeSend(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#1e1e1e",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ─── Mock 실행 ────────────────────────────────────────────────────

ipcMain.handle("run-mode", async (_event, mode: string, discussionMode: DiscussionMode = "general") => {
  return await runMode(mode, true, discussionMode);
});

ipcMain.handle("run-custom", async (_event, goalText: string, discussionMode: DiscussionMode = "general") => {
  return await runCustomGoal(goalText, true, discussionMode);
});

ipcMain.handle("run-all", async () => {
  const modes = Object.keys(MOCK_CONFIGS);
  const results = [];
  for (const mode of modes) {
    results.push(await runMode(mode, true));
  }
  return results;
});

// ─── 세션 저장 ────────────────────────────────────────────────────

ipcMain.handle("save-session", async (_event, json: string) => {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow!, {
    title: "세션 저장",
    defaultPath: `gcpt-session-${stamp}.json`,
    filters: [{ name: "GCPT Session", extensions: ["json"] }],
  });
  if (canceled || !filePath) return { canceled: true };
  await fsp.writeFile(filePath, json, "utf-8");
  return { canceled: false, filePath };
});

// ─── Workspace ────────────────────────────────────────────────────

const EXCLUDED_DIRS = new Set([
  "node_modules", ".git", "dist", "out", "build",
  ".next", "coverage", ".turbo", ".cache",
]);
const ALLOWED_EXTS  = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".html", ".css"]);
const MAX_FILES     = 500;
const MAX_DEPTH     = 6;
const MAX_FILE_SIZE = 512 * 1024;

async function scanDir(
  dir: string, base: string, depth: number,
  files: string[], counts: { total: number; skipped: number },
): Promise<void> {
  if (depth > MAX_DEPTH || counts.total >= MAX_FILES) return;
  let entries: import("fs").Dirent[];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name))
        await scanDir(join(dir, entry.name), base, depth + 1, files, counts);
    } else if (entry.isFile()) {
      const ext = require("path").extname(entry.name).toLowerCase();
      if (!ALLOWED_EXTS.has(ext)) continue;
      if (counts.total >= MAX_FILES) { counts.skipped++; continue; }
      files.push(require("path").relative(base, join(dir, entry.name)).replace(/\\/g, "/"));
      counts.total++;
    }
  }
}

function withinWorkspace(workspacePath: string, resolved: string): boolean {
  const base = require("path").resolve(workspacePath);
  const full = require("path").resolve(resolved);
  return full === base || full.startsWith(base + require("path").sep);
}

ipcMain.handle("select-workspace", async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow!, {
    title: "워크스페이스 폴더 선택",
    properties: ["openDirectory"],
  });
  if (canceled || filePaths.length === 0) return { canceled: true };
  return { canceled: false, workspacePath: filePaths[0] };
});

ipcMain.handle("scan-workspace", async (_event, workspacePath: string) => {
  const files: string[] = [];
  const counts = { total: 0, skipped: 0 };
  await scanDir(workspacePath, workspacePath, 0, files, counts);
  files.sort();
  return { files, skipped: counts.skipped };
});

ipcMain.handle("read-workspace-file", async (_event, workspacePath: string, relativePath: string) => {
  const resolved = require("path").resolve(workspacePath, relativePath);
  if (!withinWorkspace(workspacePath, resolved))
    return { ok: false, error: "접근 거부: workspace 외부 경로" };
  try {
    const stat = await fsp.stat(resolved);
    if (stat.size > MAX_FILE_SIZE)
      return { ok: false, error: `파일이 너무 큽니다 (${Math.round(stat.size / 1024)}KB > 512KB)` };
    const content = await fsp.readFile(resolved, "utf-8");
    return { ok: true, content };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle("write-workspace-file", async (_event, workspacePath: string, relativePath: string, content: string) => {
  const resolved = require("path").resolve(workspacePath, relativePath);
  if (!withinWorkspace(workspacePath, resolved))
    return { ok: false, error: "접근 거부: workspace 외부 경로" };
  const ext = require("path").extname(resolved).toLowerCase();
  if (!ALLOWED_EXTS.has(ext))
    return { ok: false, error: `허용되지 않는 확장자: ${ext}` };
  try {
    await fsp.writeFile(resolved, content, "utf-8");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

// ─── 세션 불러오기 ────────────────────────────────────────────────

ipcMain.handle("load-session", async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow!, {
    title: "세션 불러오기",
    filters: [{ name: "GCPT Session", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (canceled || filePaths.length === 0) {
    console.log("[main] loadSession: canceled");
    return { ok: false, canceled: true };
  }

  const filePath = filePaths[0];
  console.log("[main] loadSession: selected file:", filePath);

  try {
    const content = await fsp.readFile(filePath, "utf-8");
    console.log("[main] loadSession: file read ok, length:", content.length);
    return { ok: true, content };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[main] loadSession: readFile error:", msg);
    return { ok: false, error: msg };
  }
});

// ─── Live Discussion ──────────────────────────────────────────────

let liveOrchestrator: LiveOrchestrator | null = null;

// fire-and-forget: 즉시 { ok: true } 반환 후 background에서 토론 실행.
// 중간 업데이트는 discussion:update 로, 완료는 discussion:done 으로 push.
// invoke가 runGoals()를 await하면 모든 update가 invoke reply와 함께 한 번에
// 도착해서 React 배칭에 의해 중간 render가 모두 무시되는 문제를 방지.
ipcMain.handle("start-live-discussion", (_event, goals: string[], discussionMode: DiscussionMode = "general", depth: DiscussionDepth = "balanced") => {
  const budget = DEPTH_BUDGETS[depth] ?? DEPTH_BUDGETS.balanced;
  console.log("[main] START LIVE DISCUSSION IPC RECEIVED", goals, "mode=", discussionMode, "depth=", depth);

  // 기존 세션(continuation 대기 포함)을 종료하고 새 세션 시작
  liveOrchestrator?.terminate();

  const orch = new LiveOrchestrator(
    (history, topics) => {
      console.log("[main] discussion:update history.length=", history.length);
      safeSend("discussion:update", { history, topics });
    },
    (msg) => safeSend("discussion:status", msg),
  );
  liveOrchestrator = orch;

  orch.runGoals(goals, discussionMode, budget, (snapshot) => {
    // 초기 goal 완료 또는 interjection 사이클 완료 시 호출됨
    console.log("[main] discussion:done revisionCount=", snapshot.revisionCount);
    safeSend("discussion:done", snapshot);
  })
  .catch(err => {
    console.error("[main] discussion error:", err);
    safeSend("discussion:done", null);
  })
  .finally(() => {
    // 같은 인스턴스인 경우만 null 처리 (새 세션이 이미 시작됐을 수 있음)
    if (liveOrchestrator === orch) liveOrchestrator = null;
  });

  return { ok: true };
});

// { ok: true } 반환 — renderer가 성공 여부를 알 수 있음
ipcMain.handle("discussion:interject", (_event, message: string) => {
  if (!liveOrchestrator) {
    console.log("[main] interject ignored — no active session");
    return { ok: false };
  }
  liveOrchestrator.interject(message);
  return { ok: true };
});

// Manual 모드: policy 기준 최고 점수 자동 채택
ipcMain.handle("discussion:accept", () => {
  if (!liveOrchestrator) return { ok: false };
  const accepted = liveOrchestrator.acceptConsensus();
  console.log("[main] acceptConsensus", accepted ? "ok" : "rejected");
  return { ok: accepted };
});

// Manual 모드: 사용자가 특정 proposal을 직접 채택
ipcMain.handle("discussion:select-proposal", (_event, revisionId: number) => {
  if (!liveOrchestrator) return { ok: false };
  const accepted = liveOrchestrator.selectProposal(revisionId);
  console.log("[main] selectProposal revisionId=", revisionId, accepted ? "ok" : "rejected");
  return { ok: accepted };
});
