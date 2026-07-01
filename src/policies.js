'use strict';

function mapApprovalPolicy(v) {
  return v;
}
function mapSandbox(v) {
  return ({
    'read-only': 'readOnly',
    'workspace-write': 'workspaceWrite',
    'danger-full-access': 'dangerFullAccess',
  })[v] || v;
}
function mapApprovalResponse(v) {
  return ({
    'manual': 'manual',
    'accept': 'accept',
    'accept-for-session': 'acceptForSession',
    'decline': 'decline',
    'cancel': 'cancel',
  })[v] || v;
}
function humanApprovalResponse(v) {
  return ({ acceptForSession: 'accept-for-session' })[v] || v;
}
function makeSandboxPolicy(opts) {
  const type = mapSandbox(opts.sandbox);
  const policy = { type };
  if (type === 'workspaceWrite') {
    policy.writableRoots = [opts.projectDir, ...opts.addDirs];
    policy.networkAccess = opts.network;
  } else if (type === 'readOnly') {
    policy.networkAccess = opts.network;
  } else if (type === 'dangerFullAccess') {
    policy.networkAccess = opts.network;
  }
  return policy;
}

module.exports = {
  mapApprovalPolicy,
  mapSandbox,
  mapApprovalResponse,
  humanApprovalResponse,
  makeSandboxPolicy,
};
