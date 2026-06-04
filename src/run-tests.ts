import { runMode } from "./test-modes.js";
import { Metrics } from "./metrics.js";

// ─── 판정 조건 정의 ───────────────────────────────────────────────

type Check = (m: Metrics) => string | null; // null = pass, string = fail reason

const CHECKS: Record<string, Check[]> = {
  normal: [
    (m) => m.topics.decided === 1     ? null : `decided=${m.topics.decided} (expected 1)`,
    (m) => m.topics.undecided === 0   ? null : `undecided=${m.topics.undecided} (expected 0)`,
    (m) => m.calls.gpt.parseOk >= 1   ? null : `GPT parseOk=${m.calls.gpt.parseOk} (expected >=1)`,
    (m) => m.calls.claude.parseOk >= 1? null : `Claude parseOk=${m.calls.claude.parseOk} (expected >=1)`,
  ],
  parsefail: [
    (m) => (m.calls.gpt.parseFail + m.calls.claude.parseFail) > 0
      ? null
      : `parseFail=0 (expected >0)`,
    (m) => m.topics.undecided > 0
      ? null
      : `undecided=${m.topics.undecided} (expected >0)`,
  ],
  apierror: [
    // apiError 발생 여부만 확인 (undecided는 보장 불가 — topic 결정 후 에러 발생 가능)
    (m) => (m.calls.gpt.apiError + m.calls.claude.apiError) > 0
      ? null
      : `apiErr=0 (expected >0)`,
  ],
  delay: [
    (m) => m.topics.decided === 1     ? null : `decided=${m.topics.decided} (expected 1)`,
    (m) => m.topics.undecided === 0   ? null : `undecided=${m.topics.undecided} (expected 0)`,
    (m) => m.latencyMs.length > 0     ? null : `latency samples=0 (expected >0)`,
    (m) => (m.latencyMs[0] ?? 0) >= 500
      ? null
      : `latency=${m.latencyMs[0]}ms (expected >=500)`,
  ],
  mixed: [
    (m) => m.topics.decided > 0       ? null : `decided=0 (expected >0)`,
    (m) => m.topics.undecided > 0     ? null : `undecided=0 (expected >0)`,
    (m) => m.latencyMs.length > 0     ? null : `latency samples=0 (expected >0)`,
  ],
  stress: [
    (m) => m.topics.decided === 20    ? null : `decided=${m.topics.decided} (expected 20)`,
    (m) => m.topics.undecided === 0   ? null : `undecided=${m.topics.undecided} (expected 0)`,
    (m) => m.calls.gpt.total >= 40    ? null : `GPT calls=${m.calls.gpt.total} (expected >=40)`,
    (m) => m.calls.claude.total >= 40 ? null : `Claude calls=${m.calls.claude.total} (expected >=40)`,
  ],
};

// ─── 판정 실행 ────────────────────────────────────────────────────

async function runTests() {
  const modes = Object.keys(CHECKS);
  const results: { mode: string; passed: boolean; failures: string[] }[] = [];

  console.log("Mock 테스트 실행 중...\n");

  for (const mode of modes) {
    const { metrics } = await runMode(mode, true /* silent */);
    const checks   = CHECKS[mode];
    const failures = checks.map((c) => c(metrics)).filter((r): r is string => r !== null);

    results.push({ mode, passed: failures.length === 0, failures });
  }

  // ─── 결과 출력 ────────────────────────────────────────────────

  console.log("─".repeat(50));
  let allPassed = true;

  for (const { mode, passed, failures } of results) {
    if (passed) {
      console.log(`[PASS] mock:${mode}`);
    } else {
      allPassed = false;
      for (const f of failures) {
        console.log(`[FAIL] mock:${mode}  ${f}`);
      }
    }
  }

  console.log("─".repeat(50));
  console.log(allPassed ? "\n모든 테스트 통과" : "\n실패한 테스트 있음");

  process.exit(allPassed ? 0 : 1);
}

runTests().catch(console.error);
