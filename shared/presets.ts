import type { ModelInfo, ProviderConfig } from './settings'

export interface ProviderPreset extends Omit<ProviderConfig, 'enabled' | 'id'> {
  presetId: string
  blurb: string
}

const chat = (id: string, name: string, ctx: number, extra: Partial<ModelInfo> = {}): ModelInfo =>
  ({ id, name, modality: 'chat', contextWindow: ctx, tools: true, vision: false, ...extra })
const img = (id: string, name: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, name, modality: 'image', ...extra })

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    presetId: 'anthropic', name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKeyEnv: 'ANTHROPIC_API_KEY', requiresKey: true, preset: 'anthropic',
    blurb: 'Claude models through the Anthropic Messages API.',
    models: [
      chat('claude-fable-5-1', 'Claude Fable 5.1', 1_000_000, { vision: true, reasoning: true, maxOutput: 64000 }),
      chat('claude-opus-5-5', 'Claude Opus 5.5', 500_000, { vision: true, reasoning: true, maxOutput: 64000 }),
      chat('claude-sonnet-5-5', 'Claude Sonnet 5.5', 500_000, { vision: true, reasoning: true, maxOutput: 64000 }),
      chat('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 200_000, { vision: true, maxOutput: 32000 })
    ]
  },
  {
    presetId: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', requiresKey: true, preset: 'openai',
    blurb: 'GPT models, plus image generation and editing.',
    models: [
      chat('gpt-5', 'GPT-5', 400_000, { vision: true, reasoning: true }),
      chat('gpt-5-mini', 'GPT-5 mini', 400_000, { vision: true, reasoning: true }),
      chat('gpt-4.1', 'GPT-4.1', 1_000_000, { vision: true }),
      chat('gpt-4o-mini', 'GPT-4o mini', 128_000, { vision: true }),
      img('gpt-image-1', 'GPT Image 1'),
      img('dall-e-3', 'DALL·E 3')
    ]
  },
  {
    presetId: 'google', name: 'Google Gemini', protocol: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKeyEnv: 'GEMINI_API_KEY', requiresKey: true, preset: 'google',
    blurb: 'Gemini models, including multimodal and image generation.',
    models: [
      chat('gemini-2.5-pro', 'Gemini 2.5 Pro', 1_000_000, { vision: true, reasoning: true }),
      chat('gemini-2.5-flash', 'Gemini 2.5 Flash', 1_000_000, { vision: true, reasoning: true }),
      img('gemini-2.5-flash-image', 'Gemini 2.5 Flash Image'),
      img('imagen-4.0-generate-001', 'Imagen 4')
    ]
  },
  {
    presetId: 'openrouter', name: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', requiresKey: true, preset: 'openrouter',
    blurb: 'One key for hundreds of hosted models.',
    models: [chat('anthropic/claude-sonnet-5-5', 'Claude Sonnet 5.5', 500_000, { vision: true }), chat('openai/gpt-5', 'GPT-5', 400_000, { vision: true }), chat('deepseek/deepseek-chat', 'DeepSeek Chat', 128_000)]
  },
  {
    presetId: 'deepseek', name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', requiresKey: true, preset: 'deepseek',
    blurb: 'DeepSeek chat and reasoning models.',
    models: [chat('deepseek-chat', 'DeepSeek Chat', 128_000), chat('deepseek-reasoner', 'DeepSeek Reasoner', 128_000, { reasoning: true, tools: false })]
  },
  {
    presetId: 'groq', name: 'Groq', protocol: 'openai', baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', requiresKey: true, preset: 'groq',
    blurb: 'Very fast inference for open models.',
    models: [chat('llama-3.3-70b-versatile', 'Llama 3.3 70B', 128_000)]
  },
  {
    presetId: 'mistral', name: 'Mistral', protocol: 'openai', baseUrl: 'https://api.mistral.ai/v1', apiKeyEnv: 'MISTRAL_API_KEY', requiresKey: true, preset: 'mistral',
    blurb: 'Mistral and Codestral models.',
    models: [chat('mistral-large-latest', 'Mistral Large', 128_000), chat('codestral-latest', 'Codestral', 256_000)]
  },
  {
    presetId: 'xai', name: 'xAI', protocol: 'openai', baseUrl: 'https://api.x.ai/v1', apiKeyEnv: 'XAI_API_KEY', requiresKey: true, preset: 'xai',
    blurb: 'Grok models.', models: [chat('grok-4', 'Grok 4', 256_000, { vision: true })]
  },
  {
    presetId: 'together', name: 'Together AI', protocol: 'openai', baseUrl: 'https://api.together.xyz/v1', apiKeyEnv: 'TOGETHER_API_KEY', requiresKey: true, preset: 'together',
    blurb: 'Open models hosted by Together.', models: [chat('meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Llama 3.3 70B Turbo', 128_000)]
  },
  {
    presetId: 'ollama', name: 'Ollama (local)', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', requiresKey: false, local: true, preset: 'ollama',
    blurb: 'Run models on this computer with Ollama. Works fully offline.', models: []
  },
  {
    presetId: 'lmstudio', name: 'LM Studio (local)', protocol: 'openai', baseUrl: 'http://localhost:1234/v1', requiresKey: false, local: true, preset: 'lmstudio',
    blurb: 'Local models served by LM Studio. Works fully offline.', models: []
  },
  {
    presetId: 'llamacpp', name: 'llama.cpp server (local)', protocol: 'openai', baseUrl: 'http://localhost:8080/v1', requiresKey: false, local: true, preset: 'llamacpp',
    blurb: 'A llama.cpp / llama-server instance.', models: []
  },
  {
    presetId: 'custom-openai', name: 'Custom OpenAI-compatible', protocol: 'openai', baseUrl: 'http://localhost:8000/v1', requiresKey: false, preset: 'custom-openai',
    blurb: 'Any server that speaks the OpenAI chat-completions API (vLLM, LiteLLM, self-hosted gateways…).', models: []
  },
  {
    presetId: 'custom-anthropic', name: 'Custom Anthropic-compatible', protocol: 'anthropic', baseUrl: 'http://localhost:8000/v1', requiresKey: false, preset: 'custom-anthropic',
    blurb: 'Any gateway that speaks the Anthropic Messages API.', models: []
  },
  {
    presetId: 'stability', name: 'Stability AI', protocol: 'stability', baseUrl: 'https://api.stability.ai', apiKeyEnv: 'STABILITY_API_KEY', requiresKey: true, preset: 'stability',
    blurb: 'Stable Image generation, editing and upscaling.',
    models: [img('core', 'Stable Image Core'), img('ultra', 'Stable Image Ultra'), img('sd3.5-large', 'Stable Diffusion 3.5 Large')]
  },
  {
    presetId: 'a1111', name: 'Stable Diffusion WebUI (local)', protocol: 'a1111', baseUrl: 'http://127.0.0.1:7860', requiresKey: false, local: true, preset: 'a1111',
    blurb: 'AUTOMATIC1111 / Forge running locally with --api. Works fully offline.', models: [img('default', 'Current checkpoint')]
  }
]

export function presetToProvider(p: ProviderPreset, id?: string): ProviderConfig {
  const { presetId, blurb, ...rest } = p
  void blurb
  return { ...rest, id: id ?? presetId, enabled: true, models: rest.models.map(m => ({ ...m })) }
}
