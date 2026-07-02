'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { makeSandboxPolicy, mapApprovalPolicy, mapSandbox, mapApprovalResponse, humanApprovalResponse } = require('../src/codex/policies');

test('sandbox and approval policy payload mapping preserves app-server values', () => {
  assert.deepEqual(makeSandboxPolicy({
    sandbox: 'workspace-write',
    projectDir: '/project',
    addDirs: ['/extra'],
    network: true,
  }), {
    type: 'workspaceWrite',
    writableRoots: ['/project', '/extra'],
    networkAccess: true,
  });
  assert.deepEqual(makeSandboxPolicy({ sandbox: 'read-only', projectDir: '/project', addDirs: [], network: false }), {
    type: 'readOnly',
    networkAccess: false,
  });
  assert.deepEqual(makeSandboxPolicy({ sandbox: 'danger-full-access', projectDir: '/project', addDirs: [], network: true }), {
    type: 'dangerFullAccess',
    networkAccess: true,
  });
  assert.equal(mapSandbox('custom'), 'custom');
  assert.equal(mapApprovalPolicy('on-request'), 'on-request');
  assert.equal(mapApprovalResponse('accept-for-session'), 'acceptForSession');
  assert.equal(mapApprovalResponse('custom'), 'custom');
  assert.equal(humanApprovalResponse('acceptForSession'), 'accept-for-session');
});
