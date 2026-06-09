import type { DiscussionMode } from "../types.js";

export function getModeInstruction(mode: DiscussionMode | undefined): string {
  switch (mode ?? "general") {
    case "development":
      return (
        `Discussion mode: development\n` +
        `Focus on technical stack choices, implementation approaches, architecture patterns, ` +
        `and concrete technology recommendations. Propose specific technologies, frameworks, databases, and tools.`
      );
    case "idea":
      return (
        `Discussion mode: idea\n` +
        `Focus on creative proposals, product concepts, feature ideas, naming, and expansive thinking. ` +
        `Encourage innovative and generative suggestions beyond conventional technical choices.`
      );
    default: // "general"
      return (
        `Discussion mode: general\n` +
        `Do not over-engineer. For casual or short inputs, prefer simple and direct responses. ` +
        `Avoid expanding simple topics into complex technical architectures or systems.`
      );
  }
}
