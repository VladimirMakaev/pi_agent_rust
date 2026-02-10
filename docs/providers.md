# Providers

This document is the canonical in-repo provider baseline for `pi_agent_rust`.
It summarizes provider IDs, aliases, API families, auth behavior, and current implementation mode.

Snapshot basis:
- `src/models.rs` (`built_in_models`, `ad_hoc_provider_defaults`)
- `src/auth.rs` (`env_keys_for_provider`)
- `src/providers/mod.rs` (`create_provider`, API fallback routing)
- `src/providers/*.rs` native implementations
- Timestamp: 2026-02-10

## Implementation Modes

| Mode | Meaning |
|------|---------|
| `native-implemented` | Provider has a direct runtime path in `create_provider` and is dispatchable now. |
| `native-partial` | Native module exists, but factory wiring or required config path is not fully integrated. |
| `oai-compatible-preset` | Provider resolves through OpenAI-compatible adapter (`openai-completions`) with preset base/auth defaults. |
| `alias-only` | Provider ID is a documented synonym of a canonical ID; no distinct runtime implementation. |
| `missing` | Provider ID is recognized in enums/auth mappings but has no usable runtime dispatch path yet. |

### Machine-Readable Classification (`bd-3uqg.1.4`)

Canonical planning artifact: `docs/provider-implementation-modes.json`

This JSON is the execution source-of-truth for provider onboarding mode selection:

| Mode | Planning Meaning |
|------|------------------|
| `native-adapter-required` | Requires dedicated runtime adapter path (protocol/auth/tool semantics not safely covered by generic OAI routing). |
| `oai-compatible-preset` | Can route through OpenAI-compatible adapter with provider-specific base/auth presets. |
| `gateway-wrapper-routing` | Acts as gateway/meta-router/alias-routing surface; prioritize routing-policy and diagnostics guarantees. |
| `deferred` | Explicitly not in current implementation wave; retained for planning completeness. |

Current artifact coverage (`docs/provider-implementation-modes.json`):
- 93 upstream union IDs classified (no gaps)
- 6 supplemental Pi alias IDs classified
- 99 total entries with explicit profile, rationale, and runtime status
- 20 high-risk providers carry explicit prerequisite beads + required diagnostic artifacts

## Verification Evidence Legend

- Metadata and alias/routing lock: [`tests/provider_metadata_comprehensive.rs`](../tests/provider_metadata_comprehensive.rs)
- Factory and adapter selection lock: [`tests/provider_factory.rs`](../tests/provider_factory.rs)
- Native provider request-shape lock: [`tests/provider_backward_lock.rs`](../tests/provider_backward_lock.rs)
- Provider streaming contract suites: [`tests/provider_streaming.rs`](../tests/provider_streaming.rs)
- Live parity smoke lane: [`tests/e2e_cross_provider_parity.rs`](../tests/e2e_cross_provider_parity.rs)
- Live provider integration lane: [`tests/e2e_live.rs`](../tests/e2e_live.rs)

## Canonical Provider Matrix (Current Baseline + Evidence Links)

| Canonical ID | Aliases | Capability flags | API family | Base URL template | Auth mode | Mode | Runtime status | Verification evidence (unit + e2e) |
|--------------|---------|------------------|------------|-------------------|-----------|------|----------------|------------------------------------|
| `anthropic` | - | text + image + thinking + tool-calls | `anthropic-messages` | `https://api.anthropic.com/v1/messages` | `x-api-key` (`ANTHROPIC_API_KEY`) or `auth.json` OAuth/API key | `native-implemented` | Implemented and dispatchable | [unit](../tests/provider_streaming/anthropic.rs), [contract](../tests/provider_backward_lock.rs), [e2e](../tests/e2e_provider_streaming.rs), [cassette](../tests/fixtures/vcr/anthropic_simple_text.json) |
| `openai` | - | text + image + reasoning + tool-calls | `openai-responses` (default), `openai-completions` (compat) | `https://api.openai.com/v1` (normalized to `/responses` or `/chat/completions`) | `Authorization: Bearer` (`OPENAI_API_KEY`) | `native-implemented` | Implemented and dispatchable | [unit](../tests/provider_streaming/openai.rs), [responses](../tests/provider_streaming/openai_responses.rs), [contract](../tests/provider_backward_lock.rs), [e2e](../tests/e2e_cross_provider_parity.rs), [cassette](../tests/fixtures/vcr/openai_simple_text.json) |
| `google` | `gemini` | text + image + reasoning + tool-calls | `google-generative-ai` | `https://generativelanguage.googleapis.com/v1beta` | query key (`GOOGLE_API_KEY`, fallback `GEMINI_API_KEY`) | `native-implemented` | Implemented and dispatchable | [unit](../tests/provider_streaming/gemini.rs), [contract](../tests/provider_backward_lock.rs), [e2e](../tests/e2e_cross_provider_parity.rs), [cassette](../tests/fixtures/vcr/gemini_simple_text.json) |
| `google-vertex` | `vertexai` | text + image + reasoning + tool-calls | `google-vertex` | `https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/publishers/{publisher}/models/{model}` | `Authorization: Bearer` (`GOOGLE_CLOUD_API_KEY`, alt `VERTEX_API_KEY`) | `native-implemented` | Implemented and dispatchable; supports Google (Gemini) and Anthropic publishers | [unit](../src/providers/vertex.rs), [factory](../src/providers/mod.rs), [metadata](../tests/provider_metadata_comprehensive.rs) |
| `cohere` | - | text + tool-calls | `cohere-chat` | `https://api.cohere.com/v2` (normalized to `/chat`) | `Authorization: Bearer` (`COHERE_API_KEY`) | `native-implemented` | Implemented and dispatchable | [unit](../tests/provider_streaming/cohere.rs), [contract](../tests/provider_backward_lock.rs), [cassette](../tests/fixtures/vcr/cohere_simple_text.json), e2e expansion tracked in `bd-3uqg.8.4` |
| `azure-openai` | `azure`, `azure-cognitive-services` | text + tool-calls | Azure chat/completions path | `https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version={version}` or `https://{resource}.cognitiveservices.azure.com/openai/deployments/{deployment}/chat/completions?api-version={version}` | `api-key` header (`AZURE_OPENAI_API_KEY`) | `native-implemented` | Dispatchable through provider factory with deterministic resource/deployment/api-version resolution from env + model/base_url | [unit](../tests/provider_streaming/azure.rs), [contract](../tests/provider_backward_lock.rs), [e2e](../tests/e2e_live.rs), [cassette](../tests/fixtures/vcr/azure_simple_text.json) |
| `groq` | - | text (+ OAI-compatible tools) | `openai-completions` | `https://api.groq.com/openai/v1` | `Authorization: Bearer` (`GROQ_API_KEY`) | `oai-compatible-preset` | Dispatchable through OpenAI-compatible fallback | [metadata](../tests/provider_metadata_comprehensive.rs), [factory](../tests/provider_factory.rs), e2e expansion tracked in `bd-3uqg.8.4` |
| `deepinfra` | - | text (+ OAI-compatible tools) | `openai-completions` | `https://api.deepinfra.com/v1/openai` | `Authorization: Bearer` (`DEEPINFRA_API_KEY`) | `oai-compatible-preset` | Dispatchable through OpenAI-compatible fallback | [metadata](../tests/provider_metadata_comprehensive.rs), [factory](../tests/provider_factory.rs), e2e expansion tracked in `bd-3uqg.8.4` |
| `cerebras` | - | text (+ OAI-compatible tools) | `openai-completions` | `https://api.cerebras.ai/v1` | `Authorization: Bearer` (`CEREBRAS_API_KEY`) | `oai-compatible-preset` | Dispatchable through OpenAI-compatible fallback | [metadata](../tests/provider_metadata_comprehensive.rs), [factory](../tests/provider_factory.rs), e2e expansion tracked in `bd-3uqg.8.4` |
| `openrouter` | - | text (+ OAI-compatible tools) | `openai-completions` | `https://openrouter.ai/api/v1` | `Authorization: Bearer` (`OPENROUTER_API_KEY`) | `oai-compatible-preset` | Dispatchable through OpenAI-compatible fallback | [metadata](../tests/provider_metadata_comprehensive.rs), [factory](../tests/provider_factory.rs), [e2e](../tests/e2e_cross_provider_parity.rs) |
| `mistral` | - | text (+ OAI-compatible tools) | `openai-completions` | `https://api.mistral.ai/v1` | `Authorization: Bearer` (`MISTRAL_API_KEY`) | `oai-compatible-preset` | Dispatchable through OpenAI-compatible fallback | [metadata](../tests/provider_metadata_comprehensive.rs), [factory](../tests/provider_factory.rs), e2e expansion tracked in `bd-3uqg.8.4` |
| `moonshotai` | `moonshot`, `kimi` | text (+ OAI-compatible tools) | `openai-completions` | `https://api.moonshot.ai/v1` | `Authorization: Bearer` (`MOONSHOT_API_KEY`) | `oai-compatible-preset` (`moonshot`,`kimi` are `alias-only`) | Dispatchable through OpenAI-compatible fallback | [metadata](../tests/provider_metadata_comprehensive.rs), [factory](../tests/provider_factory.rs), [alias-roundtrip](../tests/provider_factory.rs), e2e expansion tracked in `bd-3uqg.8.4` |
| `dashscope` | `alibaba`, `qwen` | text (+ OAI-compatible tools) | `openai-completions` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `Authorization: Bearer` (`DASHSCOPE_API_KEY`) | `oai-compatible-preset` (`alibaba`,`qwen` are `alias-only`) | Dispatchable through OpenAI-compatible fallback | [metadata](../tests/provider_metadata_comprehensive.rs), [factory](../tests/provider_factory.rs), e2e expansion tracked in `bd-3uqg.8.4` |
| `deepseek` | - | text (+ OAI-compatible tools) | `openai-completions` | `https://api.deepseek.com` | `Authorization: Bearer` (`DEEPSEEK_API_KEY`) | `oai-compatible-preset` | Dispatchable through OpenAI-compatible fallback | [metadata](../tests/provider_metadata_comprehensive.rs), [factory](../tests/provider_factory.rs), [e2e](../tests/e2e_cross_provider_parity.rs) |
| `fireworks` | `fireworks-ai` | text (+ OAI-compatible tools) | `openai-completions` | `https://api.fireworks.ai/inference/v1` | `Authorization: Bearer` (`FIREWORKS_API_KEY`) | `oai-compatible-preset` | Dispatchable through OpenAI-compatible fallback | [metadata](../tests/provider_metadata_comprehensive.rs), [factory](../tests/provider_factory.rs), e2e expansion tracked in `bd-3uqg.8.4` |
| `togetherai` | - | text (+ OAI-compatible tools) | `openai-completions` | `https://api.together.xyz/v1` | `Authorization: Bearer` (`TOGETHER_API_KEY`, alt `TOGETHER_AI_API_KEY`) | `oai-compatible-preset` | Dispatchable through OpenAI-compatible fallback | [metadata](../tests/provider_metadata_comprehensive.rs), [factory](../tests/provider_factory.rs), e2e expansion tracked in `bd-3uqg.8.4` |
| `perplexity` | - | text (+ OAI-compatible tools) | `openai-completions` | `https://api.perplexity.ai` | `Authorization: Bearer` (`PERPLEXITY_API_KEY`) | `oai-compatible-preset` | Dispatchable through OpenAI-compatible fallback | [metadata](../tests/provider_metadata_comprehensive.rs), [factory](../tests/provider_factory.rs), e2e expansion tracked in `bd-3uqg.8.4` |
| `xai` | - | text (+ OAI-compatible tools) | `openai-completions` | `https://api.x.ai/v1` | `Authorization: Bearer` (`XAI_API_KEY`) | `oai-compatible-preset` | Dispatchable through OpenAI-compatible fallback | [metadata](../tests/provider_metadata_comprehensive.rs), [factory](../tests/provider_factory.rs), [e2e](../tests/e2e_cross_provider_parity.rs) |

## Missing/Partial IDs in Current Runtime

Provider IDs already recognized in auth/enums but not yet fully dispatchable:

| ID | Current state | Rationale | Risk | Follow-up beads | Current evidence |
|----|---------------|-----------|------|-----------------|------------------|
| `google-vertex` (`vertexai`) | `native-implemented` (`bd-3uqg.3.1` closed) | Native Vertex AI adapter is dispatchable with streaming for both Google (Gemini) and Anthropic publishers. | Resolved | — | [unit](../src/providers/vertex.rs), [factory](../src/providers/mod.rs), [metadata](../tests/provider_metadata_comprehensive.rs) |
| `amazon-bedrock` (`bedrock`) | `missing` (enum/env mapping only) | Bedrock Converse semantics need a native adapter path and credential-chain validation. | High: AWS users cannot route through first-class runtime path. | `bd-3uqg.3.3`, `bd-3uqg.3.8.2` | [metadata](../tests/provider_metadata_comprehensive.rs), [planning profile](provider-implementation-modes.json) |
| `github-copilot` (`copilot`) | `missing` (enum/env mapping only) | Provider protocol/auth flow is not implemented in native runtime path. | High: Copilot IDs remain non-dispatchable despite auth/env mapping. | `bd-3uqg.3.2`, `bd-3uqg.3.8.2` | [metadata](../tests/provider_metadata_comprehensive.rs), [planning profile](provider-implementation-modes.json) |

Full deferred/high-risk inventory (including rationale text for all classified IDs) lives in `docs/provider-implementation-modes.json`.

## Already-Covered vs Missing Snapshot

Covered now:
- 5 native dispatchable providers: `anthropic`, `openai`, `google`, `cohere`, `azure-openai`.
- 12 OpenAI-compatible preset providers dispatchable via fallback adapters:
  `groq`, `deepinfra`, `cerebras`, `openrouter`, `mistral`, `moonshotai`, `dashscope`,
  `deepseek`, `fireworks`, `togetherai`, `perplexity`, `xai`.
- Alias coverage built into preset defaults:
  `moonshot`/`kimi` -> `moonshotai`, and `alibaba`/`qwen` -> `dashscope`.

Not fully covered yet:
- 3 recognized-but-missing paths: `google-vertex`, `amazon-bedrock`, `github-copilot`.
- Additional upstream IDs from `models.dev + opencode + code` remain to be classified in the
  frozen upstream snapshot workflow (`bd-3uqg.1.1`).

## Provider Selection and Configuration

Credential resolution precedence (runtime):
1. explicit CLI override (`--api-key`)
2. provider env vars from metadata (ordered; includes shared fallbacks like `GOOGLE_API_KEY` then `GEMINI_API_KEY`)
3. persisted `auth.json` credential (`ApiKey` or unexpired OAuth `access_token`)
4. inline `models.json` `apiKey` fallback (resolved from literal/env/file/shell sources)

Choose provider/model via:
- CLI flags: `pi --provider openai --model gpt-4o "Hello"`
- Env vars: `PI_PROVIDER`, `PI_MODEL`
- Settings: `default_provider`, `default_model` in `~/.pi/agent/settings.json`

Custom endpoints and overrides should be configured in `models.json`:
- See [models.md](models.md) for schema and examples.

Example key exports:

```bash
export ANTHROPIC_API_KEY="..."
export OPENAI_API_KEY="..."
export GOOGLE_API_KEY="..."
export COHERE_API_KEY="..."
```
