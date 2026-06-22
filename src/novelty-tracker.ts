import type { Revision } from "./types.js";

// ─── 공용 유틸 ────────────────────────────────────────────────────

const EN_STOPWORDS = new Set([
  "the","a","an","is","are","was","were","be","been","have","has","had",
  "do","does","did","will","would","could","should","may","to","of","in",
  "on","at","by","for","with","as","from","or","and","but","if","it",
  "its","this","that","these","those","not","no",
]);

export function extractKeywordsNT(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .split(/[\s,.:;!?()\[\]{}"']+/)
      .filter(t => t.length >= 2 && !EN_STOPWORDS.has(t)),
  );
}

function proposalText(rev: Revision): string {
  const p = rev.patch.payload as { value?: string; reason?: string };
  return `${p.value ?? ""} ${p.reason ?? ""} ${rev.patch.rationale ?? ""}`;
}

export function jaccardSets(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const k of a) if (b.has(k)) inter++;
  return inter / (a.size + b.size - inter);
}

// ─── NoveltyTracker ───────────────────────────────────────────────
// 라운드별 novelty rate(새 키워드 비율)를 누적 추적.
// 연속 N라운드가 threshold 이하이면 semantic stagnation으로 판단한다.

export class NoveltyTracker {
  private rates:        number[]         = [];
  private seenKeywords: Set<string>      = new Set();
  private lastPropCount = 0;             // 직전 round까지 처리된 proposal 수

  /**
   * 새 pair round 완성 시 호출.
   * currentProposals: 해당 topic의 전체 proposal revision 목록.
   * 내부적으로 이번 라운드에 추가된 분만 분리해 novelty를 계산한다.
   */
  addRound(currentProposals: Revision[]): number {
    const roundProps = currentProposals.slice(this.lastPropCount);
    this.lastPropCount = currentProposals.length;

    const roundKwds = new Set<string>();
    for (const r of roundProps) {
      for (const k of extractKeywordsNT(proposalText(r))) roundKwds.add(k);
    }

    const newCount = [...roundKwds].filter(k => !this.seenKeywords.has(k)).length;
    const rate     = roundKwds.size > 0 ? newCount / roundKwds.size : 0;

    this.rates.push(rate);
    for (const k of roundKwds) this.seenKeywords.add(k);
    return rate;
  }

  /** 최근 window 라운드가 모두 threshold 이하이면 true */
  isStagnating(window = 3, threshold = 0.08): boolean {
    const recent = this.rates.slice(-window);
    return recent.length >= window && recent.every(r => r <= threshold);
  }

  /** threshold 이하인 연속 라운드 수 (마지막부터 역산) */
  stagnationRounds(threshold = 0.08): number {
    let n = 0;
    for (let i = this.rates.length - 1; i >= 0; i--) {
      if (this.rates[i] <= threshold) n++;
      else break;
    }
    return n;
  }

  getRates(): readonly number[] { return this.rates; }

  reset(): void {
    this.rates        = [];
    this.seenKeywords = new Set();
    this.lastPropCount = 0;
  }

  /** phase 전환 시 rate 이력만 초기화. seenKeywords/lastPropCount는 유지해 중복 계산 방지. */
  resetRates(): void {
    this.rates = [];
  }
}

// ─── ConvergenceDetector ──────────────────────────────────────────
// 매 round, actor 간 pairwise Jaccard 평균을 계산해 수렴 추이를 추적.
// 단조 증가 + 임계 이상이면 soft_consensus 후보로 판단한다.

export class ConvergenceDetector {
  private history: number[] = [];

  /**
   * 새 pair round 완성 시 호출.
   * actors: 활성 AI worker 이름 목록
   * allProposals: 해당 topic의 전체 proposal revision 목록 (누적)
   */
  addRound(actors: string[], allProposals: Revision[]): number {
    // 각 actor의 최근 3개 proposal 키워드 풀
    const pools = actors.map(actor => {
      const pool = new Set<string>();
      const actorProps = allProposals.filter(r => r.author === actor).slice(-3);
      for (const r of actorProps)
        for (const k of extractKeywordsNT(proposalText(r))) pool.add(k);
      return pool;
    });

    // 모든 actor 쌍의 Jaccard 평균
    let total = 0, pairs = 0;
    for (let i = 0; i < pools.length; i++) {
      for (let j = i + 1; j < pools.length; j++) {
        total += jaccardSets(pools[i], pools[j]);
        pairs++;
      }
    }
    const score = pairs > 0 ? total / pairs : 0;
    this.history.push(score);
    return score;
  }

  /**
   * soft_consensus 판단.
   * trendRounds 라운드 동안 단조 증가(±tolerance)하고 현재 점수 >= minScore이면 true.
   */
  isSoftConsensus(minScore = 0.32, trendRounds = 3, tolerance = 0.02): boolean {
    const recent = this.history.slice(-trendRounds);
    if (recent.length < trendRounds) return false;
    const isIncreasing = recent.every((v, i) => i === 0 || v >= recent[i - 1] - tolerance);
    return isIncreasing && recent[recent.length - 1] >= minScore;
  }

  getHistory(): readonly number[] { return this.history; }
  currentScore(): number { return this.history[this.history.length - 1] ?? 0; }

  reset(): void { this.history = []; }

  /** phase 전환 시 수렴 이력만 초기화. */
  resetHistory(): void { this.history = []; }
}
