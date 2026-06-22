import type {
  Author, Topic, Revision, Proposal,
  DiscussionAnalysis, ActorPosition, DeadlockAnalysis,
  ProgressDriver, RepetitionPattern, NoveltyHighlight, UnresolvedConflict,
  SegmentAnalysisView,
} from "./types.js";
import { computeAggregation, computeStanceHistory, normalizeProposal } from "./aggregation.js";
import { extractKeywordsNT, jaccardSets } from "./novelty-tracker.js";
import { synthesizeConsensus } from "./synthesis.js";
import { detectConsensusSaturation, detectRepetitionClusters } from "./saturation.js";
import { resolveFinalConclusion } from "./final-conclusion.js";
import { buildArgumentGraph, analyzeArgumentEvolution } from "./argument-graph.js";
import { computeEvolutionPressure } from "./evolution-pressure.js";
import { analyzeBranchSurvival } from "./branch-survival.js";
import { detectConvergenceFreeze } from "./convergence-freeze.js";
import { detectPseudoDebate, buildStructuralConsensus } from "./semantic-loop.js";
import { computeConceptGravity } from "./concept-gravity.js";
import { detectQuestionEvolution } from "./question-evolution.js";
import { buildFinalResolution } from "./final-resolution.js";
import { extractCognitiveFramework } from "./cognitive-framework.js";

// ─── 키워드 추출 (aggregation.ts와 동일 로직) ────────────────────

const EN_STOPWORDS = new Set([
  "the","a","an","is","are","was","were","be","been","have","has","had",
  "do","does","did","will","would","could","should","may","to","of","in",
  "on","at","by","for","with","as","from","or","and","but","if","it",
  "its","this","that","these","those","not","no",
]);

function extractKeywords(text: string | undefined | null): Set<string> {
  if (!text) return new Set();
  return new Set(
    text.toLowerCase()
      .split(/[\s,.:;!?()\[\]{}"']+/)
      .filter(t => t.length >= 2 && !EN_STOPWORDS.has(t)),
  );
}

// ─── 품질 지표 재생 헬퍼 ─────────────────────────────────────────

function proposalToText(p: Proposal): string {
  const c = p.content as { value?: string; reason?: string };
  return `${c.value ?? ""} ${c.reason ?? ""} ${p.rationale ?? ""}`;
}

/**
 * 제안 목록을 pair round 단위로 분리해 novelty rate 배열을 반환.
 * actors에 포함된 각 author가 모두 1회씩 발언 완료 = 1 round.
 */
function computeNoveltyDecayRates(proposals: Proposal[], actors: Author[]): number[] {
  if (actors.length === 0 || proposals.length === 0) return [];

  const rates: number[]     = [];
  const seenKwds            = new Set<string>();
  let lastProcessed         = 0;
  const countPerActor       = new Map(actors.map(a => [a, 0]));

  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    if (!actors.includes(p.author)) continue;
    countPerActor.set(p.author, (countPerActor.get(p.author) ?? 0) + 1);

    const minCount = Math.min(...actors.map(a => countPerActor.get(a) ?? 0));
    const expectedRound = rates.length + 1;
    if (minCount >= expectedRound) {
      // 이번 round의 proposals 처리
      const roundProps = proposals.slice(lastProcessed, i + 1);
      lastProcessed = i + 1;

      const roundKwds = new Set<string>();
      for (const rp of roundProps) {
        for (const k of extractKeywordsNT(proposalToText(rp))) roundKwds.add(k);
      }
      const newCount = [...roundKwds].filter(k => !seenKwds.has(k)).length;
      const rate     = roundKwds.size > 0 ? newCount / roundKwds.size : 0;
      rates.push(rate);
      for (const k of roundKwds) seenKwds.add(k);
    }
  }
  return rates;
}

/**
 * pair round 단위로 actor간 평균 Jaccard 수렴 점수 배열을 반환.
 */
function computeConvergenceHistory(proposals: Proposal[], actors: Author[]): number[] {
  if (actors.length < 2 || proposals.length === 0) return [];

  const history: number[] = [];
  const countPerActor     = new Map(actors.map(a => [a, 0]));

  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    if (!actors.includes(p.author)) continue;
    countPerActor.set(p.author, (countPerActor.get(p.author) ?? 0) + 1);

    const minCount = Math.min(...actors.map(a => countPerActor.get(a) ?? 0));
    const expectedRound = history.length + 1;
    if (minCount >= expectedRound) {
      const pools = actors.map(actor => {
        const pool = new Set<string>();
        const actorProps = proposals.filter(r => r.author === actor).slice(-3);
        for (const ap of actorProps)
          for (const k of extractKeywordsNT(proposalToText(ap))) pool.add(k);
        return pool;
      });

      let total = 0, pairs = 0;
      for (let ai = 0; ai < pools.length; ai++) {
        for (let aj = ai + 1; aj < pools.length; aj++) {
          total += jaccardSets(pools[ai], pools[aj]);
          pairs++;
        }
      }
      history.push(pairs > 0 ? total / pairs : 0);
    }
  }
  return history;
}

/**
 * 각 actor의 마지막 발언 키워드 풀을 비교해 특정 actor만 사용하는 키워드 클러스터를
 * 미해결 충돌 축으로 추출한다.
 */
function computeUnresolvedConflicts(proposals: Proposal[], actors: Author[]): UnresolvedConflict[] {
  if (actors.length < 2) return [];

  // 각 actor의 마지막 3개 proposal 키워드 풀
  const pools = new Map<Author, Set<string>>();
  for (const actor of actors) {
    const pool = new Set<string>();
    const actorProps = proposals.filter(p => p.author === actor).slice(-3);
    for (const p of actorProps)
      for (const k of extractKeywordsNT(proposalToText(p))) pool.add(k);
    pools.set(actor, pool);
  }

  // actor 간 키워드 비대칭: 한쪽만 가진 키워드 집합
  const conflicts: UnresolvedConflict[] = [];

  for (let i = 0; i < actors.length; i++) {
    for (let j = i + 1; j < actors.length; j++) {
      const a = actors[i], b = actors[j];
      const poolA = pools.get(a)!;
      const poolB = pools.get(b)!;

      const onlyA = [...poolA].filter(k => !poolB.has(k)).slice(0, 3);
      const onlyB = [...poolB].filter(k => !poolA.has(k)).slice(0, 3);

      if (onlyA.length >= 2 || onlyB.length >= 2) {
        const dimension = [...new Set([...onlyA.slice(0, 2), ...onlyB.slice(0, 2)])].join(", ");
        conflicts.push({
          dimension,
          positions: [
            { actor: a, stance: onlyA.length > 0 ? onlyA.join(", ") : "(공통 어휘)" },
            { actor: b, stance: onlyB.length > 0 ? onlyB.join(", ") : "(공통 어휘)" },
          ],
        });
      }
    }
  }
  return conflicts.slice(0, 3); // 최대 3개 충돌 축
}

function truncate(s: string, max = 120): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

// ─── analyzeDiscussion ───────────────────────────────────────────
// Topic + 관련 Revision 이력을 받아 DiscussionAnalysis를 반환하는 순수 함수.
// history는 없어도 동작하지만, outcome/consensusReason 정확도가 향상됨.

export function analyzeDiscussion(
  topic:    Topic,
  history?: Revision[],
  opts?:    { segmentStartRevId?: number; segmentEndRevId?: number },
): DiscussionAnalysis {
  // 세그먼트 범위 필터 — 이전 세그먼트 score가 섞이지 않도록
  const segStart = opts?.segmentStartRevId ?? topic.currentSegmentStartRevId;
  const segEnd   = opts?.segmentEndRevId;
  const proposals = segStart !== undefined
    ? topic.proposals.filter(p =>
        p.revisionId >= segStart &&
        (segEnd === undefined || p.revisionId <= segEnd),
      )
    : topic.proposals;

  // downstream 함수들이 topic.proposals를 직접 참조하지 않도록
  // 필터된 proposals로 scoped topic을 생성
  const scopedTopic: typeof topic = { ...topic, proposals };

  const agg        = computeAggregation(scopedTopic);
  const stanceChanges = computeStanceHistory(scopedTopic);

  // ── outcome ──────────────────────────────────────────────────────
  // segment 범위 내 revision만 참조 (세그먼트 격리)
  const scopedHistory = history && (segStart !== undefined || segEnd !== undefined)
    ? history.filter(r =>
        (segStart === undefined || r.id >= segStart) &&
        (segEnd   === undefined || r.id <= segEnd),
      )
    : history;
  const hasDeadlockRev = scopedHistory?.some(r => r.patch.payload.type === "discussion_deadlock") ?? false;
  const pausedRev      = scopedHistory?.find(r => r.patch.payload.type === "discussion_paused");
  const pauseReason    = (pausedRev?.patch.payload as { reason?: string } | undefined)?.reason;

  let outcome: "decided" | "deadlock" | "paused";
  if (topic.status === "decided") {
    outcome = "decided";
  } else if (hasDeadlockRev || pauseReason === "safety_limit") {
    outcome = "deadlock";
  } else {
    outcome = "paused";
  }

  // ── dominant stance ───────────────────────────────────────────────
  const top            = agg[0];
  const dominantStance = top?.value ?? "";
  const dominantReason = top?.latestReason ?? "";

  // ── summary ──────────────────────────────────────────────────────
  let summary: string;
  if (outcome === "decided" && topic.selectedOption) {
    const sel = topic.selectedOption.content as { value: string; reason: string };
    summary = truncate(sel.reason, 150);
  } else if (outcome === "deadlock" && agg.length >= 2) {
    summary = `'${agg[0].value}' vs '${agg[1].value}' — 평가 기준 불일치로 교착`;
  } else {
    summary = dominantReason.length > 0
      ? truncate(dominantReason, 150)
      : `${proposals.length}회 발언 후 ${outcome === "paused" ? "중단" : "종료"}`;
  }

  // ── progress drivers ─────────────────────────────────────────────
  // concede(양보) > refine(발전) > propose > defend 순으로 진전 가중치 부여
  const driverMap = new Map<Author, { score: number; highlights: string[] }>();
  for (const p of proposals) {
    const c = p.content as { value: string; reason: string; stanceAction?: string };
    const w = c.stanceAction === "concede" ? 2.0
            : c.stanceAction === "refine"  ? 1.5
            : c.stanceAction === "propose" ? 0.5 : 0.3;
    const entry = driverMap.get(p.author) ?? { score: 0, highlights: [] };
    entry.score += w;
    if (c.stanceAction === "concede") {
      entry.highlights.push(`양보: '${truncate(c.value, 40)}'`);
    } else if (c.stanceAction === "refine") {
      entry.highlights.push(`발전: '${truncate(c.value, 40)}'`);
    }
    driverMap.set(p.author, entry);
  }
  const progressDrivers: ProgressDriver[] = [...driverMap.entries()]
    .filter(([, v]) => v.highlights.length > 0)
    .map(([actor, v]) => ({ actor, score: Math.round(v.score * 10) / 10, highlights: v.highlights }))
    .sort((a, b) => b.score - a.score);

  // ── repetitions ──────────────────────────────────────────────────
  const repCount = new Map<string, { actor: Author; value: string; count: number }>();
  for (const p of proposals) {
    const val     = (p.content as { value: string }).value;
    const normKey = normalizeProposal(val);
    const key     = `${p.author}::${normKey}`;
    const entry   = repCount.get(key) ?? { actor: p.author, value: val, count: 0 };
    entry.count++;
    repCount.set(key, entry);
  }
  const repetitions: RepetitionPattern[] = [...repCount.values()]
    .filter(r => r.count >= 3)
    .sort((a, b) => b.count - a.count);

  // ── novelty highlights ────────────────────────────────────────────
  // 동일 normalKey에 대해 처음 등장하지 않은 새 키워드가 3개 이상이면 novelty 표시
  const seenKwByKey = new Map<string, Set<string>>();
  const noveltyHighlights: NoveltyHighlight[] = [];
  const NOVELTY_MIN = 3;
  for (const p of proposals) {
    const c        = p.content as { value: string; reason: string };
    const rationale = p.rationale ?? c.reason ?? c.value ?? "";
    const normKey  = normalizeProposal(c.value ?? "");
    const kwds     = extractKeywords(rationale);
    const seen     = seenKwByKey.get(normKey) ?? new Set<string>();
    const newCount = [...kwds].filter(k => !seen.has(k)).length;
    if (newCount >= NOVELTY_MIN) {
      noveltyHighlights.push({
        actor:     p.author,
        value:     c.value,
        rationale: truncate(rationale, 150),
      });
    }
    for (const k of kwds) seen.add(k);
    seenKwByKey.set(normKey, seen);
  }

  // ── consensus reason ─────────────────────────────────────────────
  let consensusReason: string | undefined;
  if (outcome === "decided") {
    const consensusRev = scopedHistory?.find(r => r.patch.payload.type === "consensus_reached");
    if (consensusRev) {
      const pl = consensusRev.patch.payload as { selected: string; winner: string };
      consensusReason = `${pl.winner}의 '${truncate(pl.selected, 60)}' 안이 자동 합의로 채택`;
    } else {
      consensusReason = "사용자가 최종 안을 직접 채택";
    }
  }

  // ── deadlock analysis ─────────────────────────────────────────────
  let deadlockAnalysis: DeadlockAnalysis | undefined;
  if (outcome === "deadlock") {
    const lastByActor = new Map<Author, { value: string; reason: string }>();
    for (const p of proposals) {
      const c = p.content as { value: string; reason: string };
      lastByActor.set(p.author, { value: c.value, reason: c.reason });
    }
    const actorPositions: ActorPosition[] = [...lastByActor.entries()].map(([actor, pos]) => ({
      actor,
      corePosition: pos.value,
      premise:      truncate(pos.reason, 100),
    }));

    const conflictPoint = agg.length >= 2
      ? `'${agg[0].value}' vs '${agg[1].value}'`
      : `'${dominantStance}' — 합의 점수 미달`;

    const allFixed    = stanceChanges.length === 0;
    const concessions = progressDrivers.reduce(
      (n, d) => n + d.highlights.filter(h => h.startsWith("양보")).length, 0
    );
    let whyNoConsensus: string;
    if (allFixed) {
      whyNoConsensus = `모든 참여자가 ${proposals.length}회 발언 동안 초기 입장을 유지했습니다. 공통 평가 기준 합의에 실패했습니다.`;
    } else if (concessions === 0) {
      whyNoConsensus = `입장 변화 시도는 있었으나 어느 쪽도 핵심 전제를 양보하지 않아 수렴에 실패했습니다.`;
    } else {
      whyNoConsensus = `${concessions}회 양보가 있었으나 상대방의 핵심 전제와 평가 기준이 끝까지 불일치했습니다.`;
    }

    deadlockAnalysis = { actorPositions, conflictPoint, whyNoConsensus };
  }

  // ── 품질 지표 (Phase 1) ──────────────────────────────────────────
  const actors: Author[] = [...new Set(proposals.map(p => p.author))].filter(
    a => a !== "system" && a !== "user",
  ) as Author[];

  const noveltyDecayRates  = computeNoveltyDecayRates(proposals, actors);
  const convergenceHistory = computeConvergenceHistory(proposals, actors);

  // 연속 저-novelty 라운드 수 (역산)
  const STAGNATION_THRESHOLD = 0.08;
  let stagnationRounds = 0;
  for (let i = noveltyDecayRates.length - 1; i >= 0; i--) {
    if (noveltyDecayRates[i] <= STAGNATION_THRESHOLD) stagnationRounds++;
    else break;
  }

  const unresolvedConflicts: UnresolvedConflict[] =
    outcome !== "decided" ? computeUnresolvedConflicts(proposals, actors) : [];

  // ── softConsensusNote ────────────────────────────────────────────
  let softConsensusNote: string | undefined;
  if (
    pauseReason === "soft_consensus" ||
    pauseReason === "discussion_exhausted" ||
    pauseReason === "semantic_convergence" ||
    pauseReason === "branch_frozen"
  ) {
    const lastScore = convergenceHistory[convergenceHistory.length - 1];
    softConsensusNote = lastScore !== undefined
      ? `AI 참여자들의 논거 어휘가 점진적으로 수렴되어 자동 종료되었습니다 (수렴도 ${(lastScore * 100).toFixed(0)}%).`
      : "AI 참여자들의 논거 프레임이 의미적으로 수렴하여 자동 종료되었습니다.";
  }

  // ── 반복 클러스터 + 포화 감지 ───────────────────────────────────
  const repetitionClusters = detectRepetitionClusters(proposals);
  const saturation = proposals.length >= 6
    ? detectConsensusSaturation(proposals, convergenceHistory, noveltyDecayRates, unresolvedConflicts)
    : undefined;

  // ── 합성 결론 ────────────────────────────────────────────────────
  const synthesizedConsensus = proposals.length >= 3
    ? synthesizeConsensus(proposals, actors, convergenceHistory, {
        repetitionClusters,
        unresolvedConflicts,
        isFinalization: pauseReason === "consensus_saturated" || pauseReason === "soft_consensus",
      })
    : undefined;

  // ── Argument Graph Layer (finalConclusion 계산 전) ───────────────
  // Argument graph를 먼저 빌드해야 resolveFinalConclusion에서 활용 가능
  const argumentGraph = proposals.length >= 2
    ? buildArgumentGraph(scopedTopic)
    : undefined;
  const argumentEvolution = argumentGraph && argumentGraph.nodes.length >= 2
    ? analyzeArgumentEvolution(argumentGraph)
    : undefined;

  // ── Evolution Pressure ───────────────────────────────────────────
  const sharedKwdsForEvo = new Set(
    (synthesizedConsensus?.sharedConcepts ?? []).map(c => c.keyword),
  );
  const evolutionPressure = proposals.length >= 3
    ? computeEvolutionPressure(
        proposals,
        actors,
        synthesizedConsensus?.absorbedArguments,
        sharedKwdsForEvo,
      )
    : undefined;

  // ── Branch Survival ──────────────────────────────────────────────
  const branchSurvival = proposals.length >= 3 && actors.length >= 2
    ? analyzeBranchSurvival(scopedTopic, argumentGraph, argumentEvolution)
    : undefined;

  // ── Convergence Freeze ───────────────────────────────────────────
  const convergenceFreeze = proposals.length >= 4
    ? detectConvergenceFreeze(proposals, branchSurvival, convergenceHistory)
    : undefined;

  // ── Semantic Loop / Pseudo-Debate ────────────────────────────────
  const semanticLoop = proposals.length >= 6 && actors.length >= 2
    ? detectPseudoDebate(proposals, actors, convergenceHistory, noveltyDecayRates)
    : undefined;

  // ── Structural Consensus ─────────────────────────────────────────
  const structuralConsensus =
    semanticLoop?.isPseudoDebate && (semanticLoop.sharedCoreConcepts.length >= 4)
      ? buildStructuralConsensus(proposals, actors, semanticLoop)
      : undefined;

  // ── Concept Gravity ──────────────────────────────────────────────
  const conceptGravity = proposals.length >= 4 && actors.length >= 2
    ? computeConceptGravity(proposals, actors, synthesizedConsensus ?? undefined)
    : undefined;

  // ── softConsensusNote: pseudo_convergence 추가 ───────────────────
  if (!softConsensusNote && pauseReason === "pseudo_convergence") {
    const core = semanticLoop?.sharedCoreConcepts.slice(0, 3).join(", ");
    softConsensusNote = core
      ? `표면 불일치 이면에 "${core}" 구조 수렴 감지 — Semantic Loop로 자동 종료됨.`
      : "Semantic Loop(의미 반복) 감지 — 표면 불일치 이면에 구조 수렴이 일어났습니다.";
  }

  // ── Question Evolution ───────────────────────────────────────────
  const questionEvolution = proposals.length >= 4 && actors.length >= 1
    ? detectQuestionEvolution(topic, proposals, actors, {
        branchSurvival,
        synthesizedConsensus: synthesizedConsensus ?? undefined,
      })
    : undefined;

  const partialAnalysis = {
    summary,
    outcome,
    dominantStance,
    dominantReason,
    stanceChanges,
    repetitions,
    noveltyHighlights,
    progressDrivers,
    consensusReason,
    deadlockAnalysis,
    noveltyDecayRates,
    convergenceHistory,
    stagnationRounds,
    unresolvedConflicts,
    softConsensusNote,
    synthesizedConsensus: synthesizedConsensus ?? undefined,
    saturation,
    repetitionClusters:   repetitionClusters.length > 0 ? repetitionClusters : undefined,
    argumentGraph,
    argumentEvolution,
    evolutionPressure,
    branchSurvival,
    convergenceFreeze,
    semanticLoop,
    conceptGravity,
    structuralConsensus,
    questionEvolution,
  };

  // resolveFinalConclusion은 argumentGraph/argumentEvolution을 포함한 분석을 받음
  const finalConclusion = resolveFinalConclusion(scopedTopic, partialAnalysis) ?? undefined;

  const withFc = { ...partialAnalysis, finalConclusion };

  // ── Final Resolution (최상위 진화 결론) ──────────────────────────
  const finalResolution = proposals.length >= 4 && actors.length >= 1
    ? buildFinalResolution(proposals, actors, withFc)
    : undefined;

  const withFr = { ...withFc, finalResolution };

  // ── Cognitive Framework ───────────────────────────────────────────
  const cognitiveFramework = proposals.length >= 4
    ? extractCognitiveFramework(withFr)
    : undefined;

  return { ...withFr, cognitiveFramework };
}

// ─── analyzeTopics ───────────────────────────────────────────────
// RunResult 빌드 시 topics 전체를 한번에 분석

export function analyzeTopics(topics: Topic[], history: Revision[]): DiscussionAnalysis[] {
  return topics.map(topic => analyzeDiscussion(topic, history));
}

// ─── buildSegmentViews ───────────────────────────────────────────
// Topic의 segments 배열을 순회해 세그먼트별 독립 분석 뷰를 빌드한다.

export function buildSegmentViews(topic: Topic, history: Revision[]): SegmentAnalysisView[] {
  if (!topic.segments || topic.segments.length === 0) return [];

  return topic.segments.map(seg => {
    const analysis = analyzeDiscussion(topic, history, {
      segmentStartRevId: seg.startRevisionId,
      segmentEndRevId:   seg.endRevisionId,
    });

    let interjectionMessage: string | undefined;
    if (seg.segmentId > 1) {
      const interjRev = history.find(r => r.id === seg.startRevisionId);
      if (interjRev?.patch.payload.type === "user_interjection") {
        interjectionMessage = (interjRev.patch.payload as { message?: string }).message;
      }
    }

    // segment 범위 내 proposal revision id 목록 (UI 격리 검증용)
    const proposalRevisionIds = seg.proposalRevisionIds.length > 0
      ? seg.proposalRevisionIds
      : topic.proposals
          .filter(p =>
            p.revisionId >= seg.startRevisionId &&
            (seg.endRevisionId === undefined || p.revisionId <= seg.endRevisionId),
          )
          .map(p => p.revisionId);

    return {
      segmentId:           seg.segmentId,
      startRevisionId:     seg.startRevisionId,
      endRevisionId:       seg.endRevisionId,
      proposalRevisionIds,
      analysis,
      interjectionMessage,
      summary: {
        dominantConclusion: analysis.finalConclusion?.text ?? analysis.dominantStance,
        convergenceType:    analysis.convergenceFreeze?.freezeType,
        survivingBranch:    analysis.branchSurvival?.dominantBranch?.finalProposalValue,
      },
    };
  });
}
