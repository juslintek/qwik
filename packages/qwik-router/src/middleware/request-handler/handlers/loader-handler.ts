import { _serialize, _UNINITIALIZED, type ValueOrPromise } from '@qwik.dev/core/internal';
import type {
  ActionInternal,
  LoaderInternal,
  RequestEvent,
  RequestHandler,
} from '../../../runtime/src/types';
import {
  getRequestLoaders,
  getRequestLoaderSerializationStrategyMap,
  type RequestEventInternal,
} from '../request-event-core';
import { getRouteLoaderPromise } from '../request-loader';
import { IsQLoader, QLoaderId } from '../request-path';

/**
 * Middleware that executes ALL route loaders (used during SSR page rendering). This is the same as
 * the existing loadersMiddleware but extracted for clarity.
 */
export function loadersMiddleware(routeLoaders: LoaderInternal[]): RequestHandler {
  return async (requestEvent: RequestEvent) => {
    const requestEv = requestEvent as RequestEventInternal;
    if (requestEv.headersSent) {
      requestEv.exit();
      return;
    }
    const loaders = getRequestLoaders(requestEv);
    const loadersSerializationStrategy = getRequestLoaderSerializationStrategyMap(requestEv);
    if (routeLoaders.length > 0) {
      const resolvedLoadersPromises = routeLoaders.map((loader) =>
        getRouteLoaderPromise(loader, loaders, loadersSerializationStrategy, requestEv)
      );
      await Promise.all(resolvedLoadersPromises);
    }
  };
}

/**
 * Handler for individual loader fetch requests (`/path/q-loader-{id}.{hash}.json`). Runs only the
 * requested loader and returns its serialized result as JSON.
 */
export function loaderHandler(
  routeLoaders: LoaderInternal[],
  routeActions: ActionInternal[]
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
    const loaders = getRequestLoaders(requestEv);
    const loadersSerializationStrategy = getRequestLoaderSerializationStrategyMap(requestEv);

    // Find the requested loader
    let loader: LoaderInternal | undefined;
    for (const routeLoader of routeLoaders) {
      if (routeLoader.__id === loaderId) {
        loader = routeLoader;
      } else if (!loaders[routeLoader.__id]) {
        // Other loaders set to _UNINITIALIZED so resolveValue() can trigger them on demand
        loaders[routeLoader.__id] = _UNINITIALIZED as unknown as ValueOrPromise<unknown>;
      }
    }

    if (!loader) {
      requestEv.json(404, { error: 'Loader not found' });
      return;
    }

    // Execute the loader
    await getRouteLoaderPromise(loader, loaders, loadersSerializationStrategy, requestEv);

    // Serialize and return just this loader's result
    const data = await _serialize([loaders[loaderId]]);
    requestEv.headers.set('Content-Type', 'application/json; charset=utf-8');

    // Set cache headers based on loader's expires option
    if (loader.__expires && loader.__expires > 0) {
      requestEv.cacheControl({ maxAge: loader.__expires });
    }

    requestEv.send(200, data);
  };
}
