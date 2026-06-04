import { Revision } from "./types.js";

// ─── 점수 계산 ────────────────────────────────────────────────────
//
// 설계 원칙:
//   - "먼저 제안했다"는 이유만으로 이겨선 안 됨 (initial 보너스 제거)
//   - 상대방이 내 제안을 언급할수록 실질적 영향력이 높음
//   - 토론이 깊어질수록(reference depth) 더 정제된 제안으로 간주
//   - Claude가 먼저 반론하고 GPT가 수용 → Claude 제안이 이겨야 함

interface ScoredProposal {
  revision: Revision;
  score: number;
  reasons: string[];
}

export function selectByPolicy(
  topicRevisions: Revision[],
  _allRevisions: Revision[]
): Revision | null {
  const proposals = topicRevisions.filter(
    (r) =>
      r.patch.payload.type === "propose_decision" ||
      r.patch.payload.type === "propose_alternative"
  );

  if (proposals.length === 0) return null;

  const scored = proposals.map((p) => scoreProposal(p, topicRevisions));
  scored.sort((a, b) => b.score - a.score);

  return scored[0].revision;
}

function scoreProposal(rev: Revision, topicRevs: Revision[]): ScoredProposal {
  const reasons: string[] = [];
  let score = 0;

  // 1. 상대방이 내 제안을 인용 → 가장 강한 신호 (+5)
  //    "내 주장을 상대가 언급했다" = 실질적 영향력
  const opponentRefs = topicRevs.filter(
    (r) => r.patch.references?.includes(rev.id) && r.author !== rev.author
  );
  if (opponentRefs.length > 0) {
    score += opponentRefs.length * 5;
    reasons.push(`opponent-cited×${opponentRefs.length}(+${opponentRefs.length * 5})`);
  }

  // 2. 같은 편이 인용 → 낮은 가중치 (+1)
  const sameRefs = topicRevs.filter(
    (r) => r.patch.references?.includes(rev.id) && r.author === rev.author
  );
  if (sameRefs.length > 0) {
    score += sameRefs.length;
    reasons.push(`self-cited×${sameRefs.length}(+${sameRefs.length})`);
  }

  // 3. propose_alternative가 propose_decision보다 토론 참여도가 높음
  // (depth 기반 점수 제거: GPT가 항상 나중에 발언하면서 구조적으로 유리해지는 편향 발생)
  //    (반론을 제기했다는 것 자체가 더 적극적 기여)
  if (rev.patch.payload.type === "propose_alternative") {
    score += 1;
    reasons.push("counter(+1)");
  }

  return { revision: rev, score, reasons };
}

export function debugScores(topicRevisions: Revision[], _allRevisions: Revision[]): void {
  const proposals = topicRevisions.filter(
    (r) =>
      r.patch.payload.type === "propose_decision" ||
      r.patch.payload.type === "propose_alternative"
  );

  const scored = proposals
    .map((p) => scoreProposal(p, topicRevisions))
    .sort((a, b) => b.score - a.score);

  for (const s of scored) {
    const db = (s.revision.patch.payload as { value: string }).value;
    const marker = s === scored[0] ? " ←" : "";
    console.log(
      `    [${s.revision.author.padEnd(6)}] ${db.padEnd(22)} score=${s.score} (${s.reasons.join(", ")})${marker}`
    );
  }
}
