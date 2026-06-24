import type { QuestionEvolutionAnalysis, TopicDriftType } from "../../../src/types";
import { DISPLAY } from "../../../src/display-terms";
import "./QuestionEvolutionView.css";

const DRIFT_BADGE_CLASS: Record<TopicDriftType, string> = {
  stable_topic:      "qev-badge-stable",
  reframed_topic:    "qev-badge-reframed",
  shifted_topic:     "qev-badge-shifted",
  transformed_topic: "qev-badge-transformed",
};

const CONNECTOR_LABEL: Record<string, string> = {
  initial_middle:   "논점 재구성",
  middle_emergent:  "질문 진화",
  initial_emergent: "질문 진화",
};

const STAGE_LABEL: Record<string, string> = {
  initial:  "처음",
  middle:   "중간",
  emergent: "최종",
};

interface Props {
  qe: QuestionEvolutionAnalysis;
}

export function QuestionEvolutionView({ qe }: Props) {
  const {
    driftType,
    driftPercent,
    sharedConceptOverlap,
    newlyDominantConcepts,
    vanishedConcepts,
    evolutionPath,
    lockedActors,
    dominantRedirectActor,
    transformationStage,
  } = qe;

  const actorSet = new Set<string>([
    ...lockedActors.map(a => a.actor),
    ...(dominantRedirectActor ? [dominantRedirectActor] : []),
  ]);

  return (
    <div className="qev-root">

      {/* 헤더 */}
      <div className="qev-header">
        <span className="qev-title">{DISPLAY.section.question_evolution}</span>
        <span className={`qev-drift-badge ${DRIFT_BADGE_CLASS[driftType]}`}>
          {transformationStage}
        </span>
        <div className="qev-stats">
          <span className="qev-stat">
            논점 이동 <span className="qev-stat-val">{driftPercent}%</span>
          </span>
          <span className="qev-stat">
            개념 유지 <span className="qev-stat-val">{sharedConceptOverlap}%</span>
          </span>
        </div>
      </div>

      {/* 섹션 설명 */}
      <div className="qev-section-desc">{DISPLAY.desc.question_evolution}</div>

      {/* 질문 변화 경로 */}
      <div className="qev-path">
        {evolutionPath.map((step, idx) => (
          <div key={step.stage}>
            {idx > 0 && (
              <div className="qev-connector">
                <span>↓</span>
                <span className="qev-connector-label">
                  {CONNECTOR_LABEL[`${evolutionPath[idx - 1].stage}_${step.stage}`] ?? ""}
                </span>
                {step.driftFromPrev !== undefined && step.driftFromPrev > 0 && (
                  <span className="qev-step-drift">+{step.driftFromPrev}%</span>
                )}
              </div>
            )}

            <div className="qev-step">
              <div className="qev-step-header">
                <span className={`qev-step-label label-${step.stage}`}>
                  {STAGE_LABEL[step.stage]}
                </span>
                <span className={`qev-step-question q-${step.stage}`}>
                  {step.questionText}
                </span>
              </div>
              {step.keywords.length > 0 && (
                <div className={`qev-step-keywords kw-${step.stage}`}>
                  {step.keywords.map(k => (
                    <span key={k} className="qev-kw">{k}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 신규 / 소멸 개념 */}
      {(newlyDominantConcepts.length > 0 || vanishedConcepts.length > 0) && (
        <div className="qev-concepts">
          {newlyDominantConcepts.length > 0 && (
            <div className="qev-concept-col">
              <span className="qev-concept-label label-new">새로 부상한 개념</span>
              <div className="qev-concept-chips">
                {newlyDominantConcepts.map(k => (
                  <span key={k} className="qev-concept-chip chip-new">{k}</span>
                ))}
              </div>
            </div>
          )}
          {vanishedConcepts.length > 0 && (
            <div className="qev-concept-col">
              <span className="qev-concept-label label-vanish">사라진 개념</span>
              <div className="qev-concept-chips">
                {vanishedConcepts.map(k => (
                  <span key={k} className="qev-concept-chip chip-vanish">{k}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Actor 기여 */}
      {actorSet.size > 0 && (
        <div className="qev-actors">
          {lockedActors.map(la => (
            <div key={la.actor} className="qev-actor-pill">
              <span className={`qev-actor-chip actor-${la.actor}`}>{la.actor}</span>
              <span className="qev-actor-label">질문 고수</span>
              <span className="qev-actor-val">{la.preserveRatio}%</span>
              <span className="qev-lock-badge">고수</span>
            </div>
          ))}
          {dominantRedirectActor &&
            !lockedActors.some(la => la.actor === dominantRedirectActor) && (
            <div className="qev-actor-pill">
              <span className={`qev-actor-chip actor-${dominantRedirectActor}`}>
                {dominantRedirectActor}
              </span>
              <span className="qev-actor-label">논점 전환 주도</span>
              <span className="qev-redirect-badge">전환 주도</span>
            </div>
          )}
        </div>
      )}

    </div>
  );
}
