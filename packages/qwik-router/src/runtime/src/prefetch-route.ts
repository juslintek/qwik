import * as qwikRouterConfig from '@qwik-router-config';
import { isBrowser } from '@qwik.dev/core';
// @ts-expect-error no types for preloader yet
import { p as preload } from '@qwik.dev/core/preloader';
import { loadRoute } from './routing';
import { fetchLoader } from './use-endpoint';

/**
 * Prefetch a route's JS bundles and optionally its loader data.
 *
 * Resolves the route from the trie to get the routeName (for the bundle graph preloader) and
 * `$loaders$` (for data prefetching). The bundle graph is keyed by route name (e.g.
 * `products/[id]/`), not by actual pathname (e.g. `products/123/`).
 *
 * @param pathname - The URL pathname to prefetch
 * @param prefetchData - Whether to also prefetch loader data
 * @param probability - Bundle preload probability (0-1, default 0.8)
 * @param manifestHash - Build manifest hash for loader URLs (from `useDocumentHead().manifestHash`)
 */
export async function prefetchRoute(
  pathname: string,
  prefetchData?: boolean,
  probability = 0.8,
  manifestHash?: string
) {
  if (!isBrowser) {
    return;
  }

  try {
    const loadedRoute = await loadRoute(
      (qwikRouterConfig as any).routes,
      (qwikRouterConfig as any).cacheModules,
      pathname
    );
    if (!loadedRoute) {
      return;
    }

    // Preload JS bundles using the route NAME (not pathname) — the bundle graph
    // is keyed by route name (e.g. "products/[id]/") not actual path
    let routeName = loadedRoute.$routeName$;
    routeName = routeName.endsWith('/') ? routeName : routeName + '/';
    if (routeName.length > 1 && routeName.startsWith('/')) {
      routeName = routeName.slice(1);
    }
    preload(routeName, probability);

    if (!prefetchData || !manifestHash) {
      return;
    }

    // Prefetch loader data in parallel (fire-and-forget)
    if (loadedRoute.$loaders$?.length && loadedRoute.$loaderPaths$) {
      loadedRoute.$loaders$.map((hash) => {
        const loaderPath = loadedRoute.$loaderPaths$?.[hash] ?? pathname;
        return fetchLoader(hash, loaderPath, manifestHash!).catch(() => {
          // Silently ignore prefetch errors
        });
      });
    }
  } catch {
    // Silently ignore prefetch errors
  }
}
