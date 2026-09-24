/**
 * Fetch a versioned model asset through the Cache API, reporting streamed download
 * progress. Cache failures (private mode, quota, unsupported) fall back to a plain
 * network fetch so the model still loads.
 */
export interface FetchProgress {
  url: string;
  loaded: number;
  total: number | null;
  fromCache: boolean;
}

export async function openModelCache(cacheName: string, cachePrefix: string): Promise<Cache | null> {
  try {
    if (typeof caches === 'undefined') return null;
    // Remove caches left behind by older model versions.
    for (const name of await caches.keys()) {
      if (name.startsWith(cachePrefix) && name !== cacheName) await caches.delete(name);
    }
    return await caches.open(cacheName);
  } catch (error) {
    console.warn('Model cache unavailable, downloading without caching.', error);
    return null;
  }
}

export async function cachedFetch(
  url: string,
  cache: Cache | null,
  onProgress: (progress: FetchProgress) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) {
        const buffer = await hit.arrayBuffer();
        onProgress({ url, loaded: buffer.byteLength, total: buffer.byteLength, fromCache: true });
        return buffer;
      }
    } catch (error) {
      console.warn('Model cache read failed, downloading instead.', error);
    }
  }

  let response: Response;
  try {
    response = await fetch(url, { signal, mode: 'cors' });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Could not download the model file (${fileName(url)}). Check your internet connection and try again.`);
  }
  if (!response.ok) {
    throw new Error(`Model download failed with HTTP ${response.status} for ${fileName(url)}.`);
  }

  const lengthHeader = response.headers.get('content-length');
  const total = lengthHeader ? Number(lengthHeader) : null;
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress({ url, loaded, total, fromCache: false });
    }
  } else {
    const buffer = new Uint8Array(await response.arrayBuffer());
    chunks.push(buffer);
    loaded = buffer.byteLength;
  }

  const data = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress({ url, loaded, total: total ?? loaded, fromCache: false });

  if (cache) {
    try {
      await cache.put(url, new Response(data, { headers: { 'content-type': response.headers.get('content-type') ?? 'application/octet-stream' } }));
    } catch (error) {
      console.warn('Could not store model in cache; it will be downloaded again next time.', error);
    }
  }
  return data.buffer;
}

function fileName(url: string): string {
  return url.split('/').pop() ?? url;
}
