import { _serialize } from '@qwik.dev/core/internal';
import type {
  ActionInternal,
  LoaderInternal,
  RequestEvent,
  RequestHandler,
} from '../../../runtime/src/types';
import { type RequestEventInternal } from '../request-event-core';
import { IsQLoader, QLoaderId } from '../request-path';
import {
  getRouteLoaderData,
  resolveRouteLoaderByHash,
  LOADER_URL_HEADER,
} from '../../../runtime/src/route-loaders';

/**
 * Handler for individual loader fetch requests (`/path/q-loader-{id}.{hash}.json`). Runs only the
 * requested loader and returns its serialized result as JSON.
 */
export function loaderHandler(
  routeLoaders: LoaderInternal[],
  _routeActions: ActionInternal[]
): RequestHandler {
  return async (requestEvent: RequestEvent) => {
    const requestEv = requestEvent as RequestEventInternal;

    if (!requestEv.sharedMap.has(IsQLoader)) {
      return;
    }

    if (requestEv.headersSent || requestEv.exited) {
      return;
    }

    const loaderId = requestEv.sharedMap.get(QLoaderId) as string;
    const loader = resolveRouteLoaderByHash(routeLoaders, loaderId);

    if (!loader) {
      requestEv.json(404, { error: 'Loader not found' });
      return;
    }

    // Use the X-Qwik-Loader-URL header to reconstruct the actual page URL.
    // The physical request goes to /path/q-loader-{id}.{hash}.json but the loader
    // function should see the real page URL (with search params, etc.)
    const loaderUrl = requestEv.request.headers.get(LOADER_URL_HEADER);
    if (loaderUrl) {
      try {
        const pageUrl = new URL(loaderUrl, requestEv.url.origin);
        // Override URL properties so the loader sees the real page URL
        requestEv.url.pathname = pageUrl.pathname;
        requestEv.url.search = pageUrl.search;
        requestEv.url.hash = pageUrl.hash;
      } catch {
        // Invalid URL header — ignore and use the trimmed URL
      }
    }

    const result = await getRouteLoaderData(loader.__qrl, loader.__validators, requestEv);
    const data = await _serialize([result]);
    requestEv.headers.set('Content-Type', 'application/json; charset=utf-8');

    // Set cache headers based on loader's expires option
    if (loader.__expires && loader.__expires > 0) {
      requestEv.cacheControl({ maxAge: loader.__expires });
    }

    requestEv.send(200, data);
  };
}
