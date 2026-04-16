#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const projectRoot = '/Users/klauxs/.claude/plugins/marketplaces/evermem/.worktrees/memhub-user-groups';

function runScript(scriptName) {
  return spawnSync('node', [`scripts/${scriptName}`], {
    cwd: projectRoot,
    env: {
      ...process.env,
      EVERMEM_API_URL: 'http://127.0.0.1:9'
    },
    encoding: 'utf8'
  });
}

test('test-save-memories handles missing API key when API URL is configured', () => {
  const result = runScript('test-save-memories.js');

  assert.equal(/Cannot read properties of null \(reading 'slice'\)/.test(result.stderr), false);
  assert.match(result.stdout, /API URL:/);
});

test('test-retrieve-memories handles missing API key when API URL is configured', () => {
  const result = runScript('test-retrieve-memories.js');

  assert.equal(/Cannot read properties of null \(reading 'slice'\)/.test(result.stderr), false);
  assert.match(result.stdout, /API URL:/);
});
