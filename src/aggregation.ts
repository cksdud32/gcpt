import type { Author, Topic, AggregatedProposal, ActorStanceHistory, StanceShift } from "./types.js";

// ─── Alias Map ────────────────────────────────────────────────────
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

// ─── Scoring constants ────────────────────────────────────────────

// 같은 actor가 같은 normalKey를 반복할수록 점수 증분 감소
const REPETITION_DECAY = [1.0, 0.7, 0.4, 0.2];

// stanceAction별 점수 배율: 양보/발전일수록 높게
const STANCE_WEIGHT: Record<string, number> = {
  defend:  1.0,
  propose: 1.1,
  refine:  1.3,
  concede: 1.5,
};

const RECENCY_BONUS      = 0.5;  // 마지막 3개 proposal에 추가
const NOVELTY_BONUS      = 0.5;  // 새 논거 차원 도입 시 추가
const NOVELTY_MIN_NEW_KW = 2;    // 새 keyword가 이 수 이상일 때만 novelty bonus

// 영어 불용어 (한국어 token은 해당 없음)
const EN_STOPWORDS = new Set([
  "the","a","an","is","are","was","were","be","been","have","has","had",
  "do","does","did","will","would","could","should","may","to","of","in",
  "on","at","by","for","with","as","from","or","and","but","if","it",
  "its","this","that","these","those","not","no",
]);

function extractKeywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s,.:;!?()\[\]{}"']+/)
      .filter(t => t.length >= 2 && !EN_STOPWORDS.has(t)),
  );
}

// ─── computeAggregation ───────────────────────────────────────────
// Topic.proposals[]를 읽어 AggregatedProposal[] 반환 (순수 파생 상태)
// 점수 = (base + recencyBonus) × stanceWeight × repetitionDecay + noveltyBonus
export function computeAggregation(topic: Topic): AggregatedProposal[] {
  const map             = new Map<string, AggregatedProposal>();
  const total           = topic.proposals.length;
  const recentThreshold = Math.max(0, total - 3);

  // 같은 actor가 같은 normalKey를 몇 번 언급했는지 추적
  const actorMentions = new Map<string, number>(); // key: `${author}:${normalKey}`
  // 각 normalKey에 대해 지금까지 등장한 rationale keyword 집합
  const seenKeywords  = new Map<string, Set<string>>(); // key: normalKey

  for (let idx = 0; idx < total; idx++) {
    const p       = topic.proposals[idx];
    const content = p.content as {
      value:        string;
      reason:       string;
      rationale?:   string;
      stanceAction?: string;
    };
    const value     = content.value;
    const reason    = content.reason;
    const rationale = content.rationale ?? "";
    const stance    = content.stanceAction ?? "propose";
    const normalKey = normalizeProposal(value);

    // repetition decay
    const actorKey   = `${p.author}:${normalKey}`;
    const priorCount = actorMentions.get(actorKey) ?? 0;
    actorMentions.set(actorKey, priorCount + 1);
    const repDecay   = REPETITION_DECAY[Math.min(priorCount, REPETITION_DECAY.length - 1)];

    // base + recency
    const base = 1.0 + (idx >= recentThreshold ? RECENCY_BONUS : 0);

    // stance weight
    const stanceWeight = STANCE_WEIGHT[stance] ?? 1.0;

    // novelty bonus: rationale에 새 keyword ≥ NOVELTY_MIN_NEW_KW개 등장 시
    let noveltyBonus = 0;
    if (rationale.length > 0) {
      const kwds = extractKeywords(rationale);
      const seen = seenKeywords.get(normalKey) ?? new Set<string>();
      const newKwCount = [...kwds].filter(k => !seen.has(k)).length;
      if (newKwCount >= NOVELTY_MIN_NEW_KW) noveltyBonus = NOVELTY_BONUS;
      for (const k of kwds) seen.add(k);
      seenKeywords.set(normalKey, seen);
    }

    const scoreInc = base * stanceWeight * repDecay + noveltyBonus;

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

// ─── computeStanceHistory ─────────────────────────────────────────
// actor별 입장 변화 흐름을 반환 (shift가 1회 이상인 actor만 포함)
// trail: 변화 지점만 기록 (RLE) — 연속 동일 값은 축약
// 반환 순서: shift 횟수 내림차순
export function computeStanceHistory(topic: Topic): ActorStanceHistory[] {
  const actorMap = new Map<Author, {
    trail:      string[];   // display values (original), 변화 시점만
    shifts:     StanceShift[];
    lastNormal: string;
    lastValue:  string;
  }>();

  for (const p of topic.proposals) {
    const value     = (p.content as { value: string }).value;
    const normalKey = normalizeProposal(value);
    const actor     = p.author;

    const existing = actorMap.get(actor);
    if (!existing) {
      actorMap.set(actor, {
        trail:      [value],
        shifts:     [],
        lastNormal: normalKey,
        lastValue:  value,
      });
    } else if (existing.lastNormal !== normalKey) {
      existing.shifts.push({
        from:       existing.lastValue,
        to:         value,
        revisionId: p.revisionId,
      });
      existing.trail.push(value);
      existing.lastNormal = normalKey;
      existing.lastValue  = value;
    }
    // 같은 normalKey 반복 → trail/shifts 변경 없음
  }

  const result: ActorStanceHistory[] = [];
  for (const [actor, st] of actorMap) {
    if (st.shifts.length === 0) continue;
    result.push({
      actor,
      current: st.lastValue,
      trail:   st.trail,
      shifts:  st.shifts,
    });
  }

  return result.sort((a, b) => b.shifts.length - a.shifts.length);
}
