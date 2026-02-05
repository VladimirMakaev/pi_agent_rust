const AGENT_CHAIN_ENV = "PI_AGENT_CHAIN";
const AGENT_CHAIN_MAX_DEPTH_ENV = "PI_AGENT_CHAIN_MAX_DEPTH";
const DEFAULT_AGENT_CHAIN_MAX_DEPTH = 1;

export interface BuildAgentSpawnEnvOptions {
  baseEnv?: NodeJS.ProcessEnv;
  extraEnv?: NodeJS.ProcessEnv;
  maxDepth?: number;
}

export interface BuildAgentSpawnEnvResult {
  env?: NodeJS.ProcessEnv;
  error?: string;
}

export function parseAgentChain(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[AGENT_CHAIN_ENV]?.trim();
  if (!raw) return [];
  return raw
    .split(">")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function getCurrentAgentName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const chain = parseAgentChain(env);
  return chain.length > 0 ? chain[chain.length - 1] : undefined;
}

export function formatAgentChain(chain: string[]): string {
  return chain.join(">");
}

export function readChainMaxDepth(
  env: NodeJS.ProcessEnv = process.env,
  defaultValue: number = DEFAULT_AGENT_CHAIN_MAX_DEPTH,
): number {
  const raw = env[AGENT_CHAIN_MAX_DEPTH_ENV]?.trim();
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultValue;
  return parsed;
}

export function buildAgentSpawnEnv(agentName: string, options: BuildAgentSpawnEnvOptions = {}): BuildAgentSpawnEnvResult {
  const baseEnv = options.baseEnv ?? process.env;
  const chain = parseAgentChain(baseEnv);
  if (chain.includes(agentName)) {
    return {
      error: `Critical: agent chain already includes "${agentName}" (${formatAgentChain(chain)}).`,
    };
  }

  const maxDepth = options.maxDepth ?? readChainMaxDepth(baseEnv, DEFAULT_AGENT_CHAIN_MAX_DEPTH);
  if (chain.length >= maxDepth) {
    return {
      error: `Critical: agent chain depth ${chain.length} exceeds max ${maxDepth}.`,
    };
  }

  const nextChain = formatAgentChain([...chain, agentName]);
  return {
    env: {
      ...baseEnv,
      [AGENT_CHAIN_ENV]: nextChain,
      ...options.extraEnv,
    },
  };
}

export const AgentChainEnv = {
  AGENT_CHAIN_ENV,
  AGENT_CHAIN_MAX_DEPTH_ENV,
  DEFAULT_AGENT_CHAIN_MAX_DEPTH,
};
