# Provider Upstream Catalog Snapshot (`bd-3uqg.1.1`)

Generated at (UTC): `2026-02-10T04:26:32Z`

This artifact freezes upstream provider-catalog inputs used for provider parity planning.
It captures:
- raw source provider ID lists
- normalized canonical ID union
- pinned upstream revisions
- reproducible extraction commands
- content hashes

## Pinned Upstream Revisions

| Source | Repository | Commit | Commit timestamp |
|--------|------------|--------|------------------|
| models.dev catalog | `https://github.com/sst/models.dev` | `539cc930c484bbce5ac6699b4542e4f463445543` | `2026-02-09T18:40:24-06:00` |
| opencode providers | `https://github.com/sst/opencode` | `56a752092e78043258372ec7ff5b38c7fe8e622c` | `2026-02-09T22:18:57-06:00` |
| code (`codex`) provider semantics | `https://github.com/openai/codex` | `168c359b71c758002a8fcbf04a957c8b1c03cc52` | `2026-02-09T20:03:32-08:00` |

## Extraction Notes

1. `models.dev` raw provider IDs are top-level directories under `providers/` (directory-only filter).
2. `opencode` raw provider IDs are the top-level keys in `CUSTOM_LOADERS` from:
   - `packages/opencode/src/provider/provider.ts`
3. `codex` raw built-in provider IDs are the default keys in:
   - `codex-rs/core/src/model_provider_info.rs` (`built_in_model_providers()`)
   - configurability semantics are defined in `codex-rs/core/config.schema.json` (`model_provider`, `model_providers`).
4. normalized canonical union is a lowercase sorted deduplicated union of the three raw lists.

## Reproducible Extraction Commands

```bash
SNAP=/tmp/provider_snapshot_20260210
git clone --depth 1 https://github.com/sst/models.dev.git "$SNAP/models.dev"
git clone --depth 1 https://github.com/sst/opencode.git "$SNAP/opencode"
git clone --depth 1 https://github.com/openai/codex.git "$SNAP/codex"

# models.dev raw IDs (directory-only)
cd "$SNAP/models.dev"
for d in providers/*; do [ -d "$d" ] && basename "$d"; done | sort > "$SNAP/models_dev_raw_ids.txt"

# opencode custom-loader IDs
FILE="$SNAP/opencode/packages/opencode/src/provider/provider.ts"
awk 'BEGIN{flag=0} /const CUSTOM_LOADERS:/{flag=1; next} flag && /^  }$/{flag=0} flag {print}' "$FILE" \
  | grep -E '^(    async [a-zA-Z0-9_-]+\(|    "?[a-zA-Z0-9_-]+"?: async)' \
  | sed -E 's/^    async ([a-zA-Z0-9_-]+)\(.*/\1/; s/^    "?([a-zA-Z0-9_-]+)"?: async.*/\1/' \
  | sort -u > "$SNAP/opencode_custom_loader_ids.txt"

# codex built-ins
printf '%s\n' openai ollama lmstudio | sort -u > "$SNAP/codex_builtin_provider_ids.txt"

# normalized union
cat "$SNAP/models_dev_raw_ids.txt" "$SNAP/opencode_custom_loader_ids.txt" "$SNAP/codex_builtin_provider_ids.txt" \
  | tr '[:upper:]' '[:lower:]' | sed '/^$/d' | sort -u > "$SNAP/normalized_provider_ids_union.txt"
```

## Hashes

| Artifact | SHA-256 |
|---------|---------|
| `models_dev_raw_ids.txt` | `6a188c2071a703c951c77904e1d06622e6ac6d660f1a1b47e3d86ebb8fc941b7` |
| `opencode_custom_loader_ids.txt` | `81c53e4f36678c60ae1e50a1fc533a2bb8f93f6dd8e3f115c0d3e301bcb8f8da` |
| `codex_builtin_provider_ids.txt` | `db4f1ed5bf6878717da67a84cdd184a756a361074d907d30af6bbe37bfa1880d` |
| `normalized_provider_ids_union.txt` | `4e58005fb84573fc2bff5a61c383c87c81cc13c346ae08b2eec919e82b67df37` |
| `opencode provider source` (`provider.ts`) | `e5d6bb07198a7cc73674d8a39d122d0893e1e4f374b42478124bee29753c8005` |
| `codex provider source` (`model_provider_info.rs`) | `93eb6b6e9ce44dd2dca80ee56a8b3033b0da498e15f1e704d4e604206850be96` |
| `codex schema` (`config.schema.json`) | `3d98ede34fd2cfb4b353bec00d49a3c92ada193f1597a6701742e5d456c1c2e6` |

## Raw Source Lists

### models.dev raw provider IDs (87)

```text
302ai
abacus
aihubmix
alibaba
alibaba-cn
amazon-bedrock
anthropic
azure
azure-cognitive-services
bailing
baseten
berget
cerebras
chutes
cloudflare-ai-gateway
cloudflare-workers-ai
cohere
cortecs
deepinfra
deepseek
fastrouter
fireworks-ai
firmware
friendli
github-copilot
github-models
gitlab
google
google-vertex
google-vertex-anthropic
groq
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
mistral
moark
modelscope
moonshotai
moonshotai-cn
morph
nano-gpt
nebius
nova
novita-ai
nvidia
ollama-cloud
openai
opencode
openrouter
ovhcloud
perplexity
poe
privatemode-ai
requesty
sap-ai-core
scaleway
siliconflow
siliconflow-cn
submodel
synthetic
togetherai
upstage
v0
venice
vercel
vivgrid
vultr
wandb
xai
xiaomi
zai
zai-coding-plan
zenmux
zhipuai
zhipuai-coding-plan
```

### opencode custom-loader provider IDs (18)

```text
amazon-bedrock
anthropic
azure
azure-cognitive-services
cerebras
cloudflare-ai-gateway
cloudflare-workers-ai
github-copilot
github-copilot-enterprise
gitlab
google-vertex
google-vertex-anthropic
openai
opencode
openrouter
sap-ai-core
vercel
zenmux
```

### code (`codex`) built-in provider IDs (3)

```text
lmstudio
ollama
openai
```

## Normalized Canonical Union (89)

```text
302ai
abacus
aihubmix
alibaba
alibaba-cn
amazon-bedrock
anthropic
azure
azure-cognitive-services
bailing
baseten
berget
cerebras
chutes
cloudflare-ai-gateway
cloudflare-workers-ai
cohere
cortecs
deepinfra
deepseek
fastrouter
fireworks-ai
firmware
friendli
github-copilot
github-copilot-enterprise
github-models
gitlab
google
google-vertex
google-vertex-anthropic
groq
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
mistral
moark
modelscope
moonshotai
moonshotai-cn
morph
nano-gpt
nebius
nova
novita-ai
nvidia
ollama
ollama-cloud
openai
opencode
openrouter
ovhcloud
perplexity
poe
privatemode-ai
requesty
sap-ai-core
scaleway
siliconflow
siliconflow-cn
submodel
synthetic
togetherai
upstage
v0
venice
vercel
vivgrid
vultr
wandb
xai
xiaomi
zai
zai-coding-plan
zenmux
zhipuai
zhipuai-coding-plan
```

## Cross-Source Deltas

- IDs in opencode custom-loader set but not in models.dev: `github-copilot-enterprise`
- IDs in codex built-ins but not in models.dev: `ollama`
