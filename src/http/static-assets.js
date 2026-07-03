'use strict';

const path = require('node:path');

const ROOT_STATIC_ASSETS = new Set(['app.js', 'styles.css']);
const SRC_ASSET_PREFIX = 'src/';
const BIN_ASSET_PREFIX = 'assets/';
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
  if (!name.startsWith(SRC_ASSET_PREFIX) && !name.startsWith(BIN_ASSET_PREFIX)) return false;
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

module.exports = {
  rawPathname,
  staticAssetName
};
