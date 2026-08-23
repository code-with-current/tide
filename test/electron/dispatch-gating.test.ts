import { describe, it, expect } from 'vitest';
import {
  getAgent,
  agentRiskTier,
  canDispatchTo,
  effectiveChildTools,
} from '../../electron/agent/agents/registry.js';
import { primaryArg, parseRule, evaluateRules } from '../../electron/agent/permissions/rules.js';

describe('agent dispatch gating', () => {
  it('agentRiskTier returns the max risk tier of an agent\'s allowedTools', () => {
    expect(agentRiskTier(getAgent('general-purpose')!)).toBe('destructive');
    expect(agentRiskTier(getAgent('explore')!)).toBe('read_only');
    expect(agentRiskTier(getAgent('code-reviewer')!)).toBe('read_only');
    expect(agentRiskTier(getAgent('simplifier')!)).toBe('write');
  });

  it('removed single-shot agents are gone from the catalog', () => {
    expect(getAgent('context-manager')).toBeUndefined();
    expect(getAgent('agent-organizer')).toBeUndefined();
    expect(getAgent('workflow-orchestrator')).toBeUndefined();
  });

  it('agentRiskTier maps a write-tier toolset to "write"', () => {
    expect(agentRiskTier({ ...getAgent('explore')!, allowedTools: ['edit_file'] })).toBe('write');
  });

  it('canDispatchTo is false when the agent has no canDispatch', () => {
    expect(canDispatchTo(getAgent('explore')!, 'general-purpose')).toBe(false);
  });

  it('canDispatchTo matches explicit names and "all"', () => {
    const gp = getAgent('general-purpose')!;
    expect(canDispatchTo(gp, 'explore')).toBe(true);
    expect(canDispatchTo(gp, 'nonexistent-agent')).toBe(false);
    expect(canDispatchTo({ ...gp, canDispatch: 'all' }, 'anything')).toBe(true);
  });

  it('effectiveChildTools strips dispatch_agent unless canDispatch is set', () => {
    expect(effectiveChildTools(getAgent('explore')!)).not.toContain('dispatch_agent');
    expect(effectiveChildTools(getAgent('general-purpose')!)).toContain('dispatch_agent');
  });

  it('effectiveChildTools never duplicates dispatch_agent when canDispatch already lists it', () => {
    const co = getAgent('codebase-orchestrator')!;
    const tools = effectiveChildTools({ ...co, allowedTools: [...co.allowedTools!, 'dispatch_agent'] });
    expect(tools.filter((t) => t === 'dispatch_agent')).toHaveLength(1);
  });
});

describe('dispatch_agent permission rules', () => {
  it('primaryArg uses the agent name', () => {
    expect(primaryArg('dispatch_agent', { name: 'general-purpose', task: 'x' })).toBe('general-purpose');
  });

  it('a deny rule with an agent-name glob blocks dispatch', () => {
    const rules = { allow: [], deny: [parseRule('dispatch_agent(heavy-*)')!] };
    expect(evaluateRules(rules, 'dispatch_agent', { name: 'heavy-refactor' })).toBe('deny');
    expect(evaluateRules(rules, 'dispatch_agent', { name: 'explore' })).toBe(null);
  });
});
