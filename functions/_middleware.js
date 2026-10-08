/**
 * Cloudflare Pages middleware — pass-through (restored)
 *
 * Security filtering (dot-files, /scripts/) is handled by _redirects rules
 * rather than here. This file exists to preserve the functions/ directory
 * structure without running any custom logic.
 */
export async function onRequest({ next }) {
  return next();
}
