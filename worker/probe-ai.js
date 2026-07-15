import { requestAiChat } from './index.js';

const apiKey = process.env.AI_API_KEY;
const baseUrl = process.env.AI_API_BASE_URL || 'https://hk.testvideo.site/v1';
const model = process.env.AI_MODEL || 'gpt-5.5';

if (!apiKey) throw new Error('AI_API_KEY is required');

const content = await requestAiChat({
  apiKey,
  baseUrl,
  model,
  messages: [
    { role: 'system', content: '只回复 OK。' },
    { role: 'user', content: '连通性测试。' },
  ],
  temperature: 0,
  maxTokens: 16,
  timeoutMs: 45000,
  maxAttempts: 1,
});

if (!content.trim()) throw new Error('AI probe returned empty content');
console.log(`AI probe succeeded: model=${model}, response=${content.trim().slice(0, 100)}`);
