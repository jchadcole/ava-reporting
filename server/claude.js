'use strict';
// Shared Claude call for the analyses that read masked transcripts (escalation reasons,
// AVA intents). Nothing is sent anywhere unless a provider is configured.
//
// LLM_PROVIDER picks where the calls go:
//   anthropic  Anthropic's API (needs ANTHROPIC_API_KEY). The default when that key is set.
//   bedrock    Amazon Bedrock in your own AWS account, for example AWS GovCloud (US).
//              Region from BEDROCK_REGION or AWS_REGION; credentials from the normal AWS
//              chain (AWS_PROFILE, SSO, an instance or task role). No Anthropic key is used.
//   off        No Claude calls. The default when nothing is set.
//
// Bedrock options:
//   BEDROCK_API=mantle (default, Bedrock's Messages API endpoint) or invoke (bedrock-runtime
//   InvokeModel, for regions or accounts where only that endpoint is available).
//   BEDROCK_BASE_URL overrides the endpoint, for a FIPS or VPC interface endpoint.

const PROVIDERS = ['anthropic', 'bedrock', 'off'];

function provider(env = process.env) {
  const p = (env.LLM_PROVIDER || '').trim().toLowerCase();
  if (!p) return env.ANTHROPIC_API_KEY ? 'anthropic' : 'off';
  if (!PROVIDERS.includes(p)) {
    console.warn(`Unknown LLM_PROVIDER "${env.LLM_PROVIDER}"; Claude analysis is off. Use ${PROVIDERS.join(', ')}.`);
    return 'off';
  }
  return p;
}

function bedrockRegion(env = process.env) {
  return env.BEDROCK_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || '';
}

function claudeEnabled(env = process.env) {
  const p = provider(env);
  if (p === 'anthropic') return Boolean(env.ANTHROPIC_API_KEY);
  if (p === 'bedrock') return Boolean(bedrockRegion(env));
  return false;
}

// Short description for the page and the startup log. Never includes credentials.
function providerInfo(env = process.env) {
  const p = provider(env);
  if (p === 'bedrock') return { provider: p, region: bedrockRegion(env) || null, api: bedrockApi(env) };
  return { provider: p };
}

const bedrockApi = (env = process.env) => ((env.BEDROCK_API || 'mantle').toLowerCase() === 'invoke' ? 'invoke' : 'mantle');

// Bedrock names Anthropic models with an "anthropic." prefix. A full Bedrock model ID,
// inference profile ID (e.g. "us-gov.anthropic...") or ARN is used as given.
function modelId(model, env = process.env) {
  if (provider(env) !== 'bedrock') return model;
  return /[.:]/.test(model) ? model : `anthropic.${model}`;
}

let client;
function getClient() {
  if (client) return client;
  if (provider() === 'bedrock') {
    const { AnthropicBedrockMantle, AnthropicBedrock } = require('@anthropic-ai/bedrock-sdk');
    const opts = { awsRegion: bedrockRegion() };
    if (process.env.BEDROCK_BASE_URL) opts.baseURL = process.env.BEDROCK_BASE_URL;
    client = bedrockApi() === 'invoke' ? new AnthropicBedrock(opts) : new AnthropicBedrockMantle(opts);
  } else {
    const Anthropic = require('@anthropic-ai/sdk');
    client = new (Anthropic.default || Anthropic)();
  }
  return client;
}

// The request body for one call. Server-side refusal fallbacks exist only on Anthropic's
// API, so Bedrock requests leave them out; a Bedrock refusal is recorded as refused.
function buildRequest({ model, system, input, schema, maxTokens = 4000 }, env = process.env) {
  const body = {
    model: modelId(model, env),
    max_tokens: maxTokens,
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: input }],
  };
  if (provider(env) === 'anthropic') {
    body.betas = ['server-side-fallback-2026-07-01'];
    body.fallbacks = 'default';
  }
  return body;
}

// Ask for one JSON object matching `schema`. Returns { refused, data, model, usage }.
async function askJson(args) {
  const response = await getClient().beta.messages.create(buildRequest(args));
  const usage = { input: response.usage?.input_tokens ?? null, output: response.usage?.output_tokens ?? null };
  if (response.stop_reason === 'refusal') return { refused: true, data: null, model: response.model, usage };
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { refused: false, data: JSON.parse(text), model: response.model, usage };
}

// A bad key, missing AWS permission or exhausted credit fails every call, so callers stop at the first one.
const isFatalClaudeError = (err) =>
  [401, 403].includes(err.status) || /credit balance|AccessDenied|UnrecognizedClient|ExpiredToken|Could not load credentials/i.test(`${err.name} ${err.message}`);

// Genesys Cloud's FedRAMP environment lives on us-gov hosts (e.g. use2.us-gov-pure.cloud).
// Data from such an org must never go to Anthropic's commercial API, which is not FedRAMP
// authorized. GENESYS_<NAME>_GOVERNMENT=true marks other orgs the same way, and
// GENESYS_<NAME>_ALLOW_ANTHROPIC=true lets a test org through anyway, with a warning.
function isGovernmentOrg(org) {
  return Boolean(org?.government) || /us-gov|fedramp/i.test(org?.region || '');
}

// Why Claude may not read this org's transcripts, or null when it may.
function blockedForOrg(org, env = process.env) {
  if (isGovernmentOrg(org) && provider(env) === 'anthropic' && !org.allowAnthropic) {
    return 'This is a government (FedRAMP) org, and Anthropic’s API is not FedRAMP authorized. Set LLM_PROVIDER=bedrock with a GovCloud region to analyze it.';
  }
  return null;
}

// A government org that was explicitly allowed onto Anthropic's API (GENESYS_<NAME>_ALLOW_ANTHROPIC=true).
function overrideWarning(org, env = process.env) {
  if (isGovernmentOrg(org) && provider(env) === 'anthropic' && org.allowAnthropic) {
    return 'Test override: this government org is being analyzed through Anthropic’s API, which is not FedRAMP authorized.';
  }
  return null;
}

module.exports = { claudeEnabled, askJson, isFatalClaudeError, provider, providerInfo, modelId, buildRequest, isGovernmentOrg, blockedForOrg, overrideWarning };
