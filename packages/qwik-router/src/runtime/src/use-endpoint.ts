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
  routePath: string | undefined,
  manifestHash: string,
  abortController?: AbortController,
  search?: string,
  skipCache = false
): Promise<unknown> {
  if (!routePath) {
    return undefined;
  }
  const pathBase = routePath.endsWith('/') ? routePath : routePath + '/';
  const url = `${pathBase}q-loader-${loaderId}.${manifestHash}.json${search || ''}`;

  return fetch(url, {
    signal: abortController?.signal,
    cache: skipCache ? 'reload' : 'default',
  }).then(async (response) => {
    if (response.redirected) {
      // Server issued a redirect (from loader/middleware throw redirect()).
      // Abort all other loader fetches and navigate to the redirect target.
      abortController?.abort();
      location.href = response.url;
      return undefined;
    }
    if (!response.ok) {
      return undefined;
    }
    const text = await response.text();
    const [data] = _deserialize<[unknown]>(text) ?? [undefined];
    return data;
  });
}

/**
 * Submit an action to the server and get the result.
 *
 * POSTs to `/routePath/?qaction={actionId}` with `Accept: application/json`. The server runs the
 * action and returns the action result together with the loader hashes that should be invalidated.
 */
export async function submitAction(
  action: NonNullable<RouteActionValue>,
  routePath: string
): Promise<{ status: number; result: unknown; loaderHashes: string[] } | undefined> {
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
    const data = _deserialize<{ result: unknown; loaderHashes?: string[] }>(text);
    return {
      status: response.status,
      result: data?.result,
      loaderHashes: data?.loaderHashes ?? [],
    };
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
  let actionResult: { status: number; result: unknown; loaderHashes: string[] } | undefined;

  if (opts?.action) {
    actionResult = await submitAction(opts.action, url.pathname);
    if (!actionResult) {
      return undefined;
    }
    opts.action.data = undefined;
  }

  return {
    status: actionResult?.status ?? 200,
    loaders: {},
    loaderHashes: actionResult?.loaderHashes,
    actionResult: actionResult?.result,
    href: url.pathname,
  } as ClientPageData;
};
