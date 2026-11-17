/**
 * One call to the AI (an OpenAI-compatible chat endpoint) that must answer a JSON object.
 *
 *   AI_BASE_URL   https://api.vilao.ai/v1
 *   AI_API_KEY    sk-...            (never sent to the browser)
 *   AI_MODEL      deepseek-flash
 *
 * Returns null when AI is not configured, times out or answers something that is not JSON:
 * callers must work without it.
 */
const REASONING_ROOM = 2000;
export const aiConfigured = () => !!(process.env.AI_BASE_URL && process.env.AI_API_KEY);

export async function aiJson<T = any>(
	messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
	opts: { maxTokens?: number; timeoutMs?: number; temperature?: number; logger?: any } = {},
): Promise<T | null> {
	if (!aiConfigured()) return null;
	const base = String(process.env.AI_BASE_URL).replace(/\/+$/, '');
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 25000);
	try {
		const res = await fetch(`${base}/chat/completions`, {
			method: 'POST',
			signal: controller.signal,
			headers: { Authorization: `Bearer ${process.env.AI_API_KEY}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: process.env.AI_MODEL || 'deepseek-flash',
				messages,
				temperature: opts.temperature ?? 0.2,
				// The model thinks first (reasoning_content) and that counts against max_tokens: with a
				// tight limit the answer is empty or cut off. Leave room for the thinking.
				max_tokens: (opts.maxTokens ?? 800) + REASONING_ROOM,
				response_format: { type: 'json_object' },
			}),
		});
		if (!res.ok) {
			opts.logger?.warn?.(`[ai] HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
			return null;
		}
		const data: any = await res.json();
		const content = String(data?.choices?.[0]?.message?.content || '')
			.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
		if (!content) {
			opts.logger?.warn?.(`[ai] empty answer (finish_reason=${data?.choices?.[0]?.finish_reason})`);
			return null;
		}
		try {
			return JSON.parse(content) as T;
		} catch {
			const m = content.match(/\{[\s\S]*\}/); // JSON wrapped in some text
			if (m) return JSON.parse(m[0]) as T;
			throw new Error(`not JSON (finish_reason=${data?.choices?.[0]?.finish_reason}): ${content.slice(0, 120)}`);
		}
	} catch (error) {
		opts.logger?.warn?.(`[ai] call failed: ${String(error)}`);
		return null;
	} finally {
		clearTimeout(timer);
	}
}
