/**
 * Cloudflare Pages middleware — security guard
 *
 * Blocks paths that should never be publicly served:
 *
 *  1. Dot-directories and dot-files except /.well-known/ (RFC 5785).
 *     Prevents /.git/, /.env, /.htaccess, etc. from being served regardless
 *     of what ends up in the Pages build output directory.
 *
 *  2. /scripts/ — Node.js build-time scripts; not part of the public site.
 *
 * Note: Cloudflare Pages evaluates _redirects before static assets, and static
 * assets before Functions in some CDN edge cases. The _redirects file carries
 * the same rules as belt-and-suspenders so both layers cover the gap.
 */
export async function onRequest({ request, next }) {
  const url = new URL(request.url);
  const path = url.pathname;

  // 1. Block any path starting with /. that is NOT /.well-known (RFC 5785)
  if (/^\/\.(?!well-known(?:\/|$))/.test(path)) {
    return new Response('Not Found', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  // 2. Block /scripts/ — build tools, not part of the public site
  if (/^\/scripts(?:\/|$)/.test(path)) {
    return new Response('Not Found', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  return next();
}
