export const FORMAT_VERSION = 'plain-text-v2';

const PAYLOAD_KEYS = ['text', 'translation', 'translatedText'] as const;
const METADATA_KEYS = new Set(['documentTitle', 'section']);
const FORMAT_ERROR = '模型返回了不符合要求的译文格式，请重试此段或更换模型。';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStructuredSource(source: string): boolean {
  const text = source.trim();
  if (/^```[^\r\n`]*\r?\n[\s\S]*\r?\n```$/.test(text)) return true;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) || Array.isArray(value);
  } catch {
    // JSONC and object-literal examples are source material too. Preserve them
    // rather than interpreting their keys as the extension's response envelope.
    return /^\{[\s\S]*\}$/.test(text) && /(?:"[^"\n]+"|[A-Za-z_$][\w$]*)\s*:/.test(text);
  }
}

export function normalizeTranslationOutput(output: string, source: string): string {
  if (typeof output !== 'string' || !output.trim()) throw new Error('模型未返回有效译文。');
  const text = output.trim();
  if (isStructuredSource(source)) return text;

  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
  const candidate = fence ? fence[1].trim() : text;
  let value: unknown;
  try { value = JSON.parse(candidate) as unknown; }
  catch {
    if (/^(?:(?:以下(?:是)?(?:译文|翻译结果)|译文|翻译结果)\s*[:：]\s*)?\{\s*["'“”]?(?:documentTitle|section|text|translation|translatedText)["'“”]?\s*:/.test(candidate)) {
      throw new Error(FORMAT_ERROR);
    }
    return text;
  }
  if (!isRecord(value)) {
    if (Array.isArray(value)) throw new Error(FORMAT_ERROR);
    return text;
  }

  const payloads = PAYLOAD_KEYS.filter(key => Object.hasOwn(value, key));
  const validKeys = Object.keys(value).every(key => PAYLOAD_KEYS.some(payload => payload === key) || METADATA_KEYS.has(key));
  const validMetadata = [...METADATA_KEYS].every(key => !Object.hasOwn(value, key) || typeof value[key] === 'string');
  if (payloads.length !== 1 || !validKeys || !validMetadata) throw new Error(FORMAT_ERROR);
  const translation = value[payloads[0]];
  if (typeof translation !== 'string' || !translation.trim()) throw new Error(FORMAT_ERROR);
  return translation.trim();
}
