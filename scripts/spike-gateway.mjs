#!/usr/bin/env node
/** Checks the two auth styles an Anthropic Messages gateway may require, without storing a token. */
const base = process.env.ANTHROPIC_BASE_URL ?? 'https://llm-center.modelbest.co'
const token = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.LLM_CENTER_API_KEY
const model = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5-5'
if (!token) {
  console.error('Set ANTHROPIC_AUTH_TOKEN (or LLM_CENTER_API_KEY) first; the token is not read from a file.')
  process.exit(2)
}
const body = JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word ok.' }] })
const attempts = [
  ['x-api-key', { 'content-type': 'application/json', 'x-api-key': token, 'anthropic-version': '2023-06-01' }],
  ['Authorization: Bearer', { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' }],
  ['both', { 'content-type': 'application/json', 'x-api-key': token, authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' }],
]
let ok = false
for (const [label, headers] of attempts) {
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/v1/messages`, { method: 'POST', headers, body })
    const text = await response.text()
    console.log(`${label}: HTTP ${response.status} ${text.slice(0, 300)}`)
    if (response.ok) ok = true
  } catch (error) {
    console.log(`${label}: ${String(error)}`)
  }
}
process.exit(ok ? 0 : 1)
