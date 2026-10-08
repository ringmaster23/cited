/**
 * Cloudflare Pages _middleware — blocks dot-files / dot-directories
 *
 * Intercepts every request. Any path that starts with a dot segment
 * (e.g. /.git/, /.env, /.htaccess) gets a plain 404 response.
 * /.well-known/ is exempted (RFC 5785).
 */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const path = url.pathname;

  // Block any path whose first segment is a dot-name, except /.well-known
  if (/^\/\.(?!well-known(?:\/|$))/.test(path)) {
    return new Response('Not Found', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex',
      },
    });
  }

  return context.next();
}
