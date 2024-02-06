import { createHrefFromUrl } from './create-href-from-url'
import { fetchServerResponse } from './fetch-server-response'
import {
  PrefetchCacheEntryStatus,
  type PrefetchCacheEntry,
  PrefetchKind,
  type ReadonlyReducerState,
} from './router-reducer-types'
import { prefetchQueue } from './reducers/prefetch-reducer'

/**
 * Creates a cache key for the router prefetch cache
 *
 * @param url - The URL being navigated to
 * @param nextUrl - an internal URL, primarily used for handling rewrites. Defaults to '/'.
 * @return The generated prefetch cache key.
 */
function createPrefetchCacheKey(url: URL, nextUrl?: string | null) {
  const pathnameFromUrl = createHrefFromUrl(
    url,
    // Ensures the hash is not part of the cache key as it does not impact the server fetch
    false
  )

  // nextUrl is used as a cache key delimiter since entries can vary based on the Next-URL header
  if (nextUrl) {
    return `${nextUrl}%${pathnameFromUrl}`
  }

  return pathnameFromUrl
}

export function prefixExistingPrefetchCacheEntry({
  url,
  nextUrl,
  prefetchCache,
}: Pick<ReadonlyReducerState, 'nextUrl' | 'prefetchCache'> & {
  url: URL
}) {
  const existingCacheKey = createPrefetchCacheKey(url)
  const existingCacheEntry = prefetchCache.get(existingCacheKey)
  if (!existingCacheEntry) {
    // no-op -- there wasn't an entry to move
    return
  }

  const newCacheKey = createPrefetchCacheKey(url, nextUrl)
  prefetchCache.set(newCacheKey, existingCacheEntry)
  prefetchCache.delete(existingCacheKey)
}

type GetOrCreatePrefetchCacheEntryParams = Pick<
  ReadonlyReducerState,
  'nextUrl' | 'prefetchCache' | 'tree' | 'buildId'
> & {
  url: URL
  createIfNotFound?: true
}

type GetPrefetchCacheEntryParams = Pick<
  ReadonlyReducerState,
  'nextUrl' | 'prefetchCache'
> & {
  tree?: ReadonlyReducerState['tree']
  buildId?: ReadonlyReducerState['buildId']
  url: URL
  createIfNotFound?: false
}

/**
 * Returns a prefetch cache entry if one exists. Optionally creates a new one.
 */
export function getPrefetchCacheEntry({
  url,
  nextUrl,
  tree,
  buildId,
  prefetchCache,
  createIfNotFound,
}: GetOrCreatePrefetchCacheEntryParams): PrefetchCacheEntry
export function getPrefetchCacheEntry({
  url,
  nextUrl,
  prefetchCache,
  createIfNotFound,
}: GetPrefetchCacheEntryParams): PrefetchCacheEntry | undefined
export function getPrefetchCacheEntry({
  url,
  nextUrl,
  tree,
  buildId,
  prefetchCache,
  createIfNotFound,
}: GetOrCreatePrefetchCacheEntryParams | GetPrefetchCacheEntryParams):
  | PrefetchCacheEntry
  | undefined {
  let existingCacheEntry: PrefetchCacheEntry | undefined = undefined
  // We first check if there's a more specific interception route prefetch entry
  // This is because when we detect a prefetch that corresponds with an interception route, we prefix it with nextUrl (see `createPrefetchCacheKey`)
  // to avoid conflicts with other pages that may have the same URL but render different things depending on the `Next-URL` header.
  const interceptionCacheKey = createPrefetchCacheKey(url, nextUrl)
  const interceptionData = prefetchCache.get(interceptionCacheKey)

  if (interceptionData) {
    existingCacheEntry = interceptionData
  } else {
    // If we dont find a more specific interception route prefetch entry, we check for a regular prefetch entry
    const prefetchCacheKey = createPrefetchCacheKey(url)
    const prefetchData = prefetchCache.get(prefetchCacheKey)
    if (prefetchData) {
      existingCacheEntry = prefetchData
    }
  }

  // We found an entry, so we can return it
  if (existingCacheEntry) {
    // Grab the latest status of the cache entry and update it
    existingCacheEntry.status = getPrefetchEntryCacheStatus(existingCacheEntry)
    return existingCacheEntry
  }

  // When retrieving a prefetch entry, we usually want to create one if it doesn't exist
  // This let's us create a new one if it doesn't exist to avoid needing typeguards in the calling code
  if (createIfNotFound) {
    // If we don't have a prefetch value, we need to create one
    return createLazyPrefetchEntry({
      tree,
      url,
      buildId,
      nextUrl,
      prefetchCache,
      // in dev, there's never gonna be a prefetch entry so we want to prefetch here
      kind:
        process.env.NODE_ENV === 'development'
          ? PrefetchKind.AUTO
          : PrefetchKind.TEMPORARY,
    })
  }
}

/**
 * Creates a prefetch entry for data that has not been resolved. This will add the prefetch request to a promise queue.
 */
export function createLazyPrefetchEntry({
  url,
  kind,
  tree,
  nextUrl,
  buildId,
  prefetchCache,
}: Pick<
  ReadonlyReducerState,
  'nextUrl' | 'tree' | 'buildId' | 'prefetchCache'
> & {
  url: URL
  kind: PrefetchKind
}): PrefetchCacheEntry {
  const prefetchCacheKey = createPrefetchCacheKey(url)

  // initiates the fetch request for the prefetch and attaches a listener
  // to the promise to update the prefetch cache entry when the promise resolves (if necessary)
  const data = prefetchQueue.enqueue(() =>
    fetchServerResponse(url, tree, nextUrl, buildId, prefetchCache, kind)
  )

  const prefetchEntry = {
    treeAtTimeOfPrefetch: tree,
    data,
    kind,
    prefetchTime: Date.now(),
    lastUsedTime: null,
    key: prefetchCacheKey,
    status: PrefetchCacheEntryStatus.fresh,
  }

  prefetchCache.set(prefetchCacheKey, prefetchEntry)

  return prefetchEntry
}

export function prunePrefetchCache(
  prefetchCache: ReadonlyReducerState['prefetchCache']
) {
  for (const [href, prefetchCacheEntry] of prefetchCache) {
    if (
      getPrefetchEntryCacheStatus(prefetchCacheEntry) ===
      PrefetchCacheEntryStatus.expired
    ) {
      prefetchCache.delete(href)
    }
  }
}

const FIVE_MINUTES = 5 * 60 * 1000
const THIRTY_SECONDS = 30 * 1000

function getPrefetchEntryCacheStatus({
  kind,
  prefetchTime,
  lastUsedTime,
}: PrefetchCacheEntry): PrefetchCacheEntryStatus {
  // if the cache entry was prefetched or read less than 30s ago, then we want to re-use it
  if (Date.now() < (lastUsedTime ?? prefetchTime) + THIRTY_SECONDS) {
    return lastUsedTime
      ? PrefetchCacheEntryStatus.reusable
      : PrefetchCacheEntryStatus.fresh
  }

  // if the cache entry was prefetched less than 5 mins ago, then we want to re-use only the loading state
  if (kind === 'auto') {
    if (Date.now() < prefetchTime + FIVE_MINUTES) {
      return PrefetchCacheEntryStatus.stale
    }
  }

  // if the cache entry was prefetched less than 5 mins ago and was a "full" prefetch, then we want to re-use it "full
  if (kind === 'full') {
    if (Date.now() < prefetchTime + FIVE_MINUTES) {
      return PrefetchCacheEntryStatus.reusable
    }
  }

  return PrefetchCacheEntryStatus.expired
}
