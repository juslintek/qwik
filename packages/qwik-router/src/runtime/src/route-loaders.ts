import { $, implicit$FirstArg, isDev, isServer, type QRL } from '@qwik.dev/core';
import {
  _deserialize,
  _getContextEvent,
  _noopQrl,
  _resolveContextWithoutSequentialScope,
  _verifySerializable,
  SerializerSymbol,
  type SerializationStrategy,
  type AsyncSignal,
  createAsyncQrl,
} from '@qwik.dev/core/internal';
import { _asyncRequestStore } from '@qwik.dev/router/middleware/request-handler';
import type {
  RequestEvent as RequestEventBase,
  RequestEventLoader as ServerRequestEventLoader,
} from '@qwik.dev/router/middleware/request-handler';
import { RouteLoaderCtxContext, RouteStateContext } from './contexts';
import { DEFAULT_LOADERS_SERIALIZATION_STRATEGY } from './constants';
import type {
  DataValidator,
  LoaderConstructor,
  LoaderConstructorQRL,
  LoaderInternal,
  LoaderOptions,
  RequestEvent,
  RequestEventLoader,
  RouteModule,
  ValidatorReturn,
} from './types';

/**
 * Route loaders read data before the route rendering starts, based on the route being navigated to.
 * They automatically update when the route changes on the client, and can also be made to poll for
 * changes.
 *
 * They are represented by an AsyncSignal.
 */

const REQUEST_ROUTE_LOADER_STATE = '@routeLoaderState';
const REQUEST_LOADER_PATHS_STORE = '@loaderPathsStore';

/** Header name sent by client to tell the server the actual page URL for loader requests. */
export const LOADER_URL_HEADER = 'X-Qwik-Loader-URL';

/**
 * Reactive context for route loaders. On the server this is stored in sharedMap, on the client it's
 * a store that gets updated on navigation.
 *
 * - `loaderPaths`: loader ID → fetch path (the longest route path for that loader)
 * - `pageUrl`: the full page URL string (used as X-Qwik-Loader-URL header on fetch)
 * - `manifestHash`: the build manifest hash (part of the fetch URL)
 */
export type RouteLoaderCtx = {
  loaderPaths: Record<string, string>;
  pageUrl: string;
  manifestHash: string;
  basePath: string;
};

class ServerRouteLoaderCapture {
  constructor(
    readonly hash: string,
    readonly qrl: QRL<(event: RequestEventLoader) => unknown>,
    readonly validators: DataValidator[] | undefined
  ) {}

  load() {
    return getRouteLoaderData(this.qrl, this.validators, getRequestEvent());
  }

  [SerializerSymbol]() {
    return this.hash;
  }
}

const isRequestEvent = (value: unknown): value is RequestEvent =>
  !!value &&
  typeof value === 'object' &&
  Object.prototype.hasOwnProperty.call(value, 'sharedMap') &&
  Object.prototype.hasOwnProperty.call(value, 'cookie');

const isLoaderInternal = (value: unknown): value is LoaderInternal =>
  typeof value === 'function' && (value as LoaderInternal).__brand === 'server_loader';

const getLoaderInterval = (expires: number | undefined, poll: boolean | undefined) => {
  const magnitude = expires ? Math.abs(expires) * 1000 : 0;
  return poll === true ? magnitude : -magnitude;
};

const fetchRouteLoaderData = async (
  loaderId: string,
  routePath: string | undefined,
  manifestHash: string,
  pageUrl: string,
  basePath: string,
  ignoreCache: boolean
): Promise<unknown> => {
  if (!routePath) {
    return undefined;
  }
  // Ensure the route path includes the base path (root trie loaders get '/' but
  // need the full base path for fetching)
  let resolvedPath = routePath;
  if (basePath !== '/' && !resolvedPath.startsWith(basePath)) {
    resolvedPath = basePath + resolvedPath.slice(1);
  }
  const pathBase = resolvedPath.endsWith('/') ? resolvedPath : resolvedPath + '/';
  const search = pageUrl.includes('?') ? pageUrl.slice(pageUrl.indexOf('?')) : '';
  const url = `${pathBase}q-loader-${loaderId}.${manifestHash}.json${search}`;

  const promise = fetch(url, {
    cache: ignoreCache ? 'reload' : 'default',
    headers: {
      [LOADER_URL_HEADER]: pageUrl,
    },
  }).then(async (response) => {
    if (response.redirected) {
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

  return promise;
};

const createRouteLoaderSignal = (loader: LoaderInternal, routeLoaderCtx: RouteLoaderCtx) => {
  const capture = isServer
    ? new ServerRouteLoaderCapture(loader.__id, loader.__qrl, loader.__validators)
    : loader.__id;
  const loadQrl = $(async (ctx: { track: Function; info?: unknown }) => {
    if (isServer) {
      return (capture as ServerRouteLoaderCapture).load();
    }
    const id = capture as string;
    // Track reactive dependencies so the signal re-fetches on navigation
    const routePath = ctx.track(() => routeLoaderCtx.loaderPaths[id]) as string | undefined;
    const pageUrl = ctx.track(() => routeLoaderCtx.pageUrl) as string;
    const mHash = routeLoaderCtx.manifestHash;
    const basePath = routeLoaderCtx.basePath;
    return fetchRouteLoaderData(id, routePath, mHash, pageUrl, basePath, ctx.info === true);
  });

  return createAsyncQrl(loadQrl, {
    serializationStrategy: loader.__serializationStrategy,
    interval: getLoaderInterval(loader.__expires, loader.__poll),
  });
};

const getLoaderOptions = (rest: (LoaderOptions | DataValidator)[], qrl: QRL) => {
  let id: string | undefined;
  let serializationStrategy: SerializationStrategy = DEFAULT_LOADERS_SERIALIZATION_STRATEGY;
  let expires: number | undefined;
  let poll: boolean | undefined;
  const validators: DataValidator[] = [];

  if (rest.length === 1) {
    const options = rest[0];
    if (options && typeof options === 'object') {
      if ('validate' in options) {
        validators.push(options);
      } else {
        id = options.id;
        if (options.serializationStrategy) {
          serializationStrategy = options.serializationStrategy;
        }
        if (options.validation) {
          validators.push(...options.validation);
        }
        if ('expires' in options) {
          expires = options.expires;
        }
        if ('poll' in options) {
          poll = options.poll;
        }
      }
    }
  } else if (rest.length > 1) {
    validators.push(...(rest.filter(Boolean) as DataValidator[]));
  }

  if (typeof id === 'string') {
    if (isDev && !/^[\w/.-]+$/.test(id)) {
      throw new Error(`Invalid id: ${id}, id can only contain [a-zA-Z0-9_.-]`);
    }
    id = `id_${id}`;
  } else {
    id = qrl.getHash();
  }

  return {
    id,
    validators: validators.reverse(),
    serializationStrategy,
    expires,
    poll,
  };
};

export const getRequestEvent = (thisArg?: unknown): RequestEvent => {
  if (!isServer) {
    throw new Error('getRequestEvent() can only be used on the server.');
  }
  const requestEvent =
    (_asyncRequestStore?.getStore() as RequestEvent | undefined) ||
    [thisArg, _getContextEvent()].find(isRequestEvent);
  if (!requestEvent) {
    throw new Error('Unable to determine the current RequestEvent.');
  }
  return requestEvent;
};

export function getRouteLoaderState(
  requestEv: RequestEventBase
): Record<string, AsyncSignal<unknown>> {
  let state = requestEv.sharedMap.get(REQUEST_ROUTE_LOADER_STATE) as
    | Record<string, AsyncSignal<unknown>>
    | undefined;
  if (!state) {
    state = {};
    requestEv.sharedMap.set(REQUEST_ROUTE_LOADER_STATE, state);
  }
  return state;
}

export function getRouteLoaderCtx(requestEv: RequestEventBase): RouteLoaderCtx {
  let ctx = requestEv.sharedMap.get(REQUEST_LOADER_PATHS_STORE) as RouteLoaderCtx | undefined;
  if (!ctx) {
    ctx = {
      loaderPaths: {},
      pageUrl: requestEv.url.href,
      manifestHash: '',
      basePath: requestEv.basePathname || '/',
    };
    requestEv.sharedMap.set(REQUEST_LOADER_PATHS_STORE, ctx);
  }
  return ctx;
}

/** Update the loader paths store on client-side navigation. */
export const updateRouteLoaderCtx = (
  ctx: RouteLoaderCtx,
  loaderPaths: Record<string, string> | undefined,
  pageUrl: string
) => {
  ctx.pageUrl = pageUrl;
  // Remove paths no longer present
  for (const key of Object.keys(ctx.loaderPaths)) {
    if (!loaderPaths?.[key]) {
      delete ctx.loaderPaths[key];
    }
  }
  // Add/update paths
  if (loaderPaths) {
    for (const [key, value] of Object.entries(loaderPaths)) {
      ctx.loaderPaths[key] = value;
    }
  }
};

export const getModuleRouteLoaders = (mods: readonly (RouteModule | undefined)[]) => {
  const routeLoaders: LoaderInternal[] = [];
  const seen = new Set<string>();
  for (const mod of mods) {
    if (!mod) {
      continue;
    }
    for (const value of Object.values(mod)) {
      if (isLoaderInternal(value) && !seen.has(value.__id)) {
        seen.add(value.__id);
        routeLoaders.push(value);
      }
    }
  }
  return routeLoaders;
};

export const ensureRouteLoaderSignal = (
  loader: LoaderInternal,
  state: Record<string, AsyncSignal<unknown>>,
  routeLoaderCtx: RouteLoaderCtx
) => {
  return (state[loader.__id] ||= createRouteLoaderSignal(loader, routeLoaderCtx));
};

export const ensureRouteLoaderSignals = (
  mods: readonly (RouteModule | undefined)[],
  state: Record<string, AsyncSignal<unknown>>,
  routeLoaderCtx: RouteLoaderCtx
) => {
  const loaders = getModuleRouteLoaders(mods);
  for (const loader of loaders) {
    ensureRouteLoaderSignal(loader, state, routeLoaderCtx);
  }
  return loaders;
};

export const resolveRouteLoaderByHash = (
  routeLoaders: readonly LoaderInternal[],
  loaderId: string
) => {
  return routeLoaders.find((loader) => loader.__id === loaderId);
};

export const getRouteLoaderData = async (
  loaderQrl: QRL<(event: RequestEventLoader) => unknown>,
  validators: DataValidator[] | undefined,
  requestEv: RequestEvent
) => {
  const loaderRequestEv = requestEv as unknown as RequestEventLoader;

  const result = await runValidators(requestEv, validators, undefined);
  if (!result.success) {
    return loaderRequestEv.fail(result.status ?? 500, result.error);
  }
  const resolved = await loaderQrl.call(
    loaderRequestEv as unknown as ServerRequestEventLoader,
    loaderRequestEv
  );
  const value = typeof resolved === 'function' ? resolved() : resolved;
  if (isDev) {
    verifySerializable(value, loaderQrl);
  }
  return value;
};

/** @internal */
export const routeLoaderQrl = ((
  loaderQrl: QRL<(event: RequestEventLoader) => unknown>,
  ...rest: (LoaderOptions | DataValidator)[]
): LoaderInternal => {
  const { id, validators, serializationStrategy, expires, poll } = getLoaderOptions(
    rest,
    loaderQrl
  );
  const runtimeQrl = isServer ? loaderQrl : (_noopQrl(id) as typeof loaderQrl);

  function loader() {
    const state = _resolveContextWithoutSequentialScope(RouteStateContext)!;
    const routeLoaderCtx = _resolveContextWithoutSequentialScope(RouteLoaderCtxContext)!;
    const signal = ensureRouteLoaderSignal(loader, state, routeLoaderCtx);
    void signal.promise();
    return signal;
  }

  loader.__brand = 'server_loader' as const;
  loader.__qrl = runtimeQrl;
  loader.__validators = validators;
  loader.__id = id;
  loader.__serializationStrategy = serializationStrategy;
  loader.__expires = expires ?? 0;
  loader.__poll = poll ?? false;
  Object.freeze(loader);
  return loader;
}) as LoaderConstructorQRL;

/** @public */
export const routeLoader$: LoaderConstructor = /*#__PURE__*/ implicit$FirstArg(routeLoaderQrl);

async function runValidators(
  requestEv: RequestEvent,
  validators: DataValidator[] | undefined,
  data: unknown
) {
  let lastResult: ValidatorReturn = {
    success: true,
    data,
  };
  if (validators) {
    for (const validator of validators) {
      lastResult = await validator.validate(requestEv, data);
      if (!lastResult.success) {
        return lastResult;
      }
      data = lastResult.data;
    }
  }
  return lastResult;
}

function verifySerializable(data: any, qrl: QRL) {
  try {
    _verifySerializable(data, undefined);
  } catch (error: any) {
    if (error instanceof Error && qrl.dev) {
      (error as any).loc = qrl.dev;
    }
    throw error;
  }
}
