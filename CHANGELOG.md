# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-03-24

### Added
- Initial implementation of `pi-recurse` extension
- Three execution modes: `single`, `parallel`, and `chain`
- Programmatic parallel spawning (no LLM involvement in loop)
- Depth-based guardrails (RLM_MAX_DEPTH, RLM_DEPTH)
- Call count tracking (RLM_MAX_CALLS)
- Timeout enforcement (RLM_TIMEOUT)
- Budget tracking (RLM_BUDGET)
- Tool disabling at configurable depth threshold
- System prompt injection via `before_agent_start`
- Status bar indicator showing current depth
- Custom tool rendering for TUI
- `/recurse-status` command for debugging
- Comprehensive test suite
