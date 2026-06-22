import type {
  Proposal, Author,
  SemanticLoopAnalysis, RepeatedFrame,
  StructuralConsensus, SurfaceConflict,
} from "./types.js";
import { extractKeywordsNT, jaccardSets } from "./novelty-tracker.js";

// ─── 유틸 ─────────────────────────────────────────────────────────

function proposalToText(p: Proposal): string {
  const c = p.content as { value?: string; reason?: string };
  return `${c.value ?? ""} ${c.reason ?? ""} ${p.rationale ?? ""}`;
}

function proposalValue(p: Proposal): string {
  return (p.content as { value?: string }).value ?? "";
}

// actor별 순차 round 기준 keyword pool 빌드
function buildActorRoundPools(
  proposals: Proposal[],
  actors: Author[],
): Map<Author, Set<string>[]> {
  const map = new Map<Author, Set<string>[]>();
  for (const actor of actors) {
    map.set(
      actor,
      proposals
        .filter(p => p.author === actor)
        .map(p => extractKeywordsNT(proposalToText(p))),
    );
  }
  return map;
}

// actor 내 연속 round 간 평균 drift (1 - Jaccard)
function actorDrift(pools: Set<string>[]): number {
  if (pools.length < 2) return 1;
  let sum = 0;
  for (let i = 1; i < pools.length; i++) {
    sum += 1 - jaccardSets(pools[i - 1], pools[i]);
  }
  return sum / (pools.length - 1);
}

// ─── detectPseudoDebate ──────────────────────────────────────────
// 표면 불일치가 유지되지만 의미 구조는 이미 수렴된 상태 탐지

export function detectPseudoDebate(
  proposals:          Proposal[],
  actors:             Author[],
  convergenceHistory: number[],
  noveltyDecayRates:  number[],
): SemanticLoopAnalysis {
  const EMPTY: SemanticLoopAnalysis = {
    isPseudoDebate:     false,
    semanticDriftScore: 1,
    sharedCoreConcepts: [],
    repeatedFrames:     [],
  };

  if (proposals.length < 6 || actors.length < 2) return EMPTY;

  const actorRoundPools = buildActorRoundPools(proposals, actors);

  // 1. semantic drift: 각 actor의 round-to-round 평균 변화량, 전체 평균
  let driftSum = 0, driftN = 0;
  for (const actor of actors) {
    const pools = actorRoundPools.get(actor) ?? [];
    if (pools.length >= 2) { driftSum += actorDrift(pools); driftN++; }
  }
  const semanticDriftScore = driftN > 0
    ? Math.round((driftSum / driftN) * 100) / 100
    : 1;

  // 2. shared core: 모든 actor 최근 3개 proposal 키워드 교집합
  const recentPools = actors.map(actor => {
    const pool = new Set<string>();
    for (const p of proposals.filter(q => q.author === actor).slice(-3))
      for (const k of extractKeywordsNT(proposalToText(p))) pool.add(k);
    return pool;
  });
  let sharedArr: string[] | null = null;
  for (const pool of recentPools) {
    sharedArr = sharedArr
      ? sharedArr.filter((k: string) => pool.has(k))
      : [...pool];
  }
  const sharedCoreConcepts = (sharedArr ?? []).slice(0, 12);

  // 3. repeated frames: proposals 전체에서 반복 등장 concept 집계
  const conceptMeta = new Map<string, {
    actorSet: Set<Author>;
    rounds:   Set<number>;  // actor-relative round index
    count:    number;
  }>();
  const actorSeq = new Map<Author, number>();

  for (const p of proposals) {
    if (!actors.includes(p.author)) continue;
    const seq = actorSeq.get(p.author) ?? 0;
    actorSeq.set(p.author, seq + 1);
    for (const k of extractKeywordsNT(proposalToText(p))) {
      const m = conceptMeta.get(k) ?? { actorSet: new Set(), rounds: new Set(), count: 0 };
      m.actorSet.add(p.author);
      m.rounds.add(seq);
      m.count++;
      conceptMeta.set(k, m);
    }
  }

  const minRepeat = Math.max(3, Math.floor(proposals.length * 0.25));
  const repeatedFrames: RepeatedFrame[] = [];
  for (const [concept, m] of conceptMeta) {
    if (m.count >= minRepeat) {
      const roundArr = [...m.rounds].sort((a, b) => a - b);
      repeatedFrames.push({
        concept,
        actors:      [...m.actorSet],
        repeatCount: m.count,
        firstRound:  roundArr[0] ?? 0,
        lastRound:   roundArr[roundArr.length - 1] ?? 0,
      });
    }
  }
  repeatedFrames.sort((a, b) => b.repeatCount - a.repeatCount);

  // 4. isPseudoDebate 판정
  const recentNovelty  = noveltyDecayRates.slice(-3);
  const avgNovelty     = recentNovelty.length > 0
    ? recentNovelty.reduce((s, r) => s + r, 0) / recentNovelty.length : 1;
  const currentConv    = convergenceHistory[convergenceHistory.length - 1] ?? 0;

  // 표면 불일치 유지 확인: 마지막 각 actor 입장이 서로 다른가
  const lastByActor = actors.map(a => {
    const val = proposalValue(proposals.filter(p => p.author === a).slice(-1)[0] ?? proposals[0]);
    return val.slice(0, 30).toLowerCase();
  });
  const surfaceDisagreementMaintained =
    lastByActor.length >= 2 &&
    lastByActor[0] !== lastByActor[lastByActor.length - 1];

  const isPseudoDebate =
    surfaceDisagreementMaintained &&
    semanticDriftScore < 0.30 &&
    sharedCoreConcepts.length >= 4 &&
    avgNovelty        <= 0.10 &&
    currentConv       >= 0.25;

  // 5. collapseReason
  let collapseReason: string | undefined;
  if (isPseudoDebate) {
    const topCore = sharedCoreConcepts.slice(0, 3);
    collapseReason = topCore.length > 0
      ? `"${topCore.join(", ")}"를 중심으로 의미 수렴 — 표면 불일치가 구조적 합의를 가리고 있음`
      : "표면 불일치 이면에 논거 구조가 수렴된 상태";
  }

  // 6. loopRevisionRange: drift < 0.2가 시작된 첫 revision
  let loopStartRevId: number | undefined;
  for (const actor of actors) {
    const actorProps = proposals.filter(p => p.author === actor);
    const pools = actorRoundPools.get(actor) ?? [];
    for (let i = 1; i < pools.length; i++) {
      if (1 - jaccardSets(pools[i - 1], pools[i]) < 0.2) {
        const revId = actorProps[i]?.revisionId;
        if (revId !== undefined)
          loopStartRevId = loopStartRevId !== undefined
            ? Math.min(loopStartRevId, revId) : revId;
        break;
      }
    }
  }
  const lastRevId = proposals[proposals.length - 1]?.revisionId;

  return {
    isPseudoDebate,
    semanticDriftScore,
    sharedCoreConcepts,
    repeatedFrames: repeatedFrames.slice(0, 8),
    collapseReason,
    loopRevisionRange: loopStartRevId !== undefined && lastRevId !== undefined
      ? { from: loopStartRevId, to: lastRevId }
      : undefined,
  };
}

// ─── buildStructuralConsensus ────────────────────────────────────
// pseudo-debate 감지 시 호출 — surface conflict와 shared structure 추출

export function buildStructuralConsensus(
  proposals:    Proposal[],
  actors:       Author[],
  semanticLoop: SemanticLoopAnalysis,
): StructuralConsensus {
  const surfaceConflicts: SurfaceConflict[] = actors.map(actor => {
    const lastProp = proposals.filter(p => p.author === actor).slice(-1)[0];
    const surfacePosition = proposalValue(lastProp ?? proposals[0]).slice(0, 120);

    const actorKwds = new Set<string>();
    for (const p of proposals.filter(q => q.author === actor))
      for (const k of extractKeywordsNT(proposalToText(p))) actorKwds.add(k);

    const contribution = semanticLoop.sharedCoreConcepts
      .filter(k => actorKwds.has(k))
      .slice(0, 5);

    return { actor, surfacePosition, sharedStructureContribution: contribution };
  });

  const core    = semanticLoop.sharedCoreConcepts.slice(0, 5);
  const coreStr = core.join(", ");
  const structuralNote = core.length >= 4
    ? `표면적 불일치 이면에 "${coreStr}" 구조 공유 — 토론은 실질적으로 구조 수렴 상태입니다.`
    : `"${coreStr}" 개념을 중심으로 논리 구조가 수렴하고 있습니다.`;

  return {
    sharedStructure:  semanticLoop.sharedCoreConcepts.slice(0, 10),
    surfaceConflicts,
    structuralNote,
  };
}
