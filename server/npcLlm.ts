// Asynchronous HTTP client for querying the local SLM inference server (llama-server)
// running in parallel with the game server on the Raspberry Pi (or dev machine).

export type BotAction =
  | { action: 'GATHER'; target_type?: 'scrap' | 'loot'; target_id?: number; chirp?: string }
  | { action: 'DEPOSIT'; chest_id?: number; chirp?: string }
  | { action: 'FOLLOW'; target?: 'player'; distance?: number; chirp?: string }
  | { action: 'FLEE'; destination?: 'base' | 'shelter'; chirp?: string }
  | { action: 'WAIT'; duration_s?: number; chirp?: string };

export type LlmDecisionResponse = {
  action: 'GATHER' | 'DEPOSIT' | 'FOLLOW' | 'FLEE' | 'WAIT';
  target_id?: number;
  target_type?: 'scrap' | 'loot' | 'chest';
  thought?: string;
  chirp?: string;
};

const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['GATHER', 'DEPOSIT', 'FOLLOW', 'FLEE', 'WAIT'] },
    target_id: { type: 'integer' },
    target_type: { type: 'string', enum: ['scrap', 'loot', 'chest'] },
    thought: { type: 'string' },
  },
  required: ['action'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are AUTON-1, a scavenger robot companion in a desert wasteland. Output only valid JSON.
Decision rules:
1. If hazard or sandstorm: action="FLEE".
2. If cargo is full: action="DEPOSIT".
3. If instruction="follow" or ownerDist > 25m: action="FOLLOW".
4. If scrap available: action="GATHER", target_id=<number>.
5. Otherwise: action="WAIT" or "FOLLOW".`;

export async function queryBotLlm(situationJson: string): Promise<LlmDecisionResponse | null> {
  const url = process.env.LLM_URL ?? 'http://127.0.0.1:8080/v1/chat/completions';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000); // 2-second timeout for Raspberry Pi CPU

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: process.env.LLM_MODEL ?? 'smollm2-360m',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: situationJson },
        ],
        temperature: 0.15,
        max_tokens: 60,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'bot_decision', schema: ACTION_SCHEMA },
        },
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    return JSON.parse(content) as LlmDecisionResponse;
  } catch {
    // If inference server is unreachable, offline, or timed out, gracefully return null
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
