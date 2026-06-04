import { RevisionStore } from "./RevisionStore.js";
import { MockGPTWorker, MockClaudeWorker, MockUserWorker, MOCK_CONFIGS } from "./orchestrator.js";
import { createMetrics, printMetrics, Metrics } from "./metrics.js";

// ─── Goal 목록 ────────────────────────────────────────────────────

export const GOAL_SETS: Record<string, string[]> = {
  normal:    ["데이터베이스 기술 스택 결정"],
  parsefail: ["데이터베이스 기술 스택 결정", "백엔드 프레임워크 선택"],
  apierror:  ["데이터베이스 기술 스택 결정", "사용자 인증 방식 결정"],
  delay:     ["데이터베이스 기술 스택 결정"],
  mixed:     ["데이터베이스 기술 스택 결정", "배포 환경 결정", "테스트 전략 수립"],
  stress:    Array.from({ length: 20 }, (_, i) => {
    const d = ["데이터베이스", "프레임워크", "인증", "배포", "상태관리", "테스트"];
    return `${d[i % d.length]} 스택 결정 #${i + 1}`;
  }),
};

// ─── 핵심 실행 함수 (CLI / 테스트 공용) ──────────────────────────

export interface RunResult {
  mode: string;
  metrics: Metrics;
  revisionCount: number;
}

export async function runMode(mode: string, silent = false): Promise<RunResult> {
  const config = MOCK_CONFIGS[mode];
  if (!config) throw new Error(`알 수 없는 모드: "${mode}"`);

  const goals   = GOAL_SETS[mode] ?? ["데이터베이스 기술 스택 결정"];
  const store   = new RevisionStore();
  const metrics = createMetrics();
  const gpt     = new MockGPTWorker(store, metrics, config);
  const claude  = new MockClaudeWorker(store, metrics, config);
  const user    = new MockUserWorker(store);

  let pending = 0;

  store.subscribe((rev) => {
    const h = store.getHistory();
    let capturedGoalRevId: number | null = null;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].patch.payload.type === "set_goal") { capturedGoalRevId = h[i].id; break; }
    }

    pending += 2;
    Promise.resolve(gpt.handle(rev, capturedGoalRevId)).finally(() => { pending--; });
    Promise.resolve(claude.handle(rev, capturedGoalRevId)).finally(() => { pending--; });
    user.handle(rev, capturedGoalRevId);
  });

  const timeoutMs = mode === "delay" ? 60000 : 30000;

  for (const goal of goals) {
    if (!silent) console.log(`▶ "${goal}"`);

    store.append("user", {
      type: "set_goal",
      payload: { type: "set_goal", goal },
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

  return { mode, metrics, revisionCount: store.getHistory().length };
}

// ─── CLI 직접 실행 ────────────────────────────────────────────────

const rawMode = (process.argv[2] ?? "").replace("mock:", "");
if (rawMode) {
  const config = MOCK_CONFIGS[rawMode];
  if (!config) {
    console.error(`사용 가능: ${Object.keys(MOCK_CONFIGS).map(k => `mock:${k}`).join("  ")}`);
    process.exit(1);
  }

  console.log(`\n모드: mock:${rawMode}`);
  console.log(`  latency=${config.latencyMs}ms  parseFail=${config.parseFailRate * 100}%  apiError=${config.apiErrorRate * 100}%\n`);

  runMode(rawMode).then(({ metrics, revisionCount }) => {
    console.log(`\n총 Revision: ${revisionCount}`);
    printMetrics(metrics);
  }).catch(console.error);
}
