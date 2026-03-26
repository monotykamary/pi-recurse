import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import {
  getCurrentDepth,
  getMaxDepth,
  getCallCount,
  checkDepthGuard,
  checkCallGuard,
  checkTimeoutGuard,
  checkBudgetGuard,
  buildChildEnvironment,
  generateTraceId,
  getRecursiveSystemPrompt,
  DEFAULTS,
} from '../lib.js';

describe('Guardrail utilities', () => {
  beforeEach(() => {
    // Clear environment
    delete process.env.RLM_DEPTH;
    delete process.env.RLM_MAX_DEPTH;
    delete process.env.RLM_CALL_COUNT;
    delete process.env.RLM_MAX_CALLS;
    delete process.env.RLM_TIMEOUT;
    delete process.env.RLM_START_TIME;
    delete process.env.RLM_BUDGET;
  });

  describe('getCurrentDepth', () => {
    it('returns 0 when RLM_DEPTH is not set', () => {
      expect(getCurrentDepth()).toBe(0);
    });

    it('returns parsed integer from RLM_DEPTH', () => {
      process.env.RLM_DEPTH = '3';
      expect(getCurrentDepth()).toBe(3);
    });

    it('handles negative values', () => {
      process.env.RLM_DEPTH = '-1';
      expect(getCurrentDepth()).toBe(-1);
    });
  });

  describe('getMaxDepth', () => {
    it('returns DEFAULTS.MAX_DEPTH when not set', () => {
      expect(getMaxDepth()).toBe(DEFAULTS.MAX_DEPTH);
    });

    it('returns parsed RLM_MAX_DEPTH', () => {
      process.env.RLM_MAX_DEPTH = '5';
      expect(getMaxDepth()).toBe(5);
    });
  });

  describe('checkDepthGuard', () => {
    it('allows when depth < max', () => {
      process.env.RLM_DEPTH = '1';
      process.env.RLM_MAX_DEPTH = '3';
      const result = checkDepthGuard();
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('blocks when depth >= max', () => {
      process.env.RLM_DEPTH = '3';
      process.env.RLM_MAX_DEPTH = '3';
      const result = checkDepthGuard();
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Max depth exceeded');
    });
  });

  describe('checkCallGuard', () => {
    it('allows when calls < limit', () => {
      process.env.RLM_CALL_COUNT = '50';
      process.env.RLM_MAX_CALLS = '100';
      const result = checkCallGuard();
      expect(result.allowed).toBe(true);
    });

    it('blocks when calls >= limit', () => {
      process.env.RLM_CALL_COUNT = '100';
      process.env.RLM_MAX_CALLS = '100';
      const result = checkCallGuard();
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Max calls exceeded');
    });

    it('uses env RLM_MAX_CALLS when not provided', () => {
      process.env.RLM_CALL_COUNT = '99';
      process.env.RLM_MAX_CALLS = '100';
      expect(checkCallGuard().allowed).toBe(true);
    });
  });

  describe('checkTimeoutGuard', () => {
    it('allows when elapsed < timeout', () => {
      process.env.RLM_START_TIME = String(Date.now() - 5000); // 5 seconds ago
      process.env.RLM_TIMEOUT = '600'; // 10 minutes
      const result = checkTimeoutGuard();
      expect(result.allowed).toBe(true);
    });

    it('blocks when elapsed > timeout', () => {
      process.env.RLM_START_TIME = String(Date.now() - 700000); // 700 seconds ago
      process.env.RLM_TIMEOUT = '600'; // 10 minutes
      const result = checkTimeoutGuard();
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Timeout exceeded');
    });
  });

  describe('checkBudgetGuard', () => {
    it('allows with unlimited budget when RLM_BUDGET not set', () => {
      const result = checkBudgetGuard();
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(Infinity);
    });

    it('calculates remaining correctly', () => {
      process.env.RLM_BUDGET = '1.00';
      // Note: loadAccumulatedCost will return 0 since no file set
      const result = checkBudgetGuard();
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeCloseTo(1.0);
    });

    it('blocks when budget exhausted', () => {
      process.env.RLM_BUDGET = '0.01';
      // Mock spent amount by setting cost file via env
      const costFile = '/tmp/test-cost-' + Date.now();
      process.env.RLM_COST_FILE = costFile;
      fs.writeFileSync(costFile, '0.02', 'utf-8');

      try {
        const result = checkBudgetGuard();
        expect(result.allowed).toBe(false);
      } finally {
        // Cleanup
        try {
          fs.unlinkSync(costFile);
        } catch {
          // Ignore cleanup errors
        }
      }
    });
  });

  describe('buildChildEnvironment', () => {
    it('increments depth', () => {
      process.env.RLM_DEPTH = '2';
      const env = buildChildEnvironment();
      expect(env.RLM_DEPTH).toBe('3');
    });

    it('increments call count', () => {
      process.env.RLM_CALL_COUNT = '10';
      const env = buildChildEnvironment();
      expect(env.RLM_CALL_COUNT).toBe('11');
    });

    it('preserves trace ID', () => {
      process.env.RLM_TRACE_ID = 'abc123';
      const env = buildChildEnvironment();
      expect(env.RLM_TRACE_ID).toBe('abc123');
    });

    it('generates new trace ID if not set', () => {
      delete process.env.RLM_TRACE_ID;
      const env = buildChildEnvironment();
      expect(env.RLM_TRACE_ID).toBeDefined();
      expect(env.RLM_TRACE_ID!.length).toBeGreaterThan(0);
    });
  });

  describe('generateTraceId', () => {
    it('returns a non-empty string', () => {
      const id = generateTraceId();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('returns different values on subsequent calls', () => {
      const id1 = generateTraceId();
      const id2 = generateTraceId();
      expect(id1).not.toBe(id2);
    });
  });

  describe('getRecursiveSystemPrompt', () => {
    it('includes depth information', () => {
      process.env.RLM_MAX_DEPTH = '5';
      const basePrompt = 'You are an AI assistant.';
      const result = getRecursiveSystemPrompt(basePrompt, 2);

      expect(result).toContain('depth 2');
      expect(result).toContain('RLM_MAX_DEPTH=5');
      expect(result).toContain(basePrompt);
    });

    it('includes sub-agent guidance for depth > 0', () => {
      const result = getRecursiveSystemPrompt('Base.', 1);
      expect(result).toContain('sub-agents');
      expect(result).toContain('Prefer **direct answers**');
    });

    it('includes root-agent guidance for depth 0', () => {
      const result = getRecursiveSystemPrompt('Base.', 0);
      expect(result).toContain('root agents');
      expect(result).toContain('Decompose large tasks');
    });
  });
});
