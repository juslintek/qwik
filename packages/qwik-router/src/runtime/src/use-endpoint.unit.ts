import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLoader } from './use-endpoint';

describe('fetchLoader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns undefined when the loader is not valid for the current route', async () => {
    await expect(fetchLoader('loader-hash', undefined, 'manifest-hash')).resolves.toBeUndefined();
  });

  it('bypasses the browser cache when forced', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('', {
        status: 404,
      })
    );
    vi.stubGlobal('fetch', fetchSpy);

    await fetchLoader(
      'loader-hash',
      '/products/123/',
      'manifest-hash',
      undefined,
      '?view=full',
      true
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      '/products/123/q-loader-loader-hash.manifest-hash.json?view=full',
      expect.objectContaining({
        cache: 'reload',
      })
    );
  });
});
