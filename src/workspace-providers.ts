import Anthropic from "@anthropic-ai/sdk";

// ─── Types ────────────────────────────────────────────────────────

export type WsProviderName = "claude" | "mock";

export interface WsLinkedContext {
  goal:          string;
  selectedValue: string;
  selectedBy:    string;
  alternatives:  Array<{ value: string; author: string }>;
  mode?:         string;
}

// ─── Plan types ───────────────────────────────────────────────────

export interface WorkspacePlanStep {
  id:           string;
  title:        string;
  description?: string;
  status:       "pending" | "completed";
}

export interface WorkspacePlan {
  id:          string;
  title:       string;
  steps:       WorkspacePlanStep[];
  generatedAt: string;
  linkedGoal?: string;
  provider:    WsProviderName;
}

// ─── Provider interface ───────────────────────────────────────────

export interface WorkspaceAIProvider {
  readonly name: WsProviderName;
  send(
    messages: { role: "user" | "assistant"; content: string }[],
    context?: WsLinkedContext,
  ): Promise<string>;
  generatePlan(context?: WsLinkedContext): Promise<WorkspacePlan>;
}

// ─── Claude Provider ──────────────────────────────────────────────

export class ClaudeWorkspaceProvider implements WorkspaceAIProvider {
  readonly name: WsProviderName = "claude";
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async send(
    messages: { role: "user" | "assistant"; content: string }[],
    context?: WsLinkedContext,
  ): Promise<string> {
    let systemPrompt =
      "You are a Workspace AI assistant for gcpt — an AI collaborative meeting system.\n" +
      "Your role is to help implement, explain, and refactor code based on decisions made in an AI discussion session.\n" +
      "Be concise and practical. Respond in Korean for explanations; keep code in the target language.";

    if (context) {
      const alts = context.alternatives.map(a => a.value).join(", ");
      systemPrompt +=
        "\n\nDiscussion result:" +
        `\n- Goal: ${context.goal}` +
        `\n- Selected: ${context.selectedValue} (by ${context.selectedBy})` +
        (alts ? `\n- Alternatives: ${alts}` : "") +
        (context.mode ? `\n- Mode: ${context.mode}` : "");
    }

    const res = await this.client.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system:     systemPrompt,
      messages,
    });

    const block = res.content[0];
    if (block.type !== "text") throw new Error("unexpected response type");
    return block.text;
  }

  async generatePlan(context?: WsLinkedContext): Promise<WorkspacePlan> {
    const sysPrompt =
      "You are a technical planning assistant. Generate a concise implementation plan.\n" +
      "Respond ONLY with a valid JSON object matching this exact schema:\n" +
      "{\"title\": string, \"steps\": [{\"id\": string, \"title\": string, \"description\": string}]}\n" +
      "id values must be \"1\", \"2\", etc. Steps must be concrete and actionable. 3-7 steps max. " +
      "No markdown fences, no prose outside the JSON object.";

    const userMsg = context
      ? `Generate an implementation plan.\nGoal: ${context.goal}\nDecision: ${context.selectedValue}` +
        (context.alternatives.length
          ? `\nAlternatives considered: ${context.alternatives.map(a => a.value).join(", ")}`
          : "")
      : "Generate a general workspace setup checklist.";

    const res = await this.client.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 512,
      system:     sysPrompt,
      messages:   [{ role: "user", content: userMsg }],
    });

    const block = res.content[0];
    if (block.type !== "text") throw new Error("unexpected response type");

    // 마크다운 코드 펜스 제거 후 첫 번째 JSON 객체 추출
    let jsonText = block.text.trim();
    const fenceMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      jsonText = fenceMatch[1].trim();
    } else {
      // 펜스 없으면 첫 번째 { ... } 블록만 추출
      const braceStart = jsonText.indexOf("{");
      const braceEnd   = jsonText.lastIndexOf("}");
      if (braceStart !== -1 && braceEnd > braceStart)
        jsonText = jsonText.slice(braceStart, braceEnd + 1);
    }

    const raw = JSON.parse(jsonText) as {
      title: string;
      steps: Array<{ id: string; title: string; description?: string }>;
    };
    if (!raw.title || !Array.isArray(raw.steps)) throw new Error("invalid plan JSON");

    return {
      id:          `plan-${Date.now()}`,
      title:       raw.title,
      steps:       raw.steps.map(s => ({ ...s, status: "pending" as const })),
      generatedAt: new Date().toLocaleTimeString(),
      linkedGoal:  context?.goal,
      provider:    "claude",
    };
  }
}

// ─── Mock Provider ────────────────────────────────────────────────

const MOCK_KEYWORD_RESPONSES: Record<string, string> = {
  postgres:
    "PostgreSQL 기반 설정입니다.\n\n```yaml\n# docker-compose.yml\nservices:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_DB: app\n      POSTGRES_USER: app\n      POSTGRES_PASSWORD: secret\n    ports:\n      - \"5432:5432\"\n```\n\nPrisma schema 생성이 필요하면 알려주세요.",
  mysql:
    "MySQL 기반 설정입니다.\n\n```yaml\n# docker-compose.yml\nservices:\n  db:\n    image: mysql:8\n    environment:\n      MYSQL_DATABASE: app\n      MYSQL_ROOT_PASSWORD: secret\n    ports:\n      - \"3306:3306\"\n```",
  prisma:
    "Prisma schema 기본 구조입니다.\n\n```prisma\ngenerator client {\n  provider = \"prisma-client-js\"\n}\n\ndatasource db {\n  provider = \"postgresql\"\n  url      = env(\"DATABASE_URL\")\n}\n\nmodel User {\n  id        Int      @id @default(autoincrement())\n  email     String   @unique\n  createdAt DateTime @default(now())\n}\n```",
  migration:
    "마이그레이션 기본 전략:\n\n1. 현재 스키마 백업\n2. 변경사항 incremental 적용\n3. 롤백 스크립트 준비\n\n```bash\nnpx prisma migrate dev --name init\n```",
  docker:
    "Docker Compose 기본 구성입니다.\n\n```yaml\nversion: '3.8'\nservices:\n  app:\n    build: .\n    ports:\n      - \"3000:3000\"\n    depends_on:\n      - db\n  db:\n    image: postgres:16\n```",
  schema:
    "스키마 설계 원칙:\n\n1. 정규화 우선 (3NF)\n2. 인덱스 전략 명확히\n3. null 허용 최소화\n4. FK 관계 명시\n\n테이블 구조를 알려주시면 구체적으로 도움드릴 수 있습니다.",
  typescript:
    "TypeScript 권장사항:\n\n1. `interface` > `type` (확장 가능성)\n2. discriminated union으로 상태 표현\n3. `unknown` > `any`\n4. utility types 적극 활용 (Partial, Pick, Omit)",
  react:
    "React 컴포넌트 설계:\n\n1. 단일 책임 원칙\n2. props 최소화\n3. 상태 관리: useState → Context → 외부 store\n4. useMemo/useCallback 필요 시에만",
  api:
    "API 설계 원칙:\n\n1. RESTful 리소스 명명\n2. 버전 관리 (/v1, /v2)\n3. 에러 응답 일관성\n4. 페이지네이션 표준화",
  mongodb:
    "MongoDB 기반 설정입니다.\n\n```yaml\n# docker-compose.yml\nservices:\n  mongo:\n    image: mongo:7\n    environment:\n      MONGO_INITDB_DATABASE: app\n    ports:\n      - \"27017:27017\"\n```",
  redis:
    "Redis 기반 설정입니다.\n\n```yaml\n# docker-compose.yml\nservices:\n  cache:\n    image: redis:7-alpine\n    ports:\n      - \"6379:6379\"\n```",
};

const MOCK_GENERIC_RESPONSES = [
  "파일 구조를 먼저 정리하고, 핵심 로직부터 단계적으로 구현하는 것을 권장합니다.\n\n추가 질문이 있으면 말씀해주세요.",
  "현재 접근 방식은 합리적입니다. 에러 핸들링과 타입 안전성을 강화하면 더 견고해질 수 있습니다.",
  "모듈 분리와 단일 책임 원칙을 유지하면서 진행하시면 좋습니다. 구체적인 구현이 필요하면 질문해주세요.",
];

export class MockWorkspaceProvider implements WorkspaceAIProvider {
  readonly name: WsProviderName = "mock";

  send(
    messages: { role: "user" | "assistant"; content: string }[],
    context?: WsLinkedContext,
  ): Promise<string> {
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    const query = (lastUser?.content ?? "").toLowerCase();

    // keyword match: query first, then context selectedValue
    const searchTarget = context
      ? `${query} ${context.selectedValue?.toLowerCase() ?? ""}`
      : query;

    for (const [key, resp] of Object.entries(MOCK_KEYWORD_RESPONSES)) {
      if (searchTarget.includes(key)) return Promise.resolve(resp);
    }

    // context-aware generic
    if (context) {
      return Promise.resolve(
        `${context.selectedValue} 기반으로 진행 가능합니다.\n\n현재 Claude API가 응답하지 않아 오프라인 모드입니다.\n질문을 구체적으로 작성하시면 관련 템플릿을 제공해드릴 수 있습니다.`,
      );
    }

    // hash-based generic (deterministic variety by conversation length)
    const idx = messages.length % MOCK_GENERIC_RESPONSES.length;
    return Promise.resolve(MOCK_GENERIC_RESPONSES[idx]);
  }

  generatePlan(context?: WsLinkedContext): Promise<WorkspacePlan> {
    const value = context?.selectedValue?.toLowerCase() ?? "";

    type RawStep = Omit<WorkspacePlanStep, "status">;
    let rawSteps: RawStep[];

    if (value.includes("postgres") || value.includes("postgresql")) {
      rawSteps = [
        { id: "1", title: "docker-compose.yml에 PostgreSQL 서비스 추가" },
        { id: "2", title: ".env 파일에 DATABASE_URL 설정" },
        { id: "3", title: "Prisma 설치 및 초기화 (npx prisma init)" },
        { id: "4", title: "schema.prisma 모델 작성" },
        { id: "5", title: "npx prisma migrate dev 실행" },
      ];
    } else if (value.includes("mysql")) {
      rawSteps = [
        { id: "1", title: "docker-compose.yml에 MySQL 서비스 추가" },
        { id: "2", title: "DATABASE_URL 환경변수 설정" },
        { id: "3", title: "ORM 라이브러리 설치 및 설정" },
        { id: "4", title: "스키마 작성 및 migration 실행" },
      ];
    } else if (value.includes("mongodb")) {
      rawSteps = [
        { id: "1", title: "docker-compose.yml에 MongoDB 추가" },
        { id: "2", title: "MONGODB_URI 환경변수 설정" },
        { id: "3", title: "Mongoose 설치 및 연결 설정" },
        { id: "4", title: "Schema/Model 정의" },
      ];
    } else if (value.includes("redis")) {
      rawSteps = [
        { id: "1", title: "docker-compose.yml에 Redis 추가" },
        { id: "2", title: "REDIS_URL 환경변수 설정" },
        { id: "3", title: "redis 클라이언트 라이브러리 설치" },
        { id: "4", title: "캐시 레이어 구현" },
      ];
    } else {
      rawSteps = [
        { id: "1", title: `${context?.selectedValue ?? "기술 스택"} 설치 및 초기화` },
        { id: "2", title: "환경 설정 (.env, config 파일) 작성" },
        { id: "3", title: "기본 구조 및 진입점 생성" },
        { id: "4", title: "핵심 기능 구현" },
        { id: "5", title: "테스트 및 동작 검증" },
      ];
    }

    return Promise.resolve({
      id:          `plan-${Date.now()}`,
      title:       `${context?.selectedValue ?? "워크스페이스"} 구현 계획`,
      steps:       rawSteps.map(s => ({ ...s, status: "pending" as const })),
      generatedAt: new Date().toLocaleTimeString(),
      linkedGoal:  context?.goal,
      provider:    "mock" as WsProviderName,
    });
  }
}

// ─── Provider factory ─────────────────────────────────────────────

export function makeClaudeProvider(apiKey: string): ClaudeWorkspaceProvider {
  return new ClaudeWorkspaceProvider(apiKey);
}

export function makeMockProvider(): MockWorkspaceProvider {
  return new MockWorkspaceProvider();
}
