import { RevisionStore } from "./RevisionStore.js";
import { MockGPTWorker, MockClaudeWorker, MockUserWorker } from "./orchestrator.js";
import { RealGPTWorker } from "./workers/gpt.js";
import { RealClaudeWorker } from "./workers/claude.js";
import { createMetrics, printMetrics } from "./metrics.js";
import * as fs from "fs";

const metrics = createMetrics();

// ─── API 키 확인 (없으면 Mock으로 대체) ──────────────────────────

const OPENAI_KEY    = process.env.OPENAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

console.log(`GPT    모드: ${OPENAI_KEY    ? "실제 API (gpt-4o-mini)"              : "Mock"}`);
console.log(`Claude 모드: ${ANTHROPIC_KEY ? "실제 API (claude-haiku-4-5-20251001)" : "Mock"}`);

// ─── 현재 goalRevId 캡처 유틸 ─────────────────────────────────────

function getCurrentGoalRevId(store: RevisionStore): number | null {
  const h = store.getHistory();
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i].patch.payload.type === "set_goal") return h[i].id;
  }
  return null;
}

// ─── 비용 안전장치 ────────────────────────────────────────────────
// topic당 최대 2회 × goal 수 = 실제 상한
// 예: goal 1개 → Claude 최대 2회

const MAX_CLAUDE_CALLS = Number(process.env.MAX_CLAUDE_CALLS ?? 10);
let claudeCallCount = 0;
console.log(`Claude 호출 상한: ${MAX_CLAUDE_CALLS}회`);

// ─── 세팅 ─────────────────────────────────────────────────────────

const store  = new RevisionStore();
const gpt    = OPENAI_KEY    ? new RealGPTWorker(OPENAI_KEY, store, metrics)       : new MockGPTWorker(store);
const claude = ANTHROPIC_KEY ? new RealClaudeWorker(ANTHROPIC_KEY, store, metrics) : new MockClaudeWorker(store);
const user   = new MockUserWorker(store);

let pending = 0;

store.subscribe((rev) => {
  const capturedGoalRevId = getCurrentGoalRevId(store);

  pending += 2;
  Promise.resolve(gpt.handle(rev, capturedGoalRevId)).finally(() => { pending--; });

  // Claude 호출 상한 체크
  if (claudeCallCount >= MAX_CLAUDE_CALLS) {
    console.warn(`[안전장치] Claude 호출 상한(${MAX_CLAUDE_CALLS}) 도달 — 이번 호출 스킵`);
    pending--;
  } else {
    claudeCallCount++;
    Promise.resolve(claude.handle(rev, capturedGoalRevId)).finally(() => { pending--; });
  }

  user.handle(rev, capturedGoalRevId);
});

// ─── 시나리오 ─────────────────────────────────────────────────────
// Goal은 1개부터 시작. 검증 후 늘릴 것.

const goals = [
  "데이터베이스 기술 스택 결정",
  // "백엔드 프레임워크 선택",   ← 검증 후 주석 해제
  // "사용자 인증 방식 결정",    ← 검증 후 주석 해제
];

async function waitPending(timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pending > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (pending > 0) console.warn(`[타임아웃] ${pending}개 응답 미완료`);
}

async function main() {
  for (const goal of goals) {
    console.log(`\n▶ Goal: "${goal}"`);

    store.append("user", {
      type: "set_goal",
      payload: { type: "set_goal", goal },
      rationale: "사용자가 다음 결정 주제를 시작함",
    });

    // 각 topic 사이에 API 응답 완료를 기다림
    await waitPending();

    // 미결정 감지 (재시도 없이 로그만)
    const topics = store.rebuildState().topics;
    const lastTopic = topics[topics.length - 1];
    if (lastTopic?.selectedOption === null) {
      console.warn(`[미결정] "${goal}" — proposals: ${lastTopic.proposals.length}개. run-revisions.json 확인 필요.`);
      metrics.topics.undecided++;
    } else {
      metrics.topics.decided++;
    }

    console.log(`  → 완료`);
  }

  // ─── 결과 출력 ───────────────────────────────────────────────────

  const state = store.rebuildState();
  fs.writeFileSync("run-revisions.json", store.toJSON(), "utf-8");

  console.log("\n\n══════════ 최종 결과 ══════════\n");
  for (const topic of state.topics) {
    const sel = topic.selectedOption
      ? `${(topic.selectedOption.content as { value: string }).value} (선택자: ${topic.selectedOption.selectedBy})`
      : "미결정";
    console.log(`[${topic.status}] ${topic.goal}`);
    console.log(`  결정: ${sel}`);

    if (topic.proposals.length > 0) {
      console.log(`  제안 목록:`);
      for (const p of topic.proposals) {
        const content = p.content as { value: string; reason: string };
        console.log(`    - [${p.author}] ${content.value}: ${content.reason}`);
        if (p.rationale) console.log(`      → ${p.rationale}`);
      }
    }
    console.log();
  }

  console.log(`run-revisions.json 저장 완료 (${store.getHistory().length}개 Revision)`);

  printMetrics(metrics);
}

main().catch(console.error);
