/** @type {import('next').NextConfig} */
// Same-origin proxy (Phase 6 deploy): the browser only ever talks to the UI's
// own origin, and Next forwards /api/* and /healthz to the API server-side.
// This keeps session cookies first-party to the UI host — required on *.fly.dev,
// where the UI and API are different sites and cookies can't span them.
//
// API_PROXY_TARGET is a SERVER-side env (the API's internal URL); defaults to
// the local dev API. In production set it to the API's flycast address.
const API_PROXY_TARGET = process.env.API_PROXY_TARGET || 'http://localhost:4000';

module.exports = {
  reactStrictMode: true,
  transpilePackages: ['@hive/shared'],
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${API_PROXY_TARGET}/api/:path*` },
      { source: '/healthz', destination: `${API_PROXY_TARGET}/healthz` },
    ];
  },
};
