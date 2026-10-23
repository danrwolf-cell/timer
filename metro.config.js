const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Web preview only: expo-sqlite on web loads a wa-sqlite .wasm binary through
// Metro. (It also needs cross-origin isolation; see scripts/web-preview-proxy.js.)
config.resolver.assetExts.push('wasm');

module.exports = config;
