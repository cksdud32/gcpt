// Windows 터미널 UTF-8 출력 설정 (한글 콘솔 깨짐 방지)
if (process.platform === "win32") {
  try { require("child_process").execSync("chcp 65001", { stdio: "ignore" }); } catch {}
}

import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { promises as fsp, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { WsLinkedContext } from "../../src/workspace-providers";
import { makeClaudeProvider, makeMockProvider } from "../../src/workspace-providers";
import { runMode, runCustomGoal } from "../../src/test-modes";
import type { DiscussionMode, DiscussionDepth, ConsensusMode, ProvidersConfig, InteractionStyle } from "../../src/types";
import { DEPTH_BUDGETS, DEFAULT_PROVIDER_MODELS } from "../../src/types";
import { MOCK_CONFIGS } from "../../src/orchestrator";
import { LiveOrchestrator } from "../../src/live-orchestrator";
import { ConversationOrchestrator } from "../../src/conversation-orchestrator";

// ─── Provider Settings ────────────────────────────────────────────

function getProviderSettingsPath(): string {
  return join(app.getPath("userData"), "provider-settings.json");
}

function isFirstRunCheck(): boolean {
  return !existsSync(getProviderSettingsPath());
}

function defaultProviders(): ProvidersConfig {
  return {
    gpt:    { enabled: !!process.env.OPENAI_API_KEY,    apiKey: process.env.OPENAI_API_KEY    ?? "", model: DEFAULT_PROVIDER_MODELS.gpt },
    claude: { enabled: !!process.env.ANTHROPIC_API_KEY, apiKey: process.env.ANTHROPIC_API_KEY ?? "", model: DEFAULT_PROVIDER_MODELS.claude },
    gemini: { enabled: !!process.env.GEMINI_API_KEY,    apiKey: process.env.GEMINI_API_KEY    ?? "", model: DEFAULT_PROVIDER_MODELS.gemini },
  };
}

function sanitizeSecretText(value: unknown): string {
  return String(value ?? "").replace(/sk-[A-Za-z0-9_-]+/g, "API_KEY");
}

function loadProviderSettings(): ProvidersConfig {
  try {
    const filePath = getProviderSettingsPath();
    if (!existsSync(filePath)) return defaultProviders();
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as ProvidersConfig;
    // 필드 유효성 검증 — 누락된 필드는 기본값으로 보완
    const defaults = defaultProviders();
    return {
      gpt:    { ...defaults.gpt,    ...parsed.gpt },
      claude: { ...defaults.claude, ...parsed.claude },
      gemini: { ...defaults.gemini, ...parsed.gemini },
    };
  } catch {
    return defaultProviders();
  }
}

function persistProviderSettings(settings: ProvidersConfig): void {
  try {
    writeFileSync(getProviderSettingsPath(), JSON.stringify(settings, null, 2), "utf-8");
  } catch (e) {
    console.error("[main] persistProviderSettings error:", e);
  }
}

// 런타임 상태 — 토론 시작 시 스냅샷으로 사용
let currentProviders: ProvidersConfig = defaultProviders();

let mainWindow: BrowserWindow | null = null;

type ProviderName = keyof ProvidersConfig;
const LIVE_PROVIDER_NAMES: ProviderName[] = ["gpt", "claude", "gemini"];
const LIVE_PROVIDER_LABELS: Record<ProviderName, string> = {
  gpt:    "GPT",
  claude: "Claude",
  gemini: "Gemini",
};

function getEnabledProvidersWithoutApiKey(settings: ProvidersConfig): ProviderName[] {
  return LIVE_PROVIDER_NAMES.filter(p => settings[p].enabled && !settings[p].apiKey.trim());
}

function getRunnableLiveProviders(settings: ProvidersConfig): ProviderName[] {
  return LIVE_PROVIDER_NAMES.filter(p => settings[p].enabled && !!settings[p].apiKey.trim());
}

function formatProviderList(providers: ProviderName[]): string {
  return providers.map(p => LIVE_PROVIDER_LABELS[p]).join(", ");
}

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

  // 최초 실행 시 renderer에 알려 API 설정 패널 자동 오픈
  mainWindow.webContents.once("did-finish-load", () => {
    if (isFirstRunCheck()) {
      mainWindow?.webContents.send("app:first-run");
    }
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(() => {
  currentProviders = loadProviderSettings();
  console.log("[main] loaded provider settings:", JSON.stringify({
    gpt:    { enabled: currentProviders.gpt.enabled,    hasApiKey: !!currentProviders.gpt.apiKey,    model: currentProviders.gpt.model },
    claude: { enabled: currentProviders.claude.enabled, hasApiKey: !!currentProviders.claude.apiKey, model: currentProviders.claude.model },
    gemini: { enabled: currentProviders.gemini.enabled, hasApiKey: !!currentProviders.gemini.apiKey, model: currentProviders.gemini.model },
  }));
  createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ─── Provider Settings IPC ────────────────────────────────────────

ipcMain.handle("provider:getSettings", () => currentProviders);

ipcMain.handle("provider:saveSettings", (_event, settings: ProvidersConfig) => {
  try {
    currentProviders = {
      gpt:    { enabled: !!settings.gpt?.enabled,    apiKey: settings.gpt?.apiKey    ?? "", model: settings.gpt?.model    || DEFAULT_PROVIDER_MODELS.gpt },
      claude: { enabled: !!settings.claude?.enabled, apiKey: settings.claude?.apiKey ?? "", model: settings.claude?.model || DEFAULT_PROVIDER_MODELS.claude },
      gemini: { enabled: !!settings.gemini?.enabled, apiKey: settings.gemini?.apiKey ?? "", model: settings.gemini?.model || DEFAULT_PROVIDER_MODELS.gemini },
    };
    persistProviderSettings(currentProviders);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: sanitizeSecretText(e instanceof Error ? e.message : String(e)) };
  }
});

ipcMain.handle("provider:testConnection", async (_event, provider: "gpt" | "claude" | "gemini") => {
  const cfg = currentProviders[provider];
  if (!cfg.apiKey) return { ok: false, error: "API key 없음" };

  const t0 = Date.now();
  try {
    if (provider === "gpt") {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const OpenAI = require("openai").default ?? require("openai");
      const client = new OpenAI({ apiKey: cfg.apiKey });
      await client.chat.completions.create({ model: cfg.model || "gpt-5-mini", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
    } else if (provider === "claude") {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Anthropic = require("@anthropic-ai/sdk").default ?? require("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: cfg.apiKey });
      await client.messages.create({ model: cfg.model || "claude-haiku-4-5-20251001", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
    } else {
      // Gemini: 간단한 fetch 테스트
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model || "gemini-2.5-flash"}:generateContent?key=${cfg.apiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 5 } }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, error: sanitizeSecretText(`HTTP ${res.status}: ${body.slice(0, 100)}`) };
      }
    }
    return { ok: true, latency: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: sanitizeSecretText(e instanceof Error ? e.message.slice(0, 120) : String(e)) };
  }
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

let liveOrchestrator:         LiveOrchestrator         | null = null;
let conversationOrchestrator: ConversationOrchestrator | null = null;

// 기본 safety timeout — budget.safetyTimeoutMs가 있으면 그 값을 사용
const DEFAULT_DISCUSSION_TIMEOUT_MS      = 10 * 60 * 1000;
const CONVERSATION_TIMEOUT_MS            =  5 * 60 * 1000;

// fire-and-forget: 즉시 { ok: true } 반환 후 background에서 토론 실행.
// 중간 업데이트는 discussion:update 로, 완료는 discussion:done 으로 push.
// invoke가 runGoals()를 await하면 모든 update가 invoke reply와 함께 한 번에
// 도착해서 React 배칭에 의해 중간 render가 모두 무시되는 문제를 방지.
ipcMain.handle("start-live-discussion", (_event, payload: {
  goals: string[];
  mode?: DiscussionMode;
  depth?: DiscussionDepth;
  consensusMode?: ConsensusMode;
  safetyLimitEnabled?: boolean;
  interactionStyle?: InteractionStyle;
}) => {
  const { goals, mode: discussionMode = "general", depth = "structural_convergence", consensusMode = "auto", safetyLimitEnabled, interactionStyle = "debate" } = payload;

  const enabledWithoutKey = getEnabledProvidersWithoutApiKey(currentProviders);
  if (enabledWithoutKey.length > 0) {
    console.warn("[main] discussion blocked — enabled providers missing API keys:", enabledWithoutKey);
    return { ok: false, error: `API 키가 없는 provider가 활성화되어 있습니다: ${formatProviderList(enabledWithoutKey)}` };
  }

  // 활성화 + API 키 보유 provider가 2개 미만이면 실행 차단
  const runnableProviders = getRunnableLiveProviders(currentProviders);
  if (runnableProviders.length < 2) {
    console.warn("[main] discussion blocked — not enough runnable providers:", runnableProviders);
    return { ok: false, error: "실시간 토론에는 API 키가 설정된 AI provider가 최소 2개 필요합니다" };
  }

  // 기존 세션 종료
  liveOrchestrator?.terminate();
  conversationOrchestrator?.terminate();
  liveOrchestrator         = null;
  conversationOrchestrator = null;

  // 시작 시점의 provider 설정 스냅샷
  const snapshotProviders = {
    gpt:    { ...currentProviders.gpt },
    claude: { ...currentProviders.claude },
    gemini: { ...currentProviders.gemini },
  };
  console.log("[main] START LIVE DISCUSSION  goals=", goals, "style=", interactionStyle, "mode=", discussionMode);

  // ── Conversation Mode ────────────────────────────────────────────
  console.log("[ipc] interactionStyle =", interactionStyle);
  if (interactionStyle === "conversation") {
    console.log("[ipc] selected orchestrator = ConversationOrchestrator");
    const convOrch = new ConversationOrchestrator(
      (history, topics) => safeSend("discussion:update", { history, topics }),
      (msg) => safeSend("discussion:status", msg),
    );
    conversationOrchestrator = convOrch;

    const timeoutId = setTimeout(() => {
      if (conversationOrchestrator === convOrch) {
        console.warn("[main] conversation hard timeout — forcing terminate");
        convOrch.hardTerminate();
        conversationOrchestrator = null;
      }
    }, CONVERSATION_TIMEOUT_MS);

    const goal = goals[0] ?? "";
    convOrch.runConversation(goal, snapshotProviders, undefined, (snapshot) => {
      console.log("[main] conversation done  revisionCount=", snapshot.revisionCount);
      safeSend("discussion:done", snapshot);
    })
    .catch(err => {
      console.error("[main] conversation error:", sanitizeSecretText(err instanceof Error ? err.message : String(err)));
      safeSend("discussion:done", null);
    })
    .finally(() => {
      clearTimeout(timeoutId);
      if (conversationOrchestrator === convOrch) conversationOrchestrator = null;
    });

    return { ok: true };
  }

  // ── Debate Mode (LiveOrchestrator) ───────────────────────────────
  console.log("[ipc] selected orchestrator = LiveOrchestrator");
  const budget = { ...DEPTH_BUDGETS[depth] ?? DEPTH_BUDGETS.structural_convergence };
  if (safetyLimitEnabled !== undefined) budget.safetyLimitEnabled = safetyLimitEnabled;
  console.log("[main] fresh live budget", { depth, safetyLimitEnabled: budget.safetyLimitEnabled });
  const timeoutMs = budget.safetyTimeoutMs ?? DEFAULT_DISCUSSION_TIMEOUT_MS;

  const orch = new LiveOrchestrator(
    (history, topics) => safeSend("discussion:update", { history, topics }),
    (msg) => safeSend("discussion:status", msg),
  );
  liveOrchestrator = orch;

  const timeoutId = setTimeout(() => {
    if (liveOrchestrator === orch) {
      console.warn("[main] hard emergency timeout — forcing terminate");
      orch.hardTerminate();
      liveOrchestrator = null;
    }
  }, timeoutMs);

  orch.runGoals(goals, discussionMode, budget, (snapshot) => {
    console.log("[main] discussion:done revisionCount=", snapshot.revisionCount);
    safeSend("discussion:done", snapshot);
  }, consensusMode, snapshotProviders)
  .catch(err => {
    console.error("[main] discussion error:", sanitizeSecretText(err instanceof Error ? err.message : String(err)));
    safeSend("discussion:done", null);
  })
  .finally(() => {
    // hard timeout 타이머 정리 — liveOrchestrator는 null로 만들지 않음.
    // 토론이 종료된 후에도 추가 의견(user_interjection)으로 새 segment를 시작할 수 있어야 함.
    // 새 start-live-discussion 수신 시 위쪽 liveOrchestrator?.terminate() + null 할당이 처리함.
    clearTimeout(timeoutId);
  });

  return { ok: true };
});

// { ok: true } 반환 — renderer가 성공 여부를 알 수 있음
ipcMain.handle("discussion:interject", (_event, payload: string | { message: string; safetyLimitEnabled?: boolean }) => {
  const message = typeof payload === "string" ? payload : payload.message;
  const safetyLimitEnabled = typeof payload === "string" ? undefined : payload.safetyLimitEnabled;
  const hasOrch = !!liveOrchestrator;
  console.log("[main] interject received", {
    hasOrchestrator: hasOrch,
    message: message.slice(0, 40),
    safetyLimitEnabled,
  });
  if (!liveOrchestrator) {
    console.log("[main] interject ignored — no orchestrator (new discussion not started yet)");
    return { ok: false };
  }
  // isStopped 여부와 무관하게 interject 호출 — LiveOrchestrator 내부에서 new segment로 재개
  liveOrchestrator.interject(message, { safetyLimitEnabled });
  return { ok: true };
});

// 토론/대화 중지
ipcMain.handle("discussion:stop", () => {
  if (conversationOrchestrator) {
    console.log("[main] stopConversation requested");
    conversationOrchestrator.stopDiscussion();
    return { ok: true };
  }
  if (!liveOrchestrator) {
    console.log("[main] stop ignored — no active session");
    return { ok: false };
  }
  console.log("[main] stopDiscussion requested");
  liveOrchestrator.stopDiscussion();
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

// ─── Workspace AI Chat ────────────────────────────────────────────

ipcMain.handle("workspace:chat", async (_event, payload: {
  messages:     { role: "user" | "assistant"; content: string }[];
  linkedTopic?: WsLinkedContext;
}) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const mock   = makeMockProvider();

  // No API key → immediate mock
  if (!apiKey) {
    const content = await mock.send(payload.messages, payload.linkedTopic);
    return { ok: true, content, provider: mock.name, fallbackReason: "missing_api_key" } as const;
  }

  // Try Claude, fallback to mock on any error
  const claude = makeClaudeProvider(apiKey);
  try {
    const content = await claude.send(payload.messages, payload.linkedTopic);
    return { ok: true, content, provider: claude.name } as const;
  } catch (err) {
    console.warn("[workspace:chat] Claude failed, falling back to mock:", sanitizeSecretText(err instanceof Error ? err.message : String(err)));
    try {
      const content = await mock.send(payload.messages, payload.linkedTopic);
      return { ok: true, content, provider: mock.name, fallbackReason: "provider_error" } as const;
    } catch (mockErr) {
      const msg = sanitizeSecretText(mockErr instanceof Error ? mockErr.message : String(mockErr));
      return { ok: false, error: msg } as const;
    }
  }
});

// ─── Workspace Implementation Plan ───────────────────────────────

ipcMain.handle("workspace:generate-plan", async (_event, payload: {
  linkedTopic?: WsLinkedContext;
}) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const mock   = makeMockProvider();

  if (!apiKey) {
    const plan = await mock.generatePlan(payload.linkedTopic);
    return { ok: true, plan, provider: mock.name, fallbackReason: "missing_api_key" } as const;
  }

  const claude = makeClaudeProvider(apiKey);
  try {
    const plan = await claude.generatePlan(payload.linkedTopic);
    return { ok: true, plan, provider: claude.name } as const;
  } catch (err) {
    console.warn("[workspace:generate-plan] Claude failed, falling back to mock:", sanitizeSecretText(err instanceof Error ? err.message : String(err)));
    const plan = await mock.generatePlan(payload.linkedTopic);
    return { ok: true, plan, provider: mock.name, fallbackReason: "provider_error" } as const;
  }
});
