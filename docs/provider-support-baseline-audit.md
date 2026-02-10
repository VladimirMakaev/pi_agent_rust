# Provider Support Baseline Audit (`bd-3uqg.1.2`)

Generated (UTC): `2026-02-10T04:35:41Z`

This report audits current `pi_agent_rust` provider support across:
- provider modules and factory dispatch
- built-in and ad-hoc model presets
- auth/env-key mappings
- test and logging coverage posture

It then diffs the current runtime against the frozen upstream provider snapshot in `docs/provider-upstream-catalog-snapshot.md`.

## Scope And Evidence Inputs

- Frozen upstream catalog snapshot: `docs/provider-upstream-catalog-snapshot.md`
- Runtime dispatch/factory: `src/providers/mod.rs:427`
- Built-in + ad-hoc model defaults: `src/models.rs:178`, `src/models.rs:511`
- Auth provider key mappings: `src/auth.rs:363`
- API/provider enums: `src/provider.rs:200`, `src/provider.rs:250`
- CLI/runtime model selection behavior: `src/app.rs:355`, `src/app.rs:555`
- Provider contract/e2e harness surfaces:
  - `tests/provider_streaming.rs:368`
  - `tests/e2e_provider_streaming.rs:21`
  - `tests/e2e_cross_provider_parity.rs:22`
  - `tests/e2e_live_harness.rs:21`
  - `tests/common/harness.rs:133`

## Runtime Baseline (Current In-Repo Truth)

### 1) Provider Factory Dispatch (`create_provider`)

Current runtime factory behavior in `src/providers/mod.rs:427`:

| Input selector | Behavior | Evidence |
|---|---|---|
| `provider=anthropic` | Native Anthropic provider | `src/providers/mod.rs:443` |
| `provider=openai` | Native OpenAI; switches between responses/completions by API field | `src/providers/mod.rs:451` |
| `provider=google` | Native Gemini provider | `src/providers/mod.rs:484` |
| `provider=cohere` | Native Cohere provider | `src/providers/mod.rs:476` |
| `provider=azure-openai` | Explicit error (not dispatchable through normal provider-name route) | `src/providers/mod.rs:492` |
| Unknown provider name + known API | API fallback route (`anthropic-messages`, `openai-completions`, `openai-responses`, `cohere-chat`, `google-generative-ai`) | `src/providers/mod.rs:502` |
| Unknown provider + unknown API | Error: provider not implemented | `src/providers/mod.rs:533` |

### 2) Model Presets And Ad-Hoc Defaults

- Built-in model registry currently seeds only `anthropic`, `openai`, `google` (`src/models.rs:178`).
- Ad-hoc provider defaults include:
  - Native IDs: `anthropic`, `openai`, `google`, `cohere`
  - OpenAI-compatible presets: `groq`, `deepinfra`, `cerebras`, `openrouter`, `mistral`, `moonshotai`, `alibaba`, `deepseek`, `fireworks`, `togetherai`, `perplexity`, `xai`
  - Alias forms: `moonshot|kimi`, `dashscope|qwen` (`src/models.rs:511` to `src/models.rs:646`)
- CLI/provider selection falls back to ad-hoc defaults only if registry lookup misses (`src/app.rs:355`).

### 3) Auth Mapping Surface

`env_keys_for_provider` includes explicit keys for:
- implemented/preset IDs (`anthropic`, `openai`, `google`, `cohere`, `xai`, `groq`, `openrouter`, `mistral`, `deepseek`, `togetherai`, etc.)
- plus recognized-but-not-fully-routed IDs:
  - `google-vertex`
  - `amazon-bedrock`
  - `azure-openai`
  - `github-copilot`

Evidence: `src/auth.rs:363` to `src/auth.rs:387`.

### 4) Enum Surface vs Runtime Surface

`Api` and `KnownProvider` contain variants for `google-vertex`, `amazon-bedrock`, `azure-openai`, `github-copilot`, and `bedrock-converse-stream` (`src/provider.rs:200`, `src/provider.rs:250`), but these are not currently fully wired through runtime factory dispatch.

## Upstream Gap Diff (Against Frozen 89-ID Union)

Category definitions used in this audit:
- `already-supported`: canonical upstream ID is directly usable now via built-in/ad-hoc defaults + runtime dispatch.
- `partially-supported`: ID has partial plumbing (module, enum, env mapping, or naming-near-match), but not fully dispatchable as canonical upstream ID.
- `alias-only`: upstream ID only available through an alias path (none currently).
- `missing`: no canonical runtime support path today.

### Summary Counts

| Category | Count |
|---|---:|
| `already-supported` | 15 |
| `partially-supported` | 5 |
| `alias-only` | 0 |
| `missing` | 69 |
| **Total upstream IDs** | **89** |

### Already-Supported IDs (15)

`alibaba`, `anthropic`, `cerebras`, `cohere`, `deepinfra`, `deepseek`, `google`, `groq`, `mistral`, `moonshotai`, `openai`, `openrouter`, `perplexity`, `togetherai`, `xai`

### Partially-Supported IDs (5)

| Upstream ID | Why partial today | Evidence | User impact now | Required obligations |
|---|---|---|---|---|
| `azure` | Native Azure module exists, but runtime factory key is `azure-openai` and currently returns explicit error | `src/providers/azure.rs:1`, `src/providers/mod.rs:492` | Canonical `azure` ID not directly routable in normal selection path | Canonical ID mapping + factory routing + registry preset + contract/e2e |
| `google-vertex` | Enum + env key only; no provider-name factory route | `src/provider.rs:254`, `src/auth.rs:368`, `src/providers/mod.rs:427` | Cannot select/use dedicated Vertex runtime path | Implement route or explicit adapter policy + tests |
| `amazon-bedrock` | Enum + env key only; no provider-name factory route | `src/provider.rs:255`, `src/auth.rs:369`, `src/providers/mod.rs:427` | Cannot run Bedrock via canonical ID | Add native/adapter path + tests |
| `github-copilot` | Enum + env key only; no provider-name factory route | `src/provider.rs:257`, `src/auth.rs:371`, `src/providers/mod.rs:427` | No runtime route for canonical ID | Define implementation mode + tests |
| `fireworks-ai` | Upstream canonical is `fireworks-ai`; repo default key is `fireworks` (name drift) | `src/models.rs:615`, `src/auth.rs:381` | Canonical upstream ID not directly recognized by defaults | Alias policy normalization + regression tests |

### Alias-Only IDs

No upstream IDs are currently classified as `alias-only`.

Repo-local alias behavior does exist (outside upstream canonical IDs), for example:
- `moonshot|kimi` -> Moonshot API defaults (`src/models.rs:590`)
- `dashscope|qwen` -> Alibaba/DashScope-compatible defaults (`src/models.rs:599`)

### Missing IDs (69)

```text
302ai
abacus
aihubmix
alibaba-cn
azure-cognitive-services
bailing
baseten
berget
chutes
cloudflare-ai-gateway
cloudflare-workers-ai
cortecs
fastrouter
firmware
friendli
github-copilot-enterprise
github-models
gitlab
google-vertex-anthropic
helicone
huggingface
iflowcn
inception
inference
io-net
jiekou
kimi-for-coding
llama
lmstudio
lucidquery
minimax
minimax-cn
minimax-cn-coding-plan
minimax-coding-plan
moark
modelscope
moonshotai-cn
morph
nano-gpt
nebius
nova
novita-ai
nvidia
ollama
ollama-cloud
opencode
ovhcloud
poe
privatemode-ai
requesty
sap-ai-core
scaleway
siliconflow
siliconflow-cn
submodel
synthetic
upstage
v0
venice
vercel
vivgrid
vultr
wandb
xiaomi
zai
zai-coding-plan
zenmux
zhipuai
zhipuai-coding-plan
```

## Test And Logging Coverage Posture

### Coverage signals currently present

- Contract-level provider streaming harness with deterministic VCR playback and artifact emission:
  - `tests/provider_streaming.rs:55`, `tests/provider_streaming.rs:368`
  - Provider suites: `tests/provider_streaming/anthropic.rs`, `tests/provider_streaming/openai.rs`, `tests/provider_streaming/openai_responses.rs`, `tests/provider_streaming/gemini.rs`, `tests/provider_streaming/cohere.rs`, `tests/provider_streaming/azure.rs`
- Deterministic error-path coverage via synthetic VCR cassettes:
  - `tests/provider_error_paths.rs:1`
- Anthropic-specific full e2e provider stream pipeline + JSONL artifacts:
  - `tests/e2e_provider_streaming.rs:21`, `tests/e2e_provider_streaming.rs:748`
- Live parity and live harness JSONL/Markdown artifacts for selected providers:
  - `tests/e2e_cross_provider_parity.rs:22`
  - `tests/e2e_live_harness.rs:21`
  - `tests/common/harness.rs:133`

### Important nuance

Live harness routing is broader than app runtime factory routing for some OpenAI-compatible providers, because harness-side constructor selection in `tests/common/harness.rs:1276` is not the same code path as `src/providers/mod.rs:427`. This means parity/live results can validate wire behavior while runtime provider-name selection is still incomplete.

### Provider-group posture

| Provider group | Current posture | Key gaps |
|---|---|---|
| `anthropic`, `openai`, `google`, `cohere` | Strongest coverage (native provider modules + contract harness + error-path tests; anthropic has extra e2e stream suite) | Still need explicit parity matrix closure work for all required scenarios in epic |
| `openrouter`, `xai`, `deepseek` | Covered in live parity targets | Runtime support relies on OpenAI-compatible path; coverage should include explicit runtime route assertions |
| `groq`, `deepinfra`, `cerebras`, `mistral`, `moonshotai`, `alibaba`, `togetherai`, `perplexity` | Ad-hoc defaults exist; generic OpenAI-compatible path likely usable | No dedicated provider-specific contract/e2e suites currently |
| `azure` (upstream canonical) | Azure module + azure contract suite exist | Canonical runtime routing gap (`azure-openai` error path) |
| `google-vertex`, `amazon-bedrock`, `github-copilot`, `fireworks-ai` | Partial metadata surface only | No end-to-end dispatch path + no provider-specific contract/e2e |
| Remaining 69 missing IDs | No canonical runtime support | Need implementation-mode decisions and onboarding test plans |

## Required Follow-Through Inputs For `bd-3uqg.1.3`

This audit provides the downstream alias/canonical policy step with:
- explicit count-checked upstream diff by category
- concrete evidence for partial IDs
- explicit naming drifts (`azure` vs `azure-openai`, `fireworks-ai` vs `fireworks`)
- current test/log artifact surfaces and where they are insufficient

Minimum downstream execution obligations per newly onboarded provider family:
- unit: registry/auth/factory selection assertions
- contract: provider streaming parity + error translation artifacts
- e2e/live: include provider in parity/live target sets where applicable
- logging: emit JSON/JSONL artifacts consistent with existing harness schema
