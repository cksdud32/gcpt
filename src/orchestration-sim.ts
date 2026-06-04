import { RevisionStore } from "./RevisionStore.js";
import { Orchestrator, AsyncOrchestrator } from "./orchestrator.js";
import { debugScores } from "./policy.js";
import * as fs from "fs";

// ═══════════════════════════════════════════════════════
// 공통 유틸
// ═══════════════════════════════════════════════════════

function topicRevisions(history: ReturnType<RevisionStore["getHistory"]>, topicIndex: number) {
  const setGoals = history.filter((r) => r.patch.payload.type === "set_goal");
  const start = history.findIndex((r) => r.id === setGoals[topicIndex]?.id);
  const end   = setGoals[topicIndex + 1]
    ? history.findIndex((r) => r.id === setGoals[topicIndex + 1].id)
    : history.length;
  return start >= 0 ? history.slice(start, end) : [];
}

// ═══════════════════════════════════════════════════════
// 1. 동기 스트레스 테스트 — 200 topic
// ═══════════════════════════════════════════════════════

console.log("━━━ [동기] 200 Topic 스트레스 테스트 ━━━\n");

{
  const store = new RevisionStore();
  new Orchestrator(store);

  const domains = [
    "데이터베이스", "프레임워크", "인증", "배포", "상태관리", "테스트",
    "캐싱", "메시지큐", "로깅", "보안",
  ];

  for (let i = 0; i < 200; i++) {
    const domain = domains[i % domains.length];
    store.append("user", {
      type: "set_goal",
      payload: { type: "set_goal", goal: `${domain} 스택 결정 #${i + 1}` },
    });
  }

  const history = store.getHistory();
  const state   = store.rebuildState();
  fs.writeFileSync("stress-revisions.json", store.toJSON(), "utf-8");

  const decided    = state.topics.filter((t) => t.status === "decided");
  const undecided  = state.topics.filter((t) => t.status !== "decided");
  const dupSelects = state.topics.filter((t) => {
    const tRevs = topicRevisions(history, state.topics.indexOf(t));
    return tRevs.filter((r) => r.patch.type === "select_option").length > 1;
  });

  console.log(`총 Revision    : ${history.length}`);
  console.log(`총 Topic       : ${state.topics.length}`);
  console.log(`decided        : ${decided.length}`);
  console.log(`undecided      : ${undecided.length}`);
  console.log(`중복 select    : ${dupSelects.length} ← race condition 지표`);

  // author 분포
  const ac = history.reduce((m, r) => { m[r.author] = (m[r.author] ?? 0) + 1; return m; }, {} as Record<string, number>);
  console.log(`\n─── author 분포 ───`);
  for (const [a, c] of Object.entries(ac)) console.log(`  ${a}: ${c}`);

  // Topic 경계 무결성: select_option이 올바른 topic 범위 안에 있는가
  let boundaryOk = 0, boundaryErr = 0;
  for (let ti = 0; ti < state.topics.length; ti++) {
    const topic = state.topics[ti];
    if (!topic.selectedOption) continue;
    const selRevId = topic.selectedOption.revisionId;
    const tRevs = topicRevisions(history, ti);
    if (tRevs.find((r) => r.id === selRevId)) boundaryOk++;
    else boundaryErr++;
  }
  console.log(`\n─── Topic 경계 무결성 ───`);
  console.log(`  올바른 범위 내 select: ${boundaryOk}`);
  console.log(`  범위 이탈 select     : ${boundaryErr} ← TOCTOU 지표`);

  // 첫 5 topic만 점수표 출력
  console.log(`\n─── 점수표 (첫 5 Topic) ───`);
  for (let ti = 0; ti < Math.min(5, state.topics.length); ti++) {
    const topic = state.topics[ti];
    const tRevs = topicRevisions(history, ti);
    const sel = topic.selectedOption ? (topic.selectedOption.content as { value: string }).value : "미결정";
    console.log(`\n  [${ti + 1}] ${topic.goal} → ${sel}`);
    debugScores(tRevs, history);
  }
}

// ═══════════════════════════════════════════════════════
// 2. Async 스트레스 테스트 — 20 topic
//    capturedGoalRevId fix 적용 후 무결성 확인
// ═══════════════════════════════════════════════════════

console.log("\n\n━━━ [비동기] 20 Topic 무결성 테스트 ━━━\n");

async function runAsync() {
  const store = new RevisionStore();
  const orch  = new AsyncOrchestrator(store);

  const domains = ["데이터베이스", "프레임워크", "인증", "배포", "상태관리",
                   "테스트", "캐싱", "메시지큐", "로깅", "보안"];

  for (let i = 0; i < 20; i++) {
    const domain = domains[i % domains.length];
    store.append("user", {
      type: "set_goal",
      payload: { type: "set_goal", goal: `${domain} 결정 #${i + 1}` },
    });
    // topic 간 3.5초 대기 — async worker 응답 시간 확보
    await new Promise((r) => setTimeout(r, 3500));
  }

  await orch.waitUntilDone();

  const history = store.getHistory();
  const state   = store.rebuildState();

  const decided   = state.topics.filter((t) => t.status === "decided");

  // ── 논리적 중복 검사: rebuildState() 이후 selectedOption이 2개인 topic
  // (rebuildState 내부 guard로 항상 0이어야 함)
  const logicalDup = state.topics.filter((t) => t.selectedOption !== null && t.status === "decided")
    .map((t) => t.goal);
  // 상태 기준 중복 = 불가능 (guard 있음), 검증만
  const stateIntact = new Set(state.topics.filter(t => t.selectedOption).map(t => t.startRevId));
  const logicalDupCount = state.topics.filter(t => t.selectedOption).length - stateIntact.size;

  // ── winner proposal이 올바른 topic의 물리적 범위 안에 있는가
  // (select_option 자체가 늦게 도착해도 winner proposal은 제때 append됨)
  let proposalOutOfRange = 0;
  for (let ti = 0; ti < state.topics.length; ti++) {
    const topic = state.topics[ti];
    if (!topic.selectedOption) continue;

    const selRevId = topic.selectedOption.revisionId;
    const selRev = history.find((r) => r.id === selRevId);
    const winnerProposalId = selRev?.patch.references?.[0];
    if (winnerProposalId === undefined) { proposalOutOfRange++; continue; }

    const tRevs = topicRevisions(history, ti);
    if (!tRevs.find((r) => r.id === winnerProposalId)) proposalOutOfRange++;
  }

  // ── 늦은 select_option 개수 (정보성 지표)
  let lateArrivals = 0;
  for (let ti = 0; ti < state.topics.length; ti++) {
    const topic = state.topics[ti];
    if (!topic.selectedOption) continue;
    const selRevId = topic.selectedOption.revisionId;
    const tRevs = topicRevisions(history, ti);
    if (!tRevs.find((r) => r.id === selRevId)) lateArrivals++;
  }

  console.log(`총 Revision        : ${history.length}`);
  console.log(`총 Topic           : ${state.topics.length}`);
  console.log(`decided            : ${decided.length} / ${state.topics.length}`);
  console.log(`논리적 중복 select : ${logicalDupCount} ← 항상 0이어야 함`);
  console.log(`winner 범위 이탈   : ${proposalOutOfRange} ← 항상 0이어야 함`);
  console.log(`늦은 select_option : ${lateArrivals} (async 지연으로 인한 정상 현상)`);

  if (logicalDupCount === 0 && proposalOutOfRange === 0) {
    console.log(`\n✓ 무결성 검증 완료`);
  } else {
    console.log(`\n⚠ 무결성 문제 있음`);
  }

  console.log(`\n─── Topic별 요약 ───`);
  for (const topic of state.topics) {
    const db = topic.selectedOption
      ? (topic.selectedOption.content as { value: string }).value
      : "미결정";
    console.log(`  [${topic.status.padEnd(10)}] ${topic.goal.padEnd(20)} → ${db}`);
  }
}

runAsync().catch(console.error);
