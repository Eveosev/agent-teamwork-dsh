import { describe, expect, it } from 'vitest'
import { SettingsSchema, assessmentOutcome } from '../src/policy.ts'
import type { Ticket } from '../src/core/model.ts'
import { ticketExecution } from '../src/executor/dsh.ts'
import { ticketCard } from '../src/app/cards.ts'

const profiles = {
  planner: { model: { provider: 'anthropic-gateway', model: 'claude-opus-5-5[1m]' }, preset: 'dsh-superagent-worker-readonly' },
  developer: { model: { provider: 'llm-center', model: 'deepseek-v4.1-flash-mb[1m]' }, preset: 'dsh-superagent-worker-developer' },
}

describe('worker profiles', () => {
  it('parses named profiles and a default that names one of them', () => {
    const settings = SettingsSchema.parse({ executor: { profiles, defaultProfile: 'developer' } })
    expect(settings.executor.profiles.planner!.model).toEqual({ provider: 'anthropic-gateway', model: 'claude-opus-5-5[1m]' })
    expect(settings.executor.defaultProfile).toBe('developer')
  })

  it('refuses a default that names no profile', () => {
    expect(() => SettingsSchema.parse({ executor: { profiles, defaultProfile: 'missing' } })).toThrow('defaultProfile must name one of executor.profiles')
  })

  it('accepts the configured default and records it on the ticket', () => {
    const settings = SettingsSchema.parse({ executor: { profiles, defaultProfile: 'developer' } })
    const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'asked' }
    const assessment = { decision: 'accept' as const, direction, title: 'Fix', scope: 'small', reason: 'asked', intent_evidence: 'quote',
      worktree_name: 'fix-copy', rule_assessments: settings.policy.rules.filter(rule => rule.enabled).map(rule => ({ rule_id: rule.id, matched: true, reason: 'judged' })) }
    expect(assessmentOutcome(assessment, settings, 'explicit')).toMatchObject({ kind: 'accept', profile: 'developer' })
    expect(assessmentOutcome({ ...assessment, profile: 'planner' }, settings, 'explicit')).toMatchObject({ kind: 'accept', profile: 'planner' })
  })

  it('refuses an unknown profile instead of silently using the default', () => {
    const settings = SettingsSchema.parse({ executor: { profiles, defaultProfile: 'developer' } })
    const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'asked' }
    const assessment = { decision: 'accept' as const, direction, title: 'Fix', scope: 'small', reason: 'asked', intent_evidence: 'quote', profile: 'missing',
      worktree_name: 'fix-copy', rule_assessments: settings.policy.rules.filter(rule => rule.enabled).map(rule => ({ rule_id: rule.id, matched: true, reason: 'judged' })) }
    expect(() => assessmentOutcome(assessment, settings, 'explicit')).toThrow('Unknown worker profile "missing"')
  })

  it('puts the profile on execution and the ticket card', () => {
    const settings = SettingsSchema.parse({ executor: { profiles, defaultProfile: 'developer' } })
    const ticket = { id: 'ticket-0123456789abcdef', title: 'Fix', origin: { triggerId: 'tr1', triggerIds: [] }, assignments: [], inputs: [],
      mandate: { strength: 'explicit', policyVersion: 'v1', basis: {}, actor: { source: 'github', id: 'alice' }, scope: '' } } as unknown as Ticket
    const execution = ticketExecution(ticket, { kind: 'accept', title: 'Fix', scope: 'the typo', reason: 'r', name: 'fix-typo', profile: 'planner' },
      settings, '/state')
    expect(execution.profile).toBe('planner')
    const withExecution = { ...ticket, execution }
    expect(ticketCard(withExecution)).toMatchObject({ ticket_id: ticket.id, profile: 'planner' })
    const fromDefault = ticketExecution(ticket, { kind: 'accept', title: 'Fix', scope: 'the typo', reason: 'r', name: 'fix-typo' }, settings, '/state')
    expect(fromDefault.profile).toBe('developer')
  })
})
