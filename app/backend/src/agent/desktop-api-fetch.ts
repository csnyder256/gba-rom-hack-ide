/** Authenticate only the desktop's owned loopback callback origin. */
export function createDesktopApiFetch(baseUrl: string, token: string, fetchFn: typeof fetch): typeof fetch {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !/^[a-f0-9]{64}$/.test(token)) {
    throw new Error('Invalid desktop callback configuration');
  }
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== base.origin) return fetchFn(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('X-Gba-Session', token);
    // A callback must not forward the private header through a redirect.
    return fetchFn(input, { ...init, headers, redirect: 'error' });
  };
}
