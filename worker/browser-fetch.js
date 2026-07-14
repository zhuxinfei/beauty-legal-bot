const BROWSER_HEADERS = {
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
  'Cache-Control': 'no-cache',
};

function accessControlKind(title, body) {
  const text = `${title}\n${body}`.toLowerCase();
  if (/captcha|验证码|人机验证|verify you are human/.test(text)) return 'captcha';
  if (/sign in|login required|请登录|登录后/.test(text)) return 'login';
  if (/subscribe to continue|paywall|订阅后/.test(text)) return 'paywall';
  if (/access denied|ip allowlist|白名单/.test(text)) return 'allowlist';
  return '';
}

/**
 * GitHub Actions 专用的公开页面渲染器。
 * 一个 Chromium 实例服务整轮任务，每个来源使用独立页面并在 finally 中关闭；它只读取公开正文，不操作登录或验证控件。
 */
export async function createBrowserSourceFetcher({ chromium, launchOptions = {} } = {}) {
  if (!chromium?.launch) throw new TypeError('createBrowserSourceFetcher requires chromium.launch');
  const browser = await chromium.launch({ headless: true, ...launchOptions });
  let closed = false;

  return {
    async fetchHtml(url, { timeoutMs = 45000 } = {}) {
      if (closed) throw new Error('browser source fetcher is closed');
      const page = await browser.newPage();
      try {
        await page.setExtraHTTPHeaders(BROWSER_HEADERS);
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        const status = Number(response?.status?.() || 0);
        const title = await page.title();
        const body = await page.locator('body').innerText({ timeout: Math.min(timeoutMs, 10000) }).catch(() => '');
        const blockedKind = accessControlKind(title, body);
        if (blockedKind) {
          return { ok: false, status, kind: blockedKind, error: `public browser page requires ${blockedKind}` };
        }
        if (status >= 400) return { ok: false, status, kind: 'http', error: `browser HTTP ${status}` };
        if (String(body || '').trim().length < 8) {
          return { ok: false, status, kind: 'empty-shell', error: 'browser page returned no readable text' };
        }
        return {
          ok: true,
          status: status || 200,
          html: await page.content(),
          finalUrl: page.url(),
        };
      } catch (error) {
        const message = String(error?.message || error);
        return {
          ok: false,
          status: 0,
          kind: /timed?\s*out|timeout/i.test(message) ? 'timeout' : 'network',
          error: message,
        };
      } finally {
        await page.close();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await browser.close();
    },
  };
}
