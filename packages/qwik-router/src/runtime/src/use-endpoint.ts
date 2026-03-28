import { LOADER_CACHE } from './constants';
import type { ClientPageData, LoadedRoute, RouteActionValue } from './types';
import { _deserialize } from '@qwik.dev/core/internal';
import { QACTION_KEY } from './constants';

/**
 * Fetch a single loader's data from the server.
 *
 * URL pattern: `/routePath/q-loader-{loaderId}.{manifestHash}.json`
 */
export async function fetchLoader(
  loaderId: string,
  routePath: string,
  manifestHash: string,
  abortController?: AbortController,
  search?: string
): Promise<unknown> {
  const pathBase = routePath.endsWith('/') ? routePath : routePath + '/';
  const url = `${pathBase}q-loader-${loaderId}.${manifestHash}.json${search || ''}`;

  const cacheKey = url;
  const cached = LOADER_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }

  const promise = fetch(url, {
    signal: abortController?.signal,
  }).then(async (response) => {
    if (response.redirected) {
      // Server issued a redirect (from loader/middleware throw redirect()).
      // Abort all other loader fetches and navigate to the redirect target.
      abortController?.abort();
      LOADER_CACHE.delete(cacheKey);
      location.href = response.url;
      return undefined;
    }
    if (!response.ok) {
      LOADER_CACHE.delete(cacheKey);
      return undefined;
    }
    const text = await response.text();
    const [data] = _deserialize<[unknown]>(text) ?? [undefined];
    return data;
  });

  LOADER_CACHE.set(cacheKey, promise);
  return promise;
}

/**
 * Submit an action to the server and get the result.
 *
 * POSTs to `/routePath/?qaction={actionId}` with `Accept: application/json`. The server runs the
 * action AND all route loaders, returning the full loaders map. This ensures loaders that depend on
 * action results (via resolveValue) work correctly.
 */
export async function submitAction(
  action: NonNullable<RouteActionValue>,
  routePath: string
): Promise<{ status: number; loaders: Record<string, unknown> } | undefined> {
  const pathBase = routePath.endsWith('/') ? routePath : routePath + '/';
  const url = `${pathBase}?${QACTION_KEY}=${encodeURIComponent(action.id)}`;

  const actionData = action.data;
  let fetchOptions: RequestInit;

  if (actionData instanceof FormData) {
    fetchOptions = {
      method: 'POST',
      body: actionData,
      headers: {
        Accept: 'application/json',
      },
    };
  } else {
    fetchOptions = {
      method: 'POST',
      body: JSON.stringify(actionData),
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        Accept: 'application/json',
      },
    };
  }

  const response = await fetch(url, fetchOptions);

  if (response.redirected) {
    const redirectedURL = new URL(response.url);
    if (redirectedURL.origin !== location.origin) {
      location.href = redirectedURL.href;
      return undefined;
    }
    location.href = redirectedURL.href;
    return undefined;
  }

  if ((response.headers.get('content-type') || '').includes('json')) {
    const text = await response.text();
    // The server returns the full loaders map (action result + all loader results)
    const loaders = _deserialize<Record<string, unknown>>(text) ?? {};
    return { status: response.status, loaders };
  }

  return undefined;
}

/**
 * Load all loader data for a client-side navigation.
 *
 * Fetches per-loader endpoints using `fetchLoader()`. If no loaders are available, returns a
 * ClientPageData with empty loaders.
 */
export const loadClientData = async (
  url: URL,
  loadedRoute: LoadedRoute | null,
  manifestHash: string | undefined,
  opts?: {
    action?: RouteActionValue;
    loaderIds?: string[];
    clearCache?: boolean;
  }
): Promise<ClientPageData | undefined> => {
  let loaders: Record<string, unknown> = {};
  let actionResult: { status: number; loaders: Record<string, unknown> } | undefined;

  if (opts?.action) {
    actionResult = await submitAction(opts.action, url.pathname);
    if (!actionResult) {
      return undefined;
    }
    // The action response includes all loader results — use them directly
    loaders = actionResult.loaders;
    opts.action.data = undefined;
  }

  // Only fetch individual loaders if no action was submitted
  // (action response already includes all loader results)
  const loaderHashes = opts?.loaderIds ?? loadedRoute?.$loaders$ ?? [];
  if (!actionResult && manifestHash && loaderHashes.length) {
    const abortController = new AbortController();

    try {
      const loaderPromises = loaderHashes.map(async (hash) => {
        const data = await fetchLoader(
          hash,
          url.pathname,
          manifestHash,
          abortController,
          url.search
        );
        loaders[hash] = data;
      });
      await Promise.all(loaderPromises);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        // Expected when redirect happens
      } else {
        throw e;
      }
    }
  }

  if (opts?.clearCache) {
    LOADER_CACHE.clear();
  }

  return {
    status: actionResult?.status ?? 200,
    loaders,
    href: url.pathname,
  } as ClientPageData;
};
