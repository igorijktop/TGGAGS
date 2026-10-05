import type { ModelInfo } from '../../../shared/settings'

/** Best-effort capability guess from a model id (used when a server only lists ids). */
export function guessModelInfo(id: string): ModelInfo {
  const l = id.toLowerCase()
  let modality: ModelInfo['modality'] = 'chat'
  if (/embed|bge-|e5-|nomic-embed|text-embedding/.test(l)) modality = 'embedding'
  else if (/dall-e|gpt-image|imagen|stable-diffusion|sdxl|flux|sd3|stable-image/.test(l)) modality = 'image'
  const vision = /gpt-4o|gpt-4\.1|gpt-5|o\d|vision|llava|claude|gemini|pixtral|qwen.*vl|qwen2\.5vl|llama3\.2-vision|llama-3\.2-.*vision|gemma-?3|minicpm-v|moondream|grok-4|mistral-(small|medium|large)/.test(l)
  const reasoning = /^o\d|gpt-5|reason|r1|thinking|gemini-2\.5|gemini-3|claude-(fable|opus-[45]|sonnet-[45]|haiku-4)|qwq|qwen3|deepseek-r/.test(l)
  const noTools = /embed|dall-e|image|reasoner|r1\b|gemma|phi-?[12]|llava|tinyllama/.test(l)
  const ctxGuess = /gemini/.test(l) ? 1_000_000 : /claude-(fable|opus-5|sonnet-5)/.test(l) ? 1_000_000 : /gpt-4\.1/.test(l) ? 1_000_000 : /gpt-5/.test(l) ? 400_000 : /claude/.test(l) ? 200_000 : /llama-?3\.[123]|qwen|mistral|deepseek/.test(l) ? 128_000 : 32_000
  return { id, name: id, modality, vision, reasoning, tools: modality === 'chat' && !noTools, contextWindow: modality === 'chat' ? ctxGuess : undefined }
}
