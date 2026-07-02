'use strict';

const path = require('node:path');

const { STATIC_TYPES } = require('../shared/config');

const ROOT_STATIC_ASSETS = new Set(['app.js', 'styles.css']);
const SRC_ASSET_PREFIX = 'src/';
const SRC_ASSET_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.css',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.map',
]);

function rawPathname(url) {
  const value = String(url || '');
  const index = value.search(/[?#]/);
  return index === -1 ? value : value.slice(0, index);
}

function decodePathname(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch (_) {
    return null;
  }
}

function isSafeNormalizedPath(decoded, normalized) {
  if (!decoded || decoded[0] !== '/' || decoded.includes('\0')) return false;
  if (normalized !== decoded) return false;
  return true;
}

function isAllowedSrcAsset(name) {
  if (!name.startsWith(SRC_ASSET_PREFIX)) return false;
  if (name.endsWith('/') || name.includes('//')) return false;

  const parts = name.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false;

  return SRC_ASSET_EXTENSIONS.has(path.extname(name));
}

function staticAssetName(pathname) {
  const decoded = decodePathname(pathname);
  const normalized = decoded ? path.posix.normalize(decoded) : null;

  if (!isSafeNormalizedPath(decoded, normalized)) return null;

  const name = normalized.slice(1);
  if (ROOT_STATIC_ASSETS.has(name)) return name;
  if (isAllowedSrcAsset(name)) return name;

  return null;
}

function staticContentType(name) {
  const ext = path.extname(name);

  if (ext === '.js' || ext === '.mjs') return STATIC_TYPES[ext] || 'text/javascript; charset=utf-8';
  if (ext === '.css') return STATIC_TYPES[ext] || 'text/css; charset=utf-8';
  if (ext === '.svg') return STATIC_TYPES[ext] || 'image/svg+xml';

  return STATIC_TYPES[ext] || 'application/octet-stream';
}

module.exports = {
  rawPathname,
  staticAssetName,
  staticContentType,
};
