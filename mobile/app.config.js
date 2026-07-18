// Dynamic Expo config.
//
// Everything still lives in app.json — this file only adds ONE runtime value:
// the tunneled API base URL, when running via `npm run start:remote`.
//
// Why not EXPO_PUBLIC_API_BASE? That is inlined into the JS bundle at build time,
// so a changing tunnel URL would require clearing Metro's cache every run (slow,
// and it worsens the ngrok tunnel race). `extra` travels in the Expo MANIFEST,
// which Metro regenerates on every request from this file — so the app reads a
// fresh URL at RUNTIME with no rebuild. src/api.ts prefers extra.apiBase.
//
// When EXPO_TUNNEL_API_BASE is unset (normal `expo start`), nothing is added and
// the app falls back to deriving the API from the Metro host, exactly as before.

const appJson = require("./app.json");

module.exports = () => {
  const expo = { ...appJson.expo };
  const apiBase = process.env.EXPO_TUNNEL_API_BASE;
  expo.extra = {
    ...(expo.extra || {}),
    ...(apiBase ? { apiBase } : {}),
  };
  return expo;
};
