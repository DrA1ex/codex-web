'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {ASSET_DIRS} = require('../shared/config');

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'cmd' : 'xdg-open');
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(cmd, args, {detached: true, stdio: 'ignore'});
  child.unref();
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {'Content-Type': contentType, 'Cache-Control': 'public, max-age=0, must-revalidate'});
  res.end(text);
}

function sendBinary(res, status, data, contentType = 'application/octet-stream') {
  res.writeHead(status, {'Content-Type': contentType, 'Cache-Control': 'public, max-age=0, must-revalidate'});
  res.end(data);
}

function sendJson(res, status, obj) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(obj));
}

async function readAssetFile(name, encoding) {
  for (const dir of ASSET_DIRS) {
    const file = path.join(dir, name);
    try {
      return await fsp.readFile(file, encoding);
    } catch (_) {
    }
  }
  throw new Error(`Missing web asset: ${name}`);
}

function readTextAsset(name) {
  return readAssetFile(name, 'utf8');
}

function readBinaryAsset(name) {
  return readAssetFile(name);
}

class HttpRequestError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpRequestError';
    this.statusCode = statusCode;
  }
}

function readJsonBody(req, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(0, options.maxBytes) : 20 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      req.removeListener?.('data', onData);
      req.removeListener?.('end', onEnd);
      req.removeListener?.('error', onError);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (typeof req.resume === 'function') req.resume();
      reject(err);
    };
    const onData = (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        fail(new HttpRequestError(413, 'Request body too large'));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8')));
      } catch (_) {
        reject(new HttpRequestError(400, 'Invalid JSON body'));
      }
    };
    const onError = (err) => fail(err);

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

module.exports = {
  openBrowser,
  sendText,
  sendBinary,
  sendJson,
  readAsset: readTextAsset,
  readBinaryAsset,
  readJsonBody,
  HttpRequestError,
};
