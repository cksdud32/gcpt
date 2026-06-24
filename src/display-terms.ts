// UI 표시 용어 레이어 — 내부 타입 이름과 사용자 표시 문자열 분리
// 내부 코드는 영문 enum/type을 유지하고, UI 렌더링 시 이 파일의 값을 사용한다

export const DISPLAY = {
  // ─── 섹션 제목 ──────────────────────────────────────────────────
  section: {
    cognitive_framework:     "토론이 만들어낸 사고 구조",
    final_resolution:        "AI들이 도달한 최종 구조",
    question_evolution:      "질문이 어떻게 바뀌었나",
    branch_survival:         "살아남은 의견 흐름",
    convergence_freeze:      "논리 정체 감지",
    evolution_pressure:      "논리 진화 활성도",
    structural_map:          "AI들의 공통 사고 구조",
    repeated_frames:         "반복되는 생각 감지",
    concept_gravity:         "토론을 주도한 개념",
    convergence_flow:        "생각이 수렴된 흐름",
    meta_evolution:          "세그먼트 간 논점 변화",
  },

  // ─── 블록 레이블 (카드 내부 소제목) ─────────────────────────────
  block: {
    emergent_question:       "토론 중 새롭게 떠오른 질문",
    shared_structure:        "AI들이 공통으로 공유한 생각",
    evolution_trajectory:    "생각이 변해온 흐름",
    unresolved_tensions:     "끝까지 남은 의견 차이",
    reasoning_pattern:       "토론이 진행된 방식",
    core_principles:         "핵심 개념",
    structural_relations:    "개념 간 연결",
  },

  // ─── 설명 문구 (한 줄 설명) ─────────────────────────────────────
  desc: {
    cognitive_framework:     "토론 전체가 어떤 방향의 사고 체계를 만들었는지 보여줍니다.",
    final_resolution:        "승자 선택이 아니라, 논리 구조가 어디로 수렴했는지 분석합니다.",
    question_evolution:      "처음 던진 질문이 토론을 거치며 어떻게 변형됐는지 추적합니다.",
    branch_survival:         "어떤 의견 흐름이 끝까지 살아남았는지 보여줍니다.",
    convergence_freeze:      "새로운 논리 변화 없이 비슷한 의견이 반복되기 시작했습니다.",
    evolution_pressure:      "각 AI가 토론을 얼마나 발전시켰는지를 나타냅니다.",
    structural_map:          "표현은 달라도 같은 구조의 생각으로 수렴한 상태입니다.",
    repeated_frames:         "표현은 바뀌지만 의미가 반복되는 구간을 감지합니다.",
    emergent_question:       "토론이 진행되며 새롭게 부상한 핵심 질문입니다.",
    unresolved_tensions:     "합의에 이르지 못하고 끝까지 충돌이 남아있는 지점입니다.",
    reasoning_pattern:       "이번 토론이 어떤 방식으로 진행됐는지를 나타냅니다.",
  },

  // ─── 상태 뱃지 ──────────────────────────────────────────────────
  badge: {
    semantic_loop_detected:  "같은 의미 반복 감지",
    partial_repeat:          "일부 반복 감지",
    logic_stagnant:          "논리 정체",
    logic_active:            "논리 활성",
    dominant_branch:         "중심 의견 흐름",
    entropy_collapse:        "새 의견 소진",
    last_meaningful:         "마지막 새 논리",
    freeze_start:            "정체 시작",
    logic_diversity:         "논리 다양성",
    novelty_label:           "발언별 새 논거 비율",
    convergence_chart:       "AI 의견 유사도 변화",
    low_novelty_rounds:      "라운드 반복 발언",
    actor_contribution:      "AI별 진화 기여도",
    innovation_moment:       "새 논리 등장 순간",
    repeat_decay:            "반복 패턴",
  },

  // ─── 추론 패턴 레이블 ────────────────────────────────────────────
  reasoning_pattern: {
    conflict_resolution:     "서로 반박하며 합의 도달",
    system_balancing:        "여러 요소를 균형 잡아가며 결론 도달",
    incremental_refinement:  "조금씩 발전시켜 결론 정교화",
    dialectical_synthesis:   "서로 반박하며 새로운 결론 생성",
    recursive_adaptation:    "반복하며 스스로 조정",
  },

  // ─── 원리 역할 레이블 ────────────────────────────────────────────
  principle_role: {
    foundation: "기반 개념",
    driver:     "주도 개념",
    balancer:   "조율 개념",
    emergent:   "새로 생긴 개념",
    constraint: "제약 조건",
  },
} as const;
