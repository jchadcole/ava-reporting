'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { provider, claudeEnabled, modelId, buildRequest, isGovernmentOrg, blockedForOrg } = require('../server/claude');

const args = { model: 'claude-opus-5-5', system: 'sys', input: 'hi', schema: { type: 'object' } };

test('the provider defaults to Anthropic only when a key is set', () => {
  assert.equal(provider({}), 'off');
  assert.equal(provider({ ANTHROPIC_API_KEY: 'k' }), 'anthropic');
  assert.equal(provider({ LLM_PROVIDER: 'Bedrock', ANTHROPIC_API_KEY: 'k' }), 'bedrock');
  assert.equal(provider({ LLM_PROVIDER: 'openai' }), 'off');
});

test('Bedrock needs a region, not an Anthropic key', () => {
  assert.equal(claudeEnabled({ LLM_PROVIDER: 'bedrock' }), false);
  assert.equal(claudeEnabled({ LLM_PROVIDER: 'bedrock', AWS_REGION: 'us-gov-west-1' }), true);
  assert.equal(claudeEnabled({ LLM_PROVIDER: 'anthropic' }), false);
});

test('Bedrock model IDs get the anthropic. prefix unless already qualified', () => {
  const env = { LLM_PROVIDER: 'bedrock', AWS_REGION: 'us-gov-west-1' };
  assert.equal(modelId('claude-opus-5-5', env), 'anthropic.claude-opus-5-5');
  assert.equal(modelId('us-gov.anthropic.claude-sonnet-5', env), 'us-gov.anthropic.claude-sonnet-5');
  assert.equal(modelId('arn:aws-us-gov:bedrock:us-gov-west-1::foundation-model/x', env), 'arn:aws-us-gov:bedrock:us-gov-west-1::foundation-model/x');
  assert.equal(modelId('claude-opus-5-5', { ANTHROPIC_API_KEY: 'k' }), 'claude-opus-5-5');
});

test('server-side fallbacks are sent to Anthropic only', () => {
  const a = buildRequest(args, { ANTHROPIC_API_KEY: 'k' });
  assert.equal(a.fallbacks, 'default');
  assert.deepEqual(a.betas, ['server-side-fallback-2026-07-01']);
  const b = buildRequest(args, { LLM_PROVIDER: 'bedrock', AWS_REGION: 'us-gov-west-1' });
  assert.equal(b.fallbacks, undefined);
  assert.equal(b.betas, undefined);
  assert.equal(b.model, 'anthropic.claude-opus-5-5');
  assert.equal(b.output_config.format.type, 'json_schema');
});

test('government orgs never go to the Anthropic API', () => {
  const gov = { region: 'use2.us-gov-pure.cloud' };
  assert.equal(isGovernmentOrg(gov), true);
  assert.equal(isGovernmentOrg({ region: 'mypurecloud.com' }), false);
  assert.equal(isGovernmentOrg({ region: 'mypurecloud.com', government: true }), true);
  assert.match(blockedForOrg(gov, { ANTHROPIC_API_KEY: 'k' }), /FedRAMP/);
  assert.equal(blockedForOrg(gov, { LLM_PROVIDER: 'bedrock', AWS_REGION: 'us-gov-west-1' }), null);
  assert.equal(blockedForOrg({ region: 'mypurecloud.com' }, { ANTHROPIC_API_KEY: 'k' }), null);
});
