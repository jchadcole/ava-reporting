'use strict';
// Shared Claude call for the analyses that read masked transcripts (escalation reasons,
// AVA intents). Nothing is sent to Anthropic unless ANTHROPIC_API_KEY is set.

let anthropic;
function claudeEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
function getAnthropic() {
  if (!anthropic) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new (Anthropic.default || Anthropic)();
  }
  return anthropic;
}

// Ask for one JSON object matching `schema`. Returns { refused, data, model, usage }.
async function askJson({ model, system, input, schema, maxTokens = 4000 }) {
  const response = await getAnthropic().beta.messages.create({
    model,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: input }],
  });
  const usage = { input: response.usage?.input_tokens ?? null, output: response.usage?.output_tokens ?? null };
  if (response.stop_reason === 'refusal') return { refused: true, data: null, model: response.model, usage };
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { refused: false, data: JSON.parse(text), model: response.model, usage };
}

// A bad key or exhausted credit fails every call, so callers stop at the first one.
const isFatalClaudeError = (err) => [401, 403].includes(err.status) || /credit balance/i.test(err.message);

module.exports = { claudeEnabled, askJson, isFatalClaudeError };
