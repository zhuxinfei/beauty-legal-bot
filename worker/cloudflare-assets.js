function retryableStatus(status) {
  return status === 429 || status >= 500;
}

async function putKvValue({ endpoint, apiToken, png, fetcher, sleepFn, maxAttempts }) {
  let lastError = 'unknown Cloudflare KV error';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetcher(endpoint, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'image/png',
        },
        body: png,
      });
      const text = await response.text();
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
      if (response.ok && payload.success !== false) return;
      lastError = `Cloudflare KV ${response.status}: ${text.slice(0, 240)}`;
      if (!retryableStatus(response.status) || attempt === maxAttempts) break;
    } catch (error) {
      lastError = String(error?.message || error);
      if (attempt === maxAttempts) break;
    }
    await sleepFn(750 * attempt);
  }
  throw new Error(lastError);
}

/**
 * 在钉钉发送前写入日期版和 latest 两个远程 KV 键，并从公开 Worker URL 回读日期版 PNG。
 * 日期 URL 避免钉钉命中上一期缓存；只有回读确认图片可用后才把 URL 交给消息渲染器。
 */
export async function publishVersionedPng({
  accountId,
  namespaceId,
  apiToken,
  date,
  png,
  assetName = 'decision-map',
  publicBaseUrl,
  fetcher = fetch,
  sleepFn = delay => new Promise(resolve => setTimeout(resolve, delay)),
  maxAttempts = 3,
  minBytes = 1024,
} = {}) {
  if (!accountId || !namespaceId || !apiToken) throw new Error('Cloudflare account, namespace, and API token are required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('Asset date must use YYYY-MM-DD');
  if (!/^[a-z0-9-]+$/.test(String(assetName || ''))) throw new Error('Asset name must use lowercase letters, numbers, and hyphens');
  if (!(png instanceof Uint8Array) || png.byteLength < minBytes) throw new Error(`PNG asset is too small: ${png?.byteLength || 0} bytes`);

  const apiBase = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/values`;
  for (const key of [`asset:${assetName}:${date}.png`, `asset:${assetName}:latest.png`]) {
    await putKvValue({
      endpoint: `${apiBase}/${encodeURIComponent(key)}`,
      apiToken,
      png,
      fetcher,
      sleepFn,
      maxAttempts,
    });
  }

  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', png));
  const contentVersion = [...digest.slice(0, 8)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const versionedUrl = `${String(publicBaseUrl || '').replace(/\/+$/, '')}/assets/${assetName}/${date}.png?v=${contentVersion}`;
  const healthResponse = await fetcher(`${versionedUrl}&verify=${Date.now()}`, {
    method: 'GET',
    headers: { 'Cache-Control': 'no-cache' },
  });
  const contentType = String(healthResponse.headers.get('Content-Type') || '').toLowerCase();
  const body = new Uint8Array(await healthResponse.arrayBuffer());
  if (!healthResponse.ok || !contentType.startsWith('image/png') || body.byteLength < minBytes) {
    throw new Error(`Published PNG health check failed: HTTP ${healthResponse.status}, ${contentType || 'no content type'}, ${body.byteLength} bytes`);
  }
  return versionedUrl;
}
