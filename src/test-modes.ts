import { RevisionStore } from "./RevisionStore.js";
import { MockGPTWorker, MockClaudeWorker, MockUserWorker, MOCK_CONFIGS, MockConfig } from "./orchestrator.js";
import { RealGeminiWorker } from "./workers/gemini.js";
import { createMetrics, printMetrics, Metrics } from "./metrics.js";
import type { Topic, Revision, DiscussionMode } from "./types.js";

// ─── Goal 목록 ────────────────────────────────────────────────────

export const GOAL_SETS: Record<string, string[]> = {
  normal:    ["데이터베이스 기술 스택 결정"],
  parsefail: ["데이터베이스 기술 스택 결정", "백엔드 프레임워크 선택"],
  apierror:  ["데이터베이스 기술 스택 결정", "사용자 인증 방식 결정"],
  delay:     ["데이터베이스 기술 스택 결정"],
  mixed:     ["데이터베이스 기술 스택 결정", "프레임워크 선택", "인증 방식 결정",
              "배포 환경 결정", "상태관리 선택", "테스트 전략 수립",
              "CI/CD 파이프라인 결정", "모니터링 도구 선택"],
  stress:    Array.from({ length: 20 }, (_, i) => {
    const d = ["데이터베이스", "프레임워크", "인증", "배포", "상태관리", "테스트"];
    return `${d[i % d.length]} 스택 결정 #${i + 1}`;
  }),
};

// ─── RunResult ────────────────────────────────────────────────────

export interface RunResult {
  mode: string;
  metrics: Metrics;
  revisionCount: number;
  topics: Topic[];
  history: Revision[];
}

// ─── 핵심 실행 함수 (공용) ────────────────────────────────────────

async function runWithGoals(
  config: MockConfig,
  goals: string[],
  mode: string,
  silent: boolean,
  discussionMode: DiscussionMode = "general"
): Promise<RunResult> {
  const store   = new RevisionStore();
  const metrics = createMetrics();
  const gpt     = new MockGPTWorker(store, metrics, config);
  const user    = new MockUserWorker(store);

  // GEMINI_API_KEY가 있으면 RealGeminiWorker, 없으면 MockClaudeWorker
  const geminiKey = process.env.GEMINI_API_KEY;
  const claudeWorker = geminiKey
    ? (() => {
        if (!silent) console.log("[Worker] Gemini API 키 감지 → RealGeminiWorker 사용");
        return new RealGeminiWorker(geminiKey, store, metrics);
      })()
    : new MockClaudeWorker(store, metrics, config);

  let pending = 0;

  store.subscribe((rev) => {
    const h = store.getHistory();
    let capturedGoalRevId: number | null = null;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].patch.payload.type === "set_goal") { capturedGoalRevId = h[i].id; break; }
    }

    pending += 2;
    Promise.resolve(gpt.handle(rev, capturedGoalRevId)).finally(() => { pending--; });
    Promise.resolve(claudeWorker.handle(rev, capturedGoalRevId)).finally(() => { pending--; });
    user.handle(rev, capturedGoalRevId);
  });

  const isRealApi  = !!process.env.GEMINI_API_KEY;
  const timeoutMs  = mode === "delay" ? 60000 : isRealApi ? 60000 : 30000;

  for (const goal of goals) {
    if (!silent) console.log(`▶ "${goal}"`);

    store.append("user", {
      type: "set_goal",
      payload: { type: "set_goal", goal, mode: discussionMode },
    });

    const deadline = Date.now() + timeoutMs;
    while (pending > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (pending > 0 && !silent) console.warn(`[타임아웃] ${pending}개 응답 미완료`);

    const topics = store.rebuildState().topics;
    const last   = topics[topics.length - 1];
    if (last?.selectedOption === null) {
      if (!silent) console.warn(`  [미결정] proposals=${last.proposals.length}`);
      metrics.topics.undecided++;
    } else {
      if (!silent) {
        const val = (last?.selectedOption?.content as { value: string })?.value ?? "?";
        console.log(`  → ${val} (decided)`);
      }
      metrics.topics.decided++;
    }
  }

  return {
    mode,
    metrics,
    revisionCount: store.getHistory().length,
    topics: store.rebuildState().topics,
    history: store.getHistory(),
  };
}

// ─── Mock 모드 실행 ───────────────────────────────────────────────

export async function runMode(mode: string, silent = false, discussionMode: DiscussionMode = "general"): Promise<RunResult> {
  const config = MOCK_CONFIGS[mode];
  if (!config) throw new Error(`알 수 없는 모드: "${mode}"`);
  const goals = GOAL_SETS[mode] ?? ["데이터베이스 기술 스택 결정"];
  return runWithGoals(config, goals, mode, silent, discussionMode);
}

// ─── 사용자 커스텀 Goal 실행 ──────────────────────────────────────

export async function runCustomGoal(goalText: string, silent = false, discussionMode: DiscussionMode = "general"): Promise<RunResult> {
  const goals = goalText
    .split(/\n+/)
    .map(g => g.trim())
    .filter(g => g.length > 0);

  if (goals.length === 0) throw new Error("Goal이 비어있습니다");

  return runWithGoals(MOCK_CONFIGS.normal, goals, "custom", silent, discussionMode);
}

// ─── CLI 직접 실행 ────────────────────────────────────────────────

const rawMode = (process.argv[2] ?? "").replace("mock:", "");
if (MOCK_CONFIGS[rawMode]) {
  const config = MOCK_CONFIGS[rawMode];
  console.log(`\n모드: mock:${rawMode}`);
  console.log(`  latency=${config.latencyMs}ms  parseFail=${config.parseFailRate * 100}%  apiError=${config.apiErrorRate * 100}%\n`);

  runMode(rawMode).then(({ metrics, revisionCount }) => {
    console.log(`\n총 Revision: ${revisionCount}`);
    printMetrics(metrics);
  }).catch(console.error);
}
