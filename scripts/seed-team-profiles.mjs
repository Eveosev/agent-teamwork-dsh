#!/usr/bin/env node
/** Applies examples/team-profiles.json to a running panel, without storing any credential. */
import { readFileSync } from 'node:fs'
const base = (process.env.TEAMWORK_BASE_URL ?? 'http://127.0.0.1:3092').replace(/\/$/, '')
const defaultProfile = process.env.DEFAULT_PROFILE ?? 'developer'
const profiles = JSON.parse(readFileSync(new URL('../examples/team-profiles.json', import.meta.url), 'utf8'))
const headers = { origin: base, 'x-orchestrator-request': '1' }
const view = await (await fetch(`${base}/orchestrator/api/settings`, { headers })).json()
const block = view?.blocks?.executor
if (!block) { console.error('The panel did not return blocks.executor; is the dsh-superagent profile running?'); process.exit(2) }
const response = await fetch(`${base}/orchestrator/api/settings/executor`, { method: 'PUT',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({ value: { ...block.value, defaultProfile, profiles }, revision: block.revision }) })
const text = await response.text()
console.log(response.status, text.slice(0, 800))
if (!response.ok) process.exit(1)
console.log(`Applied ${Object.keys(profiles).length} worker profiles; default ${defaultProfile}.`)
