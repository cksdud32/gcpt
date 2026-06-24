import { useState, useMemo } from "react";
import type { DiscussionAnalysis, SynthesizedConsensus, ConsensusSaturation, FinalConclusion, ArgumentNode, EvolutionPressureAnalysis, BranchSurvivalAnalysis, ConvergenceFreezeAnalysis, Topic, Revision, SegmentAnalysisView } from "../../../src/types";
import { buildSegmentViews } from "../../../src/analysis";
import { analyzeMetaEvolution } from "../../../src/meta-evolution";
import { DISPLAY } from "../../../src/display-terms";
import { MetaEvolutionView } from "./MetaEvolutionView";
import { StructuralAnalysisView } from "./StructuralAnalysisView";
import { ArgumentGraphView } from "./ArgumentGraphView";
import { QuestionEvolutionView } from "./QuestionEvolutionView";
import { FinalResolutionView } from "./FinalResolutionView";
import { CognitiveFrameworkView } from "./CognitiveFrameworkView";
import "./AnalysisModal.css";

const BASIS_LABELS: Record<SynthesizedConsensus["basis"], string> = {
  convergence:  "의미 수렴",
  late_concede: "논거 흡수",
  dominant:     "지배 프레임",
  fallback:     "약한 수렴",
};

const FC_SOURCE_LABELS: Record<FinalConclusion["source"], string> = {
  synthesized_consensus: "합성 결론",
  hybrid:                "진화 결론",
  selected_option:       "채택 결론",
  surviving_branch:      "살아남은 흐름 결론",
  structural_consensus:  "공통 구조 결론",
};

const FC_SOURCE_CLASS: Record<FinalConclusion["source"], string> = {
  synthesized_consensus: "am-fc-synthesis",
  hybrid:                "am-fc-hybrid",
  selected_option:       "am-fc-selected",
  surviving_branch:      "am-fc-branch",
  structural_consensus:  "am-fc-structural",
};

interface Props {
  goal:     string;
  analysis: DiscussionAnalysis;
  topic:    Topic;
  history?: Revision[];
  onClose:  () => void;
}

const OUTCOME_LABEL: Record<DiscussionAnalysis["outcome"], string> = {
  decided:  "합의 완료",
  deadlock: "교착 상태",
  paused:   "토론 중단",
};
const OUTCOME_CLASS: Record<DiscussionAnalysis["outcome"], string> = {
  decided:  "outcome-decided",
  deadlock: "outcome-deadlock",
  paused:   "outcome-paused",
};

export function AnalysisModal({ goal, analysis, topic, history, onClose }: Props) {
  const [selectedTab, setSelectedTab] = useState<"full" | number>("full");
  const [fullAnalysisOpen, setFullAnalysisOpen] = useState(false);

  const segmentViews = useMemo(
    () => topic.segments && topic.segments.length >= 2
      ? buildSegmentViews(topic, history ?? [])
      : [],
    [topic, history],
  );

  const metaEvolution = useMemo(
    () => segmentViews.length >= 2
      ? analyzeMetaEvolution(topic, segmentViews)
      : null,
    [topic, segmentViews],
  );

  const activeSegView = selectedTab !== "full"
    ? segmentViews.find(v => v.segmentId === selectedTab)
    : undefined;

  const activeAnalysis = selectedTab === "full"
    ? analysis
    : (activeSegView?.analysis ?? analysis);

  const isFullTab = selectedTab === "full" && segmentViews.length >= 2;

  const headerAnalysis = isFullTab ? analysis : activeAnalysis;
  const {
    summary, outcome, finalConclusion,
    synthesizedConsensus: synthesis,
  } = headerAnalysis;

  return (
    <div className="am-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="am-modal" role="dialog" aria-modal="true">

        {/* 헤더 */}
        <div className="am-header">
          <div className="am-header-top">
            <span className={`am-outcome-badge ${OUTCOME_CLASS[outcome]}`}>
              {OUTCOME_LABEL[outcome]}
            </span>
            <button className="am-close" onClick={onClose} aria-label="닫기">✕</button>
          </div>
          <div className="am-goal">{goal}</div>
          {finalConclusion && finalConclusion.source !== "selected_option" ? (
            <div className="am-synthesis-header">
              <div className="am-synthesis-label">
                <span className={`am-synthesis-tag am-fc-tag-${finalConclusion.source === "synthesized_consensus" ? "synthesis" : finalConclusion.source === "surviving_branch" ? "branch" : finalConclusion.source === "structural_consensus" ? "structural" : "hybrid"}`}>
                  {FC_SOURCE_LABELS[finalConclusion.source]}
                </span>
                <span className="am-synthesis-conf">{Math.round(finalConclusion.confidence * 100)}%</span>
                {synthesis && <span className="am-synthesis-basis">{BASIS_LABELS[synthesis.basis]}</span>}
              </div>
              <div className="am-synthesis-text">{finalConclusion.text}</div>
              <div className="am-summary am-summary-secondary">{summary}</div>
            </div>
          ) : synthesis ? (
            <div className="am-synthesis-header">
              <div className="am-synthesis-label">
                <span className="am-synthesis-tag">합성 결론</span>
                <span className="am-synthesis-conf">{Math.round(synthesis.confidence * 100)}%</span>
                <span className="am-synthesis-basis">{BASIS_LABELS[synthesis.basis]}</span>
              </div>
              <div className="am-synthesis-text">{synthesis.text}</div>
              <div className="am-summary am-summary-secondary">{summary}</div>
            </div>
          ) : (
            <div className="am-summary">{summary}</div>
          )}
        </div>

        {/* 세그먼트 탭 */}
        {segmentViews.length >= 2 && (
          <div className="am-segment-tabs">
            {segmentViews.map(v => (
              <button
                key={v.segmentId}
                className={`am-segment-tab${selectedTab === v.segmentId ? " am-segment-tab-active" : ""}`}
                onClick={() => setSelectedTab(v.segmentId)}
              >
                구간 {v.segmentId}
              </button>
            ))}
            <button
              className={`am-segment-tab${selectedTab === "full" ? " am-segment-tab-active" : ""}`}
              onClick={() => setSelectedTab("full")}
            >
              전체 분석
            </button>
          </div>
        )}

        <div className="am-body">

          {/* 세그먼트 탭: 개입 배너 */}
          {activeSegView && activeSegView.interjectionMessage && (
            <div className="am-segment-interjection">
              <span className="am-segment-interjection-label">사용자 개입</span>
              <span className="am-segment-interjection-text">{activeSegView.interjectionMessage}</span>
            </div>
          )}

          {/* 통합 탭: 핵심 분석 → MetaEvolution → 고급 분석 collapse */}
          {isFullTab && metaEvolution && (
            <>
              {analysis.cognitiveFramework && (
                <CognitiveFrameworkView cf={analysis.cognitiveFramework} />
              )}
              {analysis.finalResolution && (
                <FinalResolutionView fr={analysis.finalResolution} />
              )}
              {analysis.questionEvolution && (
                <QuestionEvolutionView qe={analysis.questionEvolution} />
              )}
              <MetaEvolutionView meta={metaEvolution} />

              <div className="am-full-analysis-collapse">
                <button
                  className="am-collapse-toggle"
                  onClick={() => setFullAnalysisOpen(v => !v)}
                >
                  <span>{fullAnalysisOpen ? "▲" : "▼"}</span>
                  세부 분석 데이터 보기
                </button>
                {fullAnalysisOpen && <AnalysisBody analysis={analysis} />}
              </div>
            </>
          )}

          {/* 세그먼트 탭 또는 단일 세그먼트 */}
          {!isFullTab && <AnalysisBody analysis={activeAnalysis} />}

        </div>
      </div>
    </div>
  );
}

// ─── AnalysisBody ────────────────────────────────────────────────

function AnalysisBody({ analysis }: { analysis: DiscussionAnalysis }) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const {
    dominantStance, dominantReason,
    stanceChanges, repetitions, noveltyHighlights,
    progressDrivers, consensusReason, deadlockAnalysis,
    noveltyDecayRates, convergenceHistory, stagnationRounds,
    unresolvedConflicts, softConsensusNote,
    synthesizedConsensus: synthesis,
    saturation,
    finalConclusion,
    argumentGraph,
    argumentEvolution,
    evolutionPressure,
    branchSurvival,
    convergenceFreeze,
  } = analysis;

  return (
    <>
      {/* 토론이 만들어낸 사고 구조 */}
      {analysis.cognitiveFramework && (
        <CognitiveFrameworkView cf={analysis.cognitiveFramework} />
      )}

      {/* AI들이 도달한 최종 구조 */}
      {analysis.finalResolution && (
        <FinalResolutionView fr={analysis.finalResolution} />
      )}

      {/* 질문이 어떻게 바뀌었나 */}
      {analysis.questionEvolution && (
        <QuestionEvolutionView qe={analysis.questionEvolution} />
      )}

      {/* 생각이 수렴된 흐름 */}
      <ConvergenceFlowSection analysis={analysis} />

      {/* 논리 정체 감지 */}
      {convergenceFreeze && (
        <ConvergenceFreezeSection cf={convergenceFreeze} />
      )}

      {/* 살아남은 의견 흐름 */}
      {branchSurvival && branchSurvival.branches.length > 0 && (
        <BranchSurvivalSection bs={branchSurvival} />
      )}

      {/* 논리 진화 활성도 */}
      {evolutionPressure && (
        <EvolutionPressureSection ep={evolutionPressure} />
      )}

      {/* AI들의 공통/반복 구조 */}
      <StructuralAnalysisView analysis={analysis} />

      {/* ── 고급 분석 데이터 (기본 접힘) ───────────────────────── */}
      <div className="am-full-analysis-collapse">
        <button
          className="am-collapse-toggle"
          onClick={() => setAdvancedOpen(v => !v)}
        >
          <span>{advancedOpen ? "▲" : "▼"}</span>
          고급 분석 데이터 보기
        </button>

        {advancedOpen && (
          <>
            {/* 논리 진화 흐름 */}
            {argumentGraph && argumentEvolution && argumentGraph.nodes.length >= 2 && (
              <Section title="논리 진화 흐름" accent="convergence">
                <ArgumentGraphView graph={argumentGraph} evolution={argumentEvolution} />
              </Section>
            )}

            {/* 공유 개념 */}
            {synthesis && synthesis.sharedConcepts.length > 0 && (
              <Section title="공유 개념" accent="convergence">
                <div className="am-shared-concepts">
                  {synthesis.sharedConcepts.map((c, i) => (
                    <span
                      key={i}
                      className="am-concept-chip"
                      title={`도입: ${c.firstActor} · ${c.actors.join(", ")} 사용 · ${c.frequency}회`}
                    >
                      {c.keyword}
                    </span>
                  ))}
                </div>
                {synthesis.synthesisNote && (
                  <p className="am-text am-synthesis-note-body">{synthesis.synthesisNote}</p>
                )}
              </Section>
            )}

            {/* 흡수된 논거 */}
            {synthesis && synthesis.absorbedArguments.length > 0 && (
              <Section title="흡수된 논거">
                {synthesis.absorbedArguments.map((a, i) => (
                  <div key={i} className="am-absorbed-row">
                    <span className={`am-actor-chip actor-${a.from}`}>{a.from}</span>
                    <span className="am-absorbed-arrow">→ 흡수</span>
                    <span className={`am-actor-chip actor-${a.by}`}>{a.by}</span>
                    <span className="am-absorbed-concept">'{a.concept}'</span>
                  </div>
                ))}
              </Section>
            )}

            {/* 미해결 키워드 */}
            {synthesis && synthesis.unresolvedKeywords.length > 0 && (
              <Section title="합의되지 않은 키워드" accent="deadlock">
                <div className="am-shared-concepts">
                  {synthesis.unresolvedKeywords.map((kwd, i) => (
                    <span key={i} className="am-unresolved-chip">{kwd}</span>
                  ))}
                </div>
              </Section>
            )}

            {/* 최종 결론 결정 방식 */}
            {finalConclusion && (
              <Section title="결론이 만들어진 방식">
                <FinalConclusionView fc={finalConclusion} synthesis={synthesis} />
              </Section>
            )}

            {/* 수렴 포화 */}
            {saturation && (
              <Section title="의견 반복 포화 감지" accent={saturation.saturated ? "saturation" : undefined}>
                <SaturationView saturation={saturation} noveltyDecayRates={noveltyDecayRates} />
              </Section>
            )}

            {/* 합성 품질 */}
            {synthesis?.synthesisQualityScore !== undefined && (
              <Section title="합성 품질 지표" accent="convergence">
                <div className="am-quality-row">
                  <div className="am-quality-bar-track">
                    <div
                      className="am-quality-bar-fill"
                      style={{ width: `${Math.round(synthesis.synthesisQualityScore * 100)}%` }}
                    />
                  </div>
                  <span className="am-quality-score">
                    {Math.round(synthesis.synthesisQualityScore * 100)}%
                  </span>
                </div>
              </Section>
            )}

            {/* 최종 우세 입장 */}
            <Section title="최종 우세 입장">
              <div className="am-dominant">
                <span className="am-dominant-value">{dominantStance}</span>
                {dominantReason && (
                  <p className="am-dominant-reason">{dominantReason}</p>
                )}
              </div>
            </Section>

            {/* 합의 이유 */}
            {consensusReason && (
              <Section title="합의 이유">
                <p className="am-text">{consensusReason}</p>
              </Section>
            )}

            {/* 교착 분석 */}
            {deadlockAnalysis && (
              <Section title="의견 충돌 분석" accent="deadlock">
                <div className="am-deadlock">
                  <div className="am-deadlock-positions">
                    {deadlockAnalysis.actorPositions.map(pos => (
                      <div key={pos.actor} className="am-deadlock-actor">
                        <span className={`am-actor-chip actor-${pos.actor}`}>{pos.actor}</span>
                        <div className="am-deadlock-actor-content">
                          <strong>{pos.corePosition}</strong>
                          <p className="am-deadlock-premise">전제: {pos.premise}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="am-deadlock-conflict">
                    <span className="am-label">핵심 충돌</span>
                    <span>{deadlockAnalysis.conflictPoint}</span>
                  </div>
                  <div className="am-deadlock-why">
                    <span className="am-label">합의 실패 원인</span>
                    <p>{deadlockAnalysis.whyNoConsensus}</p>
                  </div>
                </div>
              </Section>
            )}

            {/* 입장 변화 */}
            {stanceChanges.length > 0 && (
              <Section title="입장 변화">
                {stanceChanges.map(sc => (
                  <div key={sc.actor} className="am-stance-row">
                    <span className={`am-actor-chip actor-${sc.actor}`}>{sc.actor}</span>
                    <div className="am-stance-trail">
                      {sc.trail.map((v, i) => (
                        <span key={i}>
                          {i > 0 && <span className="am-arrow">→</span>}
                          <span className="am-stance-val">{v}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </Section>
            )}

            {/* 토론 진전 기여 */}
            {progressDrivers.length > 0 && (
              <Section title="토론 진전 기여">
                {progressDrivers.map((d, i) => (
                  <div key={d.actor} className="am-driver-row">
                    <span className="am-driver-rank">#{i + 1}</span>
                    <span className={`am-actor-chip actor-${d.actor}`}>{d.actor}</span>
                    <div className="am-driver-highlights">
                      {d.highlights.map((h, j) => (
                        <span key={j} className="am-driver-tag">{h}</span>
                      ))}
                    </div>
                  </div>
                ))}
              </Section>
            )}

            {/* 신규 논거 발언 */}
            {noveltyHighlights.length > 0 && (
              <Section title="새로운 논거 등장">
                {noveltyHighlights.map((n, i) => (
                  <div key={i} className="am-novelty-row">
                    <span className={`am-actor-chip actor-${n.actor}`}>{n.actor}</span>
                    <div>
                      <strong>{n.value}</strong>
                      <p className="am-novelty-rationale">{n.rationale}</p>
                    </div>
                  </div>
                ))}
              </Section>
            )}

            {/* 반복 패턴 */}
            {repetitions.length > 0 && (
              <Section title="반복된 주장">
                {repetitions.map((r, i) => (
                  <div key={i} className="am-rep-row">
                    <span className={`am-actor-chip actor-${r.actor}`}>{r.actor}</span>
                    <span className="am-rep-value">'{r.value}'</span>
                    <span className="am-rep-count">{r.count}회 반복</span>
                  </div>
                ))}
              </Section>
            )}

            {/* 의미 수렴 감지 */}
            {softConsensusNote && (
              <Section title="의미 수렴 감지" accent="convergence">
                <p className="am-text">{softConsensusNote}</p>
              </Section>
            )}

            {/* 발언별 새 논거 비율 */}
            {noveltyDecayRates && noveltyDecayRates.length > 0 && (
              <Section title="발언별 새 논거 비율">
                <div className="am-novelty-chart">
                  {noveltyDecayRates.map((rate, i) => (
                    <div key={i} className="am-novelty-bar-wrap">
                      <div
                        className={`am-novelty-bar${rate <= 0.08 ? " am-novelty-bar-low" : ""}`}
                        style={{ height: `${Math.max(4, Math.round(rate * 100))}px` }}
                        title={`R${i + 1}: ${(rate * 100).toFixed(0)}%`}
                      />
                      <span className="am-novelty-bar-label">R{i + 1}</span>
                    </div>
                  ))}
                  {stagnationRounds > 0 && (
                    <span className="am-novelty-stagnation">
                      마지막 {stagnationRounds}라운드 반복 발언
                    </span>
                  )}
                </div>
              </Section>
            )}

            {/* AI 의견 유사도 변화 */}
            {convergenceHistory && convergenceHistory.length > 1 && (
              <Section title="AI 의견 유사도 변화">
                <div className="am-convergence-chart">
                  {convergenceHistory.map((score, i) => (
                    <div key={i} className="am-conv-bar-wrap">
                      <div
                        className={`am-conv-bar${score >= 0.32 ? " am-conv-bar-high" : ""}`}
                        style={{ height: `${Math.max(4, Math.round(score * 120))}px` }}
                        title={`R${i + 1}: ${(score * 100).toFixed(0)}%`}
                      />
                      <span className="am-novelty-bar-label">R{i + 1}</span>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* 미해결 충돌 축 */}
            {unresolvedConflicts && unresolvedConflicts.length > 0 && (
              <Section title="합의되지 않은 충돌" accent="deadlock">
                {unresolvedConflicts.map((c, i) => (
                  <div key={i} className="am-conflict-row">
                    <div className="am-conflict-dim">주제: {c.dimension}</div>
                    {c.positions.map(pos => (
                      <div key={pos.actor} className="am-conflict-pos">
                        <span className={`am-actor-chip actor-${pos.actor}`}>{pos.actor}</span>
                        <span className="am-conflict-stance">{pos.stance}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </Section>
            )}
          </>
        )}
      </div>
    </>
  );
}

// ─── 하위 섹션 컴포넌트들 ─────────────────────────────────────────

const FREEZE_TYPE_LABELS: Record<string, string> = {
  discussion_exhausted: "논의 소진",
  semantic_convergence: "의미 수렴",
  branch_frozen:        "의견 흐름 정체",
};

function ConvergenceFreezeSection({ cf }: { cf: ConvergenceFreezeAnalysis }) {
  const scores    = cf.noveltyScores;
  const maxNovelty = Math.max(...scores.map(s => s.novelty), 0.01);

  return (
    <Section title={DISPLAY.section.convergence_freeze} accent="convergence">
      <div className="am-cf-header">
        {cf.frozen ? (
          <>
            <span className={`am-cf-freeze-badge am-cf-frozen`}>
              {FREEZE_TYPE_LABELS[cf.freezeType ?? ""] ?? cf.freezeType}
            </span>
            {cf.frozenAtRevisionId !== undefined && (
              <span className="am-cf-frozen-at">발언 #{cf.frozenAtRevisionId}부터 정체</span>
            )}
          </>
        ) : (
          <span className="am-cf-freeze-badge am-cf-active">논리 진화 중</span>
        )}
        <span className="am-cf-entropy">
          논리 다양성 {(cf.argumentEntropy * 100).toFixed(0)}%
          <span className={`am-cf-entropy-bar-inline`} style={{ width: `${cf.argumentEntropy * 60}px` }} />
        </span>
      </div>

      {cf.convergenceMoment && (
        <div className="am-cf-moment">{cf.convergenceMoment}</div>
      )}

      {scores.length > 0 && (
        <div className="am-cf-novelty-section">
          <div className="am-cf-sub-label">{DISPLAY.badge.novelty_label}</div>
          <div className="am-cf-graph">
            {scores.map((s, i) => {
              const pct = (s.novelty / maxNovelty) * 100;
              const isMeaningful = s.revisionId === cf.lastMeaningfulRevisionId;
              const isFreeze     = s.revisionId === cf.frozenAtRevisionId;
              const isCollapse   = s.revisionId === cf.entropyCollapseRevisionId;
              return (
                <div key={s.revisionId} className="am-cf-bar-col" title={`#${s.revisionId}: 새 논거 ${(s.novelty * 100).toFixed(0)}%`}>
                  <div className="am-cf-bar-track">
                    <div
                      className={`am-cf-bar-fill ${s.novelty <= 0.05 ? "am-cf-bar-zero" : s.novelty <= 0.10 ? "am-cf-bar-low" : "am-cf-bar-ok"}`}
                      style={{ height: `${Math.max(2, pct)}%` }}
                    />
                  </div>
                  <div className={`am-cf-bar-label ${isMeaningful ? "am-cf-label-meaningful" : isFreeze ? "am-cf-label-freeze" : isCollapse ? "am-cf-label-collapse" : ""}`}>
                    {isMeaningful ? "★" : isFreeze ? "↓" : isCollapse ? "⊗" : (i + 1).toString()}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="am-cf-graph-legend">
            <span className="am-cf-leg am-cf-leg-meaningful">★ 마지막 새 논리</span>
            <span className="am-cf-leg am-cf-leg-freeze">↓ 정체 시작</span>
            <span className="am-cf-leg am-cf-leg-collapse">⊗ 새 의견 소진</span>
          </div>
        </div>
      )}

      <div className="am-cf-stats">
        <div className="am-cf-stat-item">
          <span className="am-cf-stat-label">논리 다양성</span>
          <div className="am-cf-stat-bar-track">
            <div
              className={`am-cf-stat-bar-fill ${cf.argumentEntropy < 0.35 ? "am-cf-ent-low" : cf.argumentEntropy < 0.6 ? "am-cf-ent-mid" : "am-cf-ent-high"}`}
              style={{ width: `${cf.argumentEntropy * 100}%` }}
            />
          </div>
          <span className="am-cf-stat-val">{(cf.argumentEntropy * 100).toFixed(0)}%</span>
        </div>
        {cf.lastMeaningfulRevisionId !== undefined && (
          <div className="am-cf-last-meaningful">
            <span className="am-cf-stat-label">마지막 새 논리</span>
            <span className="am-cf-rev-id">발언 #{cf.lastMeaningfulRevisionId}</span>
          </div>
        )}
      </div>
    </Section>
  );
}

function BranchSurvivalSection({ bs }: { bs: BranchSurvivalAnalysis }) {
  return (
    <Section title={DISPLAY.section.branch_survival} accent="convergence">
      <div className="am-bs-summary">{bs.branchEvolutionSummary}</div>
      {bs.branches.map(branch => (
        <div key={branch.id} className={`am-bs-branch ${branch.dominant ? "am-bs-dominant" : ""}`}>
          <div className="am-bs-branch-header">
            {branch.dominant && <span className="am-bs-dominant-badge">{DISPLAY.badge.dominant_branch}</span>}
            <span className="am-bs-actors">
              {branch.actors.filter(a => a !== "system" && a !== "user").map(a => (
                <span key={a} className={`am-actor-chip actor-${a}`}>{a}</span>
              ))}
            </span>
            <span className="am-bs-survival-score">
              생존점수 {Math.round(branch.survivalScore * 100)}%
            </span>
          </div>
          <div className="am-bs-stats">
            <span className="am-bs-stat">수렴 {Math.round(branch.convergenceScore * 100)}%</span>
            <span className="am-bs-stat">수용 {branch.concedeDepth}회</span>
            <span className="am-bs-stat">발전 {branch.refineDepth}회</span>
            <span className={`am-bs-stat ${branch.repeatedDefenseRatio > 0.5 ? "am-bs-stat-warn" : ""}`}>
              방어 {Math.round(branch.repeatedDefenseRatio * 100)}%
            </span>
          </div>
          {branch.sharedConcepts.length > 0 && (
            <div className="am-bs-concepts">
              {branch.sharedConcepts.slice(0, 6).map(k => (
                <span key={k} className="am-bs-concept-chip">{k}</span>
              ))}
            </div>
          )}
          {branch.dominant && branch.finalProposalValue && (
            <div className="am-bs-final-value">
              <span className="am-bs-final-label">최종 도달 논리</span>
              <span className="am-bs-final-text">{branch.finalProposalValue.slice(0, 150)}</span>
            </div>
          )}
        </div>
      ))}
    </Section>
  );
}

function EvolutionPressureSection({ ep }: { ep: EvolutionPressureAnalysis }) {
  const stag = Math.round(ep.stagnationLevel * 100);
  const topMomentum = ep.actorMomentum.slice(0, 3);

  return (
    <Section title={DISPLAY.section.evolution_pressure} accent="convergence">
      <div className="am-ep-root">

        <div className="am-ep-stagnation">
          <div className="am-ep-stag-row">
            <span className="am-ep-stag-label">반복 정체 비율</span>
            <span className={`am-ep-stag-val ${stag >= 40 ? "am-ep-stag-high" : stag >= 20 ? "am-ep-stag-mid" : "am-ep-stag-low"}`}>
              {stag}%
            </span>
          </div>
          <div className="am-ep-stag-track">
            <div
              className={`am-ep-stag-fill ${stag >= 40 ? "am-ep-stag-fill-high" : stag >= 20 ? "am-ep-stag-fill-mid" : "am-ep-stag-fill-low"}`}
              style={{ width: `${Math.min(100, stag)}%` }}
            />
          </div>
          {ep.semanticDecayActors.length > 0 && (
            <div className="am-ep-decay-actors">
              {ep.semanticDecayActors.map(a => (
                <span key={a} className={`am-actor-chip actor-${a} am-ep-decay-chip`}>{a} ↓{DISPLAY.badge.repeat_decay}</span>
              ))}
            </div>
          )}
        </div>

        {topMomentum.length > 0 && (
          <div className="am-ep-momentum">
            <div className="am-ep-sub-label">{DISPLAY.badge.actor_contribution}</div>
            {topMomentum.map(m => (
              <div key={m.actor} className="am-ep-momentum-row">
                <span className={`am-actor-chip actor-${m.actor}`}>{m.actor}</span>
                <div className="am-ep-momentum-bar-track">
                  <div
                    className="am-ep-momentum-bar-fill"
                    style={{ width: `${Math.min(100, Math.round(m.score * 80))}%` }}
                  />
                </div>
                <span className="am-ep-momentum-score">{m.score.toFixed(2)}</span>
                {m.events.length > 0 && (
                  <span className="am-ep-momentum-event">{m.events[0]}</span>
                )}
              </div>
            ))}
          </div>
        )}

        {ep.innovationMoments.length > 0 && (
          <div className="am-ep-innovations">
            <div className="am-ep-sub-label">{DISPLAY.badge.innovation_moment}</div>
            {ep.innovationMoments.slice(0, 4).map(im => (
              <div key={im.revisionId} className="am-ep-innov-row">
                <span className="am-ep-innov-rev">#{im.revisionId}</span>
                <span className={`am-actor-chip actor-${im.actor}`}>{im.actor}</span>
                <span className="am-ep-innov-desc">{im.description}</span>
                <span className="am-ep-innov-score">+{im.score}</span>
              </div>
            ))}
          </div>
        )}

      </div>
    </Section>
  );
}

function ConvergenceFlowSection({ analysis }: { analysis: DiscussionAnalysis }) {
  const { stanceChanges, argumentEvolution, finalConclusion, synthesizedConsensus: synthesis } = analysis;

  const finalText = finalConclusion && finalConclusion.source !== "selected_option"
    ? finalConclusion.text
    : synthesis?.text;

  if (!finalText) return null;

  const shifted = stanceChanges.filter(sc => sc.shifts.length > 0);
  const initialPositions = shifted.map(sc => ({ actor: sc.actor, text: sc.trail[0] ?? sc.current }));
  const chain: ArgumentNode[] = argumentEvolution?.dominantChain.slice(0, 4) ?? [];

  if (initialPositions.length < 2 && chain.length < 3) return null;

  return (
    <Section title={DISPLAY.section.convergence_flow} accent="convergence">
      <div className="am-cf-flow">
        {initialPositions.length >= 2 && (
          <div className="am-cf-phase">
            <div className="am-cf-phase-label">초기 입장</div>
            {initialPositions.map((pos, i) => (
              <div key={i} className="am-cf-item">
                <span className={`am-actor-chip actor-${pos.actor}`}>{pos.actor}</span>
                <span className="am-cf-text">
                  {pos.text.length > 60 ? pos.text.slice(0, 57) + "…" : pos.text}
                </span>
              </div>
            ))}
          </div>
        )}

        {chain.length >= 3 && (
          <>
            <div className="am-cf-arrow">↓ 논리 진화</div>
            <div className="am-cf-phase">
              <div className="am-cf-phase-label">생각이 발전하는 과정</div>
              {chain.map(node => (
                <div key={node.id} className="am-cf-item">
                  <span className={`am-actor-chip actor-${node.actor}`}>{node.actor}</span>
                  {node.stanceAction && node.stanceAction !== "propose" && (
                    <span className={`am-cf-stance am-cf-stance-${node.stanceAction}`}>
                      {node.stanceAction === "refine" ? "발전" :
                       node.stanceAction === "concede" ? "수용" :
                       node.stanceAction === "defend"  ? "방어" : node.stanceAction}
                    </span>
                  )}
                  <span className="am-cf-text">
                    {node.text.length > 55 ? node.text.slice(0, 52) + "…" : node.text}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="am-cf-arrow">↓ 최종 수렴</div>
        <div className="am-cf-phase am-cf-phase-final">
          <div className="am-cf-phase-label">최종 수렴</div>
          <div className="am-cf-final-text">{finalText}</div>
        </div>
      </div>
    </Section>
  );
}

function Section({ title, accent, children }: {
  title: string;
  accent?: "deadlock" | "convergence" | "saturation";
  children: React.ReactNode;
}) {
  return (
    <div className={`am-section${accent ? ` am-section-${accent}` : ""}`}>
      <div className="am-section-title">{title}</div>
      <div className="am-section-body">{children}</div>
    </div>
  );
}

function FinalConclusionView({ fc, synthesis }: {
  fc:         FinalConclusion;
  synthesis?: SynthesizedConsensus | null;
}) {
  return (
    <div className="am-fc">
      <div className="am-fc-meta">
        <span className={`am-fc-source-badge ${FC_SOURCE_CLASS[fc.source]}`}>
          {FC_SOURCE_LABELS[fc.source]}
        </span>
        <span className="am-fc-conf">신뢰도 {Math.round(fc.confidence * 100)}%</span>
      </div>

      <p className="am-text am-fc-reason">{fc.reason}</p>

      {fc.basedOnRevisionIds.length > 0 && (
        <div className="am-fc-revids">
          <span className="am-label">기반 발언</span>
          <div className="am-fc-revid-chips">
            {fc.basedOnRevisionIds.map(id => (
              <span key={id} className="am-fc-revid-chip">#{id}</span>
            ))}
          </div>
        </div>
      )}

      {fc.source !== "selected_option" && synthesis && (
        <div className="am-fc-vs">
          <span className="am-label">채택 의견과의 차이</span>
          <p className="am-text am-fc-vs-text">
            {synthesis.synthesisNote}
          </p>
        </div>
      )}
    </div>
  );
}

function SaturationView({ saturation, noveltyDecayRates }: {
  saturation: ConsensusSaturation;
  noveltyDecayRates?: number[];
}) {
  const recent5Avg = noveltyDecayRates && noveltyDecayRates.length > 0
    ? noveltyDecayRates.slice(-5).reduce((s, r) => s + r, 0) / Math.min(5, noveltyDecayRates.length)
    : null;

  return (
    <div className="am-saturation">
      <div className="am-saturation-meta">
        <span className={`am-saturation-badge ${saturation.saturated ? "am-sat-active" : "am-sat-inactive"}`}>
          {saturation.saturated ? "의견 반복 포화 감지됨" : "반복 포화 없음"}
        </span>
        <span className="am-saturation-conf">신뢰도 {Math.round(saturation.confidence * 100)}%</span>
      </div>
      <p className="am-text am-saturation-reason">{saturation.reason}</p>

      {recent5Avg !== null && (
        <div className="am-saturation-stat">
          <span className="am-label">최근 5라운드 평균 새 논거</span>
          <span className={`am-saturation-novelty ${recent5Avg <= 0.15 ? "am-sat-low" : ""}`}>
            {(recent5Avg * 100).toFixed(0)}%
          </span>
        </div>
      )}

      {saturation.repetitionClusters.length > 0 && (
        <div className="am-saturation-clusters">
          <div className="am-label" style={{ marginBottom: 6 }}>반복된 의미 묶음</div>
          {saturation.repetitionClusters.map((cl, i) => (
            <div key={i} className="am-cluster-row">
              <span className="am-cluster-count">{cl.count}회</span>
              <span className="am-cluster-canonical">
                '{cl.canonical.length > 55 ? cl.canonical.slice(0, 52) + "…" : cl.canonical}'
              </span>
              <span className="am-cluster-actors">{cl.actors.join(", ")}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
