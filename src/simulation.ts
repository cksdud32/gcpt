import { RevisionStore } from "./RevisionStore.js";
import * as fs from "fs";

const store = new RevisionStore();

// ─────────────────────────────────────────────
// 라운드 1: 데이터베이스 결정 (id 1~12)
// ─────────────────────────────────────────────

store.append("user", {
  type: "set_goal",
  payload: { type: "set_goal", goal: "데이터베이스 기술 스택 결정" },
  rationale: "프로젝트 초기 방향 설정",
});

const r2 = store.append("gpt", {
  type: "propose_decision",
  payload: { type: "propose_decision", value: "SQLite", reason: "경량, 무설정, 프로토타입 최적" },
  rationale: "초기 단계에서 복잡성 최소화",
});

const r3 = store.append("claude", {
  type: "propose_alternative",
  references: [r2.id],
  payload: { type: "propose_alternative", value: "PostgreSQL", reason: "확장성, 동시성, JSON 지원" },
  rationale: "SQLite 동시성 한계 — 멀티 유저 시나리오에서 병목 가능",
});

const r4 = store.append("gpt", {
  type: "propose_alternative",
  references: [r2.id, r3.id],
  payload: { type: "propose_alternative", value: "MySQL", reason: "팀 친숙도, 광범위한 호스팅 지원" },
  rationale: "PostgreSQL보다 운영 비용이 낮을 수 있음",
});

store.append("user", {
  type: "select_option",
  references: [r2.id],
  payload: { type: "select_option", selected: "SQLite" },
  rationale: "현재 규모에서는 단순성 우선",
});

// 재제안: 선택 이후에도 계속 이의 제기
const r6 = store.append("claude", {
  type: "propose_alternative",
  references: [r3.id, r4.id],
  payload: { type: "propose_alternative", value: "PostgreSQL", reason: "향후 마이그레이션 비용 고려" },
  rationale: "SQLite → PostgreSQL 마이그레이션은 스키마 변환 외 드라이버 교체 필요",
});

store.append("gpt", {
  type: "propose_alternative",
  references: [r6.id],
  payload: { type: "propose_alternative", value: "TiDB", reason: "MySQL 호환 + 수평 확장" },
  rationale: "마이그레이션 우려를 해결하면서 MySQL 친숙도 유지 가능",
});

store.append("user", {
  type: "user_override",
  payload: { type: "user_override", goal: "데이터베이스 기술 스택 결정 (확정: SQLite 사용)" },
  rationale: "프로토타입 단계에서 재논의 금지. SQLite로 확정.",
});

// ─────────────────────────────────────────────
// 라운드 2: 백엔드 프레임워크 결정 (id 9~22)
// ─────────────────────────────────────────────

store.append("user", {
  type: "set_goal",
  payload: { type: "set_goal", goal: "백엔드 프레임워크 선택" },
});

const r10 = store.append("gpt", {
  type: "propose_decision",
  payload: { type: "propose_decision", value: "Express.js", reason: "단순, 생태계 성숙, 팀 경험 있음" },
  rationale: "검증된 선택. 러닝커브 없음.",
});

const r11 = store.append("claude", {
  type: "propose_alternative",
  references: [r10.id],
  payload: { type: "propose_alternative", value: "Fastify", reason: "Express 대비 3배 처리량, 스키마 기반 검증" },
  rationale: "성능 민감한 엔드포인트가 있다면 Fastify가 유리",
});

const r12 = store.append("gpt", {
  type: "propose_alternative",
  references: [r10.id, r11.id],
  payload: { type: "propose_alternative", value: "NestJS", reason: "구조화, DI, 대형 팀에 적합" },
  rationale: "팀 규모 확장 시 유지보수성 우위",
});

store.append("claude", {
  type: "propose_alternative",
  references: [r11.id, r12.id],
  payload: { type: "propose_alternative", value: "Hono", reason: "엣지 런타임 지원, 초경량" },
  rationale: "Cloudflare Workers 배포 고려 시 유일한 선택지",
});

store.append("user", {
  type: "select_option",
  references: [r10.id],
  payload: { type: "select_option", selected: "Express.js" },
  rationale: "팀 경험 우선",
});

// ─────────────────────────────────────────────
// 라운드 3: 인증 방식 결정 (id 15~30)
// ─────────────────────────────────────────────

store.append("user", {
  type: "set_goal",
  payload: { type: "set_goal", goal: "사용자 인증 방식 결정" },
});

const r16 = store.append("gpt", {
  type: "propose_decision",
  payload: { type: "propose_decision", value: "JWT", reason: "무상태, 확장성, 표준화" },
  rationale: "서버 세션 불필요. 마이크로서비스 환경에서 유리.",
});

const r17 = store.append("claude", {
  type: "propose_alternative",
  references: [r16.id],
  payload: { type: "propose_alternative", value: "Session Cookie", reason: "무효화 용이, 보안 제어 강함" },
  rationale: "JWT는 토큰 무효화가 어렵다. 강제 로그아웃 시나리오에서 취약.",
});

const r18 = store.append("gpt", {
  type: "propose_alternative",
  references: [r16.id, r17.id],
  payload: { type: "propose_alternative", value: "OAuth2 + JWT", reason: "소셜 로그인, 표준 위임 인증" },
  rationale: "확장성과 소셜 연동 동시 해결",
});

store.append("claude", {
  type: "propose_alternative",
  references: [r17.id, r18.id],
  payload: { type: "propose_alternative", value: "Paseto", reason: "JWT보다 안전한 토큰 표준" },
  rationale: "JWT의 알고리즘 혼동 공격 취약점 회피 가능",
});

store.append("gpt", {
  type: "propose_alternative",
  references: [r18.id],
  payload: { type: "propose_alternative", value: "Auth0", reason: "관리형 인증, 빠른 구현" },
  rationale: "인증을 직접 구현하지 않으면 보안 리스크 감소",
});

store.append("user", {
  type: "select_option",
  references: [r16.id],
  payload: { type: "select_option", selected: "JWT" },
  rationale: "현재 단순 구조에서 충분. 나중에 교체 가능.",
});

// 사용자 마음 바꿈
store.append("user", {
  type: "user_override",
  payload: { type: "user_override", goal: "사용자 인증 방식 결정 (재검토)" },
  rationale: "보안팀 피드백: JWT 무효화 문제 재검토 필요",
});

store.append("user", {
  type: "select_option",
  references: [r17.id],
  payload: { type: "select_option", selected: "Session Cookie" },
  rationale: "보안팀 권고에 따라 Session Cookie로 변경",
});

// ─────────────────────────────────────────────
// 라운드 4: 배포 환경 결정 (id 24~40)
// ─────────────────────────────────────────────

store.append("user", {
  type: "set_goal",
  payload: { type: "set_goal", goal: "배포 환경 및 인프라 결정" },
});

const r25 = store.append("gpt", {
  type: "propose_decision",
  payload: { type: "propose_decision", value: "AWS EC2", reason: "유연성, 팀 경험, 광범위한 문서" },
  rationale: "가장 범용적인 선택",
});

const r26 = store.append("claude", {
  type: "propose_alternative",
  references: [r25.id],
  payload: { type: "propose_alternative", value: "Vercel + Railway", reason: "무설정 배포, 자동 스케일링" },
  rationale: "EC2는 DevOps 리소스 필요. 소규모 팀엔 과도할 수 있음.",
});

const r27 = store.append("gpt", {
  type: "propose_alternative",
  references: [r25.id, r26.id],
  payload: { type: "propose_alternative", value: "AWS ECS + Fargate", reason: "컨테이너 기반, 서버리스 운영" },
  rationale: "EC2 관리 부담 없이 AWS 생태계 유지",
});

store.append("claude", {
  type: "propose_alternative",
  references: [r26.id, r27.id],
  payload: { type: "propose_alternative", value: "Fly.io", reason: "글로벌 엣지, 간편한 배포" },
  rationale: "Vercel보다 백엔드 친화적. Railway보다 글로벌 분산 우수.",
});

store.append("gpt", {
  type: "propose_alternative",
  references: [r25.id],
  payload: { type: "propose_alternative", value: "GCP Cloud Run", reason: "서버리스 컨테이너, 사용량 기반 과금" },
  rationale: "트래픽 없을 때 비용 0원",
});

store.append("user", {
  type: "select_option",
  references: [r26.id],
  payload: { type: "select_option", selected: "Vercel + Railway" },
  rationale: "팀 규모와 속도 고려",
});

// ─────────────────────────────────────────────
// 라운드 5: 상태 관리 결정 (id 31~45)
// ─────────────────────────────────────────────

store.append("user", {
  type: "set_goal",
  payload: { type: "set_goal", goal: "프론트엔드 상태 관리 라이브러리 선택" },
});

const r32 = store.append("gpt", {
  type: "propose_decision",
  payload: { type: "propose_decision", value: "Redux Toolkit", reason: "표준화, 예측 가능한 상태 흐름" },
  rationale: "대형 앱에서 검증된 패턴",
});

const r33 = store.append("claude", {
  type: "propose_alternative",
  references: [r32.id],
  payload: { type: "propose_alternative", value: "Zustand", reason: "보일러플레이트 없음, 단순 API" },
  rationale: "Redux는 현재 앱 규모에 과도할 수 있음",
});

const r34 = store.append("gpt", {
  type: "propose_alternative",
  references: [r33.id],
  payload: { type: "propose_alternative", value: "Jotai", reason: "원자 단위 상태, React 18 최적화" },
  rationale: "Zustand보다 더 세밀한 리렌더링 제어",
});

store.append("claude", {
  type: "propose_alternative",
  references: [r32.id, r33.id, r34.id],
  payload: { type: "propose_alternative", value: "TanStack Query + Context", reason: "서버 상태와 클라이언트 상태 분리" },
  rationale: "대부분의 '상태' 문제는 서버 상태임. 전용 라이브러리가 적합.",
});

store.append("user", {
  type: "select_option",
  references: [r33.id],
  payload: { type: "select_option", selected: "Zustand" },
  rationale: "단순성 우선",
});

// ─────────────────────────────────────────────
// 라운드 6: 테스트 전략 (id 37~52)
// ─────────────────────────────────────────────

store.append("user", {
  type: "set_goal",
  payload: { type: "set_goal", goal: "테스트 전략 수립" },
});

const r38 = store.append("gpt", {
  type: "propose_decision",
  payload: { type: "propose_decision", value: "Jest + RTL", reason: "표준, 광범위한 생태계" },
  rationale: "React 프로젝트 de facto",
});

const r39 = store.append("claude", {
  type: "propose_alternative",
  references: [r38.id],
  payload: { type: "propose_alternative", value: "Vitest + RTL", reason: "Vite 네이티브, Jest보다 빠름" },
  rationale: "Vite 기반 프로젝트면 Vitest가 설정 없이 동작",
});

store.append("gpt", {
  type: "propose_alternative",
  references: [r38.id, r39.id],
  payload: { type: "propose_alternative", value: "Playwright", reason: "E2E 브라우저 테스트" },
  rationale: "단위 테스트만으로는 UI 플로우 검증 불가",
});

store.append("claude", {
  type: "propose_alternative",
  references: [r39.id],
  payload: { type: "propose_alternative", value: "Vitest + Playwright", reason: "단위 + E2E 조합" },
  rationale: "두 레이어 커버리지",
});

store.append("user", {
  type: "select_option",
  references: [r39.id],
  payload: { type: "select_option", selected: "Vitest + RTL" },
  rationale: "Vite 사용 중이므로 자연스러운 선택",
});

// ─────────────────────────────────────────────
// 라운드 7: CI/CD (id 43~57)
// ─────────────────────────────────────────────

store.append("user", {
  type: "set_goal",
  payload: { type: "set_goal", goal: "CI/CD 파이프라인 선택" },
});

const r44 = store.append("gpt", {
  type: "propose_decision",
  payload: { type: "propose_decision", value: "GitHub Actions", reason: "GitHub 네이티브, 무료 티어 충분" },
  rationale: "별도 서비스 없이 코드와 파이프라인 동일 위치",
});

const r45 = store.append("claude", {
  type: "propose_alternative",
  references: [r44.id],
  payload: { type: "propose_alternative", value: "CircleCI", reason: "캐싱 성능, 복잡한 워크플로우" },
  rationale: "빌드 시간 민감한 경우 CircleCI가 빠를 수 있음",
});

store.append("gpt", {
  type: "propose_alternative",
  references: [r44.id, r45.id],
  payload: { type: "propose_alternative", value: "Turborepo + GitHub Actions", reason: "모노레포 캐싱 최적화" },
  rationale: "모노레포 구조라면 Turborepo 캐싱이 빌드 시간 대폭 단축",
});

store.append("user", {
  type: "select_option",
  references: [r44.id],
  payload: { type: "select_option", selected: "GitHub Actions" },
  rationale: "현재 규모에서 충분",
});

// ─────────────────────────────────────────────
// 라운드 8: 모니터링 (id 48~60)
// ─────────────────────────────────────────────

store.append("user", {
  type: "set_goal",
  payload: { type: "set_goal", goal: "모니터링 및 에러 트래킹 도구 선택" },
});

const r49 = store.append("gpt", {
  type: "propose_decision",
  payload: { type: "propose_decision", value: "Sentry", reason: "에러 트래킹 표준, 무료 티어" },
  rationale: "운영 초기 필수 도구",
});

const r50 = store.append("claude", {
  type: "propose_alternative",
  references: [r49.id],
  payload: { type: "propose_alternative", value: "Datadog", reason: "APM + 로그 + 메트릭 통합" },
  rationale: "Sentry는 에러만. 성능 병목 분석엔 APM 필요.",
});

store.append("gpt", {
  type: "propose_alternative",
  references: [r49.id, r50.id],
  payload: { type: "propose_alternative", value: "Grafana + Prometheus", reason: "오픈소스, 자체 호스팅" },
  rationale: "비용 제어 가능. 단 운영 부담 있음.",
});

store.append("claude", {
  type: "propose_alternative",
  references: [r50.id],
  payload: { type: "propose_alternative", value: "Axiom", reason: "저렴한 로그 분석, 개발자 친화적 UI" },
  rationale: "Datadog 대비 10분의 1 비용으로 유사한 로그 분석 가능",
});

store.append("user", {
  type: "select_option",
  references: [r49.id],
  payload: { type: "select_option", selected: "Sentry" },
  rationale: "모니터링보다 에러 트래킹이 현재 우선",
});

// ─────────────────────────────────────────────
// 라운드 9: API 설계 (id 54~68)
// ─────────────────────────────────────────────

store.append("user", {
  type: "set_goal",
  payload: { type: "set_goal", goal: "API 인터페이스 설계 방식 결정" },
});

const r55 = store.append("gpt", {
  type: "propose_decision",
  payload: { type: "propose_decision", value: "REST", reason: "표준, 캐싱, 광범위한 클라이언트 지원" },
  rationale: "HTTP 인프라 그대로 활용 가능",
});

const r56 = store.append("claude", {
  type: "propose_alternative",
  references: [r55.id],
  payload: { type: "propose_alternative", value: "GraphQL", reason: "클라이언트 주도 쿼리, 과조회 방지" },
  rationale: "모바일 클라이언트 다수라면 네트워크 효율 유리",
});

store.append("gpt", {
  type: "propose_alternative",
  references: [r55.id, r56.id],
  payload: { type: "propose_alternative", value: "tRPC", reason: "TypeScript 풀스택 타입 안전" },
  rationale: "TS 모노레포라면 클라이언트-서버 타입 공유로 런타임 에러 제거",
});

store.append("user", {
  type: "select_option",
  references: [r55.id],
  payload: { type: "select_option", selected: "REST" },
  rationale: "외부 클라이언트 연동 고려 시 REST가 범용적",
});

// ─────────────────────────────────────────────
// 라운드 10: 패키지 매니저 (id 59~70)
// ─────────────────────────────────────────────

store.append("user", {
  type: "set_goal",
  payload: { type: "set_goal", goal: "패키지 매니저 통일" },
});

const r60 = store.append("gpt", {
  type: "propose_decision",
  payload: { type: "propose_decision", value: "npm", reason: "기본 내장, 추가 설치 불필요" },
  rationale: "마찰 최소화",
});

const r61 = store.append("claude", {
  type: "propose_alternative",
  references: [r60.id],
  payload: { type: "propose_alternative", value: "pnpm", reason: "디스크 효율, 빠른 설치, 엄격한 의존성" },
  rationale: "모노레포 환경에서 npm 대비 압도적 우위",
});

store.append("gpt", {
  type: "propose_alternative",
  references: [r60.id, r61.id],
  payload: { type: "propose_alternative", value: "Bun", reason: "번들러 + 패키지매니저 + 런타임 통합" },
  rationale: "npm 대비 설치 속도 25배. 단 생태계 성숙도 미지수.",
});

store.append("user", {
  type: "select_option",
  references: [r61.id],
  payload: { type: "select_option", selected: "pnpm" },
  rationale: "모노레포 구조 채택 확정에 따라",
});

// ─────────────────────────────────────────────
// 출력 및 분석
// ─────────────────────────────────────────────

const history = store.getHistory();
const state = store.rebuildState();

fs.writeFileSync("revisions.json", store.toJSON(), "utf-8");

const activeTopics = state.topics.filter((t) => t.status === "active");
const decidedTopics = state.topics.filter((t) => t.status === "decided");
const overriddenTopics = state.topics.filter((t) => t.status === "overridden");

console.log(`총 Revision 수: ${history.length}`);
console.log(`총 Topic 수: ${state.topics.length} (decided=${decidedTopics.length}, active=${activeTopics.length}, overridden=${overriddenTopics.length})`);
console.log(`총 Proposal 수: ${state.topics.reduce((s, t) => s + t.proposals.length, 0)}`);

// references 분포 분석
const withRefs = history.filter((r) => r.patch.references && r.patch.references.length > 0);
const multiRefs = history.filter((r) => r.patch.references && r.patch.references.length > 1);

console.log(`\n─── references 분석 ───`);
console.log(`references 있는 Revision: ${withRefs.length} / ${history.length}`);
console.log(`references 2개 이상: ${multiRefs.length}`);
console.log(`최대 references 수: ${Math.max(...history.map((r) => r.patch.references?.length ?? 0))}`);

// author 분포
const authorCount = history.reduce((acc, r) => {
  acc[r.author] = (acc[r.author] ?? 0) + 1;
  return acc;
}, {} as Record<string, number>);

console.log(`\n─── author 분포 ───`);
for (const [author, count] of Object.entries(authorCount)) {
  console.log(`  ${author}: ${count}개`);
}

// patch type 분포
const typeCount = history.reduce((acc, r) => {
  const t = r.patch.type;
  acc[t] = (acc[t] ?? 0) + 1;
  return acc;
}, {} as Record<string, number>);

console.log(`\n─── patch type 분포 ───`);
for (const [type, count] of Object.entries(typeCount)) {
  console.log(`  ${type}: ${count}개`);
}

// override 이후 상태 추적
const overrides = history.filter((r) => r.patch.type === "user_override");
console.log(`\n─── user_override 발생 ───`);
for (const ov of overrides) {
  console.log(`  id=${ov.id} → goal="${(ov.patch.payload as { goal?: string }).goal}"`);
}

console.log(`\n─── Topic별 요약 ───`);
for (const topic of state.topics) {
  const sel = topic.selectedOption
    ? `→ ${(topic.selectedOption.content as { value: string }).value}`
    : "→ 미선택";
  console.log(`  [${topic.status.padEnd(10)}] ${topic.goal} ${sel}`);
}

console.log("\n=== 최종 State ===");
console.log(JSON.stringify(state, null, 2));
