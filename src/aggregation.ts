import type { Author, Topic, AggregatedProposal } from "./types.js";

// ─── Alias Map ────────────────────────────────────────────────────
// 동일 기술의 다양한 표기를 단일 normalKey로 수렴
const ALIAS_MAP: Record<string, string> = {
  postgres:      "postgresql",
  pg:            "postgresql",
  mongo:         "mongodb",
  dynamo:        "dynamodb",
  cockroach:     "cockroachdb",
  "redis cache": "redis",
};

export function normalizeProposal(value: string): string {
  const lower = value.trim().toLowerCase();
  return ALIAS_MAP[lower] ?? lower;
}

// ─── computeAggregation ───────────────────────────────────────────
// Topic.proposals[]를 읽어 AggregatedProposal[] 반환 (순수 파생 상태)
// append-only revision history는 건드리지 않음
export function computeAggregation(topic: Topic): AggregatedProposal[] {
  const map = new Map<string, AggregatedProposal>();
  const total = topic.proposals.length;
  // 마지막 3개 proposal을 "최근" 으로 간주 → +2 보너스
  const recentThreshold = Math.max(0, total - 3);

  for (let idx = 0; idx < total; idx++) {
    const p = topic.proposals[idx];
    const value  = (p.content as { value: string }).value;
    const reason = (p.content as { value: string; reason: string }).reason;
    const normalKey = normalizeProposal(value);
    const scoreInc  = idx >= recentThreshold ? 2 : 1;

    if (!map.has(normalKey)) {
      map.set(normalKey, {
        value,
        normalKey,
        score:        0,
        mentions:     0,
        supporters:   [],
        latestReason: reason,
        firstRevId:   p.revisionId,
        lastRevId:    p.revisionId,
        isSelected:   false,
      });
    }

    const agg = map.get(normalKey)!;
    agg.score       += scoreInc;
    agg.mentions    += 1;
    agg.latestReason = reason;
    agg.lastRevId    = p.revisionId;

    const existing = agg.supporters.find(s => s.author === p.author);
    if (existing) {
      existing.count++;
      existing.lastRevId = p.revisionId;
    } else {
      agg.supporters.push({ author: p.author, count: 1, lastRevId: p.revisionId });
    }
  }

  // selectedOption과 normalKey가 일치하면 isSelected = true
  if (topic.selectedOption) {
    const selKey = normalizeProposal(
      (topic.selectedOption.content as { value: string }).value,
    );
    const selAgg = map.get(selKey);
    if (selAgg) selAgg.isSelected = true;
  }

  // score 내림차순, 동점 시 firstRevId 오름차순 (선착 우선)
  return [...map.values()].sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.firstRevId - b.firstRevId,
  );
}

// ─── computeStances ───────────────────────────────────────────────
// 각 AI actor가 마지막으로 지지한 proposal value 반환
// reopened 이후 새 발언이 있으면 자동으로 갱신됨
export function computeStances(topic: Topic): Map<Author, string> {
  const stances = new Map<Author, string>();
  for (const p of topic.proposals) {
    const value = (p.content as { value: string }).value;
    stances.set(p.author, value);
  }
  return stances;
}
