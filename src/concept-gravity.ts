import type {
  Proposal, Author,
  ConceptGravityEntry, ConceptGravityMap,
  SynthesizedConsensus,
} from "./types.js";
import { extractKeywordsNT } from "./novelty-tracker.js";

function proposalToText(p: Proposal): string {
  const c = p.content as { value?: string; reason?: string };
  return `${c.value ?? ""} ${c.reason ?? ""} ${p.rationale ?? ""}`;
}

// ─── computeConceptGravity ───────────────────────────────────────
// "무슨 개념이 토론을 지배했는가" — 개념별 influence map 생성

export function computeConceptGravity(
  proposals:  Proposal[],
  actors:     Author[],
  synthesis?: SynthesizedConsensus,
): ConceptGravityMap | undefined {
  if (proposals.length < 4 || actors.length < 2) return undefined;

  interface ConceptData {
    firstActor:    Author;
    actorSet:      Set<Author>;
    roundSet:      Set<number>;   // actor-relative round index에서 유니크 집합
    concedeCount:  number;
    totalAppear:   number;
  }

  const data       = new Map<string, ConceptData>();
  const actorSeq   = new Map<Author, number>();
  const maxRoundPerActor = new Map<Author, number>();

  for (const p of proposals) {
    if (!actors.includes(p.author)) continue;
    const seq = actorSeq.get(p.author) ?? 0;
    actorSeq.set(p.author, seq + 1);
    maxRoundPerActor.set(p.author, seq);

    const isConcede = (p.content as { stanceAction?: string }).stanceAction === "concede";
    const kwds = extractKeywordsNT(proposalToText(p));

    for (const k of kwds) {
      const d = data.get(k);
      if (!d) {
        data.set(k, {
          firstActor:   p.author,
          actorSet:     new Set([p.author]),
          roundSet:     new Set([seq]),
          concedeCount: isConcede ? 1 : 0,
          totalAppear:  1,
        });
      } else {
        d.actorSet.add(p.author);
        d.roundSet.add(seq);
        if (isConcede) d.concedeCount++;
        d.totalAppear++;
      }
    }
  }

  // synthesis 참여 키워드 집합
  const synthesisKwds = new Set(
    (synthesis?.sharedConcepts ?? []).map(c => c.keyword),
  );

  // 전체 최대 round (정규화용)
  const maxRound = Math.max(...[...maxRoundPerActor.values()], 1);

  const entries: ConceptGravityEntry[] = [];

  for (const [concept, d] of data) {
    const survivedRounds         = d.roundSet.size;
    const adoptersCount          = d.actorSet.size;
    const concedeInfluence       = d.concedeCount;
    const synthesisParticipation = synthesisKwds.has(concept);

    // 최소 기준: 2라운드 이상 OR 2명 이상 actor
    if (survivedRounds < 2 && adoptersCount < 2) continue;

    const gravityScore =
      survivedRounds          * 1.5 +
      adoptersCount           * 3.0 +
      concedeInfluence        * 5.0 +
      (synthesisParticipation ? 10 : 0) +
      (survivedRounds / maxRound) * 4.0;   // 지속성 보너스

    entries.push({
      concept,
      gravityScore:          Math.round(gravityScore * 10) / 10,
      firstActor:            d.firstActor,
      survivedRounds,
      adoptersCount,
      concedeInfluence,
      synthesisParticipation,
    });
  }

  entries.sort((a, b) => b.gravityScore - a.gravityScore);
  const topConcepts = entries.slice(0, 8);

  if (topConcepts.length === 0) return undefined;

  const top = topConcepts[0]!;
  const gravityNote =
    `"${top.concept}" 개념이 토론 전체를 이끌었습니다 (점수 ${top.gravityScore}). ` +
    (topConcepts.length >= 3
      ? `"${topConcepts[1]!.concept}", "${topConcepts[2]!.concept}"이 핵심 구조를 형성했습니다.`
      : "");

  return { topConcepts, dominantConcept: top.concept, gravityNote };
}
