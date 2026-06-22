/**
 * Worker 공통 — Segment-aware context 빌더
 *
 * buildContext가 전체 proposal이 아닌 현재 세그먼트 proposal만 포함하도록,
 * getMyPriorProposals도 세그먼트 범위로 제한한다.
 *
 * Memory는 이전 세그먼트 요약을 prefix로 붙이되,
 * score 계산에는 포함하지 않는다.
 */

import type { RevisionStore } from "../RevisionStore.js";

/**
 * 현재 세그먼트 시작 revId 탐색.
 * `set_goal` 이후 가장 최근의 `user_interjection` revId를 반환.
 * 없으면 `capturedGoalRevId`를 반환.
 */
export function findCurrentSegmentStartRevId(
  store:              RevisionStore,
  capturedGoalRevId:  number,
): number {
  const history = store.getHistory();
  const goalIdx = history.findIndex(r => r.id === capturedGoalRevId);
  if (goalIdx === -1) return capturedGoalRevId;

  let lastInterjectionId: number | undefined;
  for (let i = goalIdx; i < history.length; i++) {
    if (history[i].patch.payload.type === "user_interjection") {
      lastInterjectionId = history[i].id;
    }
  }
  return lastInterjectionId ?? capturedGoalRevId;
}

/**
 * 현재 세그먼트 proposal만 포함한 context 문자열.
 * memoryPrefix가 있으면 이전 토론 요약을 상단에 추가.
 */
export function buildSegmentContext(
  store:              RevisionStore,
  capturedGoalRevId:  number,
  segmentStartRevId:  number,
  memoryPrefix?:      string,
): string {
  const history = store.getHistory();
  const segIdx  = history.findIndex(r => r.id === segmentStartRevId);
  const startIdx = segIdx >= 0 ? segIdx : history.findIndex(r => r.id === capturedGoalRevId);

  const segRevs = (startIdx >= 0 ? history.slice(startIdx) : [])
    .filter(r =>
      r.patch.payload.type === "propose_decision" ||
      r.patch.payload.type === "propose_alternative",
    );

  const ctxStr = segRevs.map(r => {
    const p = r.patch.payload as { value: string; reason: string };
    return `- [${r.author}] ${p.value}: ${p.reason}`;
  }).join("\n");

  if (memoryPrefix && memoryPrefix.trim()) {
    return (
      `[이전 토론 기억 — 참고만, 점수 영향 없음]\n${memoryPrefix}\n\n` +
      `[현재 세그먼트 논의]\n${ctxStr || "(첫 발언 대기)"}`
    );
  }
  return ctxStr;
}

/**
 * 현재 세그먼트 안에서 특정 author의 이전 발언만 반환.
 */
export function getSegmentPriorProposals(
  store:             RevisionStore,
  author:            string,
  capturedGoalRevId: number,
  segmentStartRevId: number,
): Array<{ value: string; reason: string }> {
  const history = store.getHistory();
  const segIdx  = history.findIndex(r => r.id === segmentStartRevId);
  const startIdx = segIdx >= 0 ? segIdx : history.findIndex(r => r.id === capturedGoalRevId);

  return (startIdx >= 0 ? history.slice(startIdx) : [])
    .filter(r =>
      r.author === author &&
      (r.patch.payload.type === "propose_decision" ||
       r.patch.payload.type === "propose_alternative"),
    )
    .map(r => ({
      value:  (r.patch.payload as { value: string }).value,
      reason: (r.patch.payload as { value: string; reason: string }).reason,
    }));
}
