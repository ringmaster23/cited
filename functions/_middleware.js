/**
 * Cloudflare Pages middleware — security guard
 *
 * Blocks all dot-directories and dot-files except /.well-known/.
 * This prevents /.git/, /.env, /.htaccess etc. from ever being served,
 * regardless of what the Pages build output directory includes.
 */
export async function onRequest({ request, next }) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Match any path starting with /. that is NOT /.well-known (RFC 5785)
  if (/^\/\.(?!well-known(?:\/|$))/.test(path)) {
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
