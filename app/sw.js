/* 《背语雁》Service Worker —— 同源缓存优先 + 网络兜底，保证离线可用。
 * 只缓存同源 GET 资源；任何跨域请求一律直接放行，不拦截、不写入缓存。
 * install 预缓存 URL 会继承本 SW 注册 URL 的查询串凭据，避免无凭据 403。
 * 缓存名带 beiyuyan 版本号（1.0.0 与清单 version 同步）；activate 阶段
 * 清理同名前缀旧缓存，并一次性兼容清理更名前 wenyan-recite-pwa-* 旧缓存。
 */
const CACHE_VERSION = '1.0.0';
const CACHE_PREFIX = 'beiyuyan-pwa-';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
const LEGACY_CACHE_PREFIXES = ['wenyan-recite-pwa-'];

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon.svg'
];

/**
 * 给预缓存相对 URL 透传本 SW 注册 URL 上的查询串凭据（?sharecode=...）。
 *
 * 站点访问控制要求同源请求携带分享凭据；install 阶段的 cache.addAll()
 * 不会自动继承注册 URL 的查询串，直接请求相对路径会返回 403。规则与
 * src/update.js 的 resolveFrom() 及页面引导脚本一致：先 new URL(rel,
 * self.location.href) 解析，再合并 self.location.search 的参数，同名参数
 * 目标优先（目标 URL 已有该参数时不覆盖）。
 *
 * 兜底：SW 若以无查询串 URL 注册（search 为空），或 URL 解析抛错，返回
 * 原相对路径，保持原有离线缓存行为，不抛错、不影响 install。
 *
 * @param {string} rel PRECACHE_URLS 中的相对路径
 * @returns {string} 透传凭据后的绝对 URL；无凭据或异常时返回原相对路径
 */
function precacheUrl(rel) {
  var search = self.location.search;
  if (!search) return rel;
  try {
    var url = new URL(rel, self.location.href);
    new URLSearchParams(search).forEach(function (value, key) {
      if (!url.searchParams.has(key)) url.searchParams.append(key, value);
    });
    return url.href;
  } catch (error) {
    return rel;
  }
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(PRECACHE_URLS.map(precacheUrl)); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) {
              var own = key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE_NAME;
              var legacy = LEGACY_CACHE_PREFIXES.some(function (prefix) {
                return key.indexOf(prefix) === 0;
              });
              return own || legacy;
            })
            .map(function (key) { return caches.delete(key); })
        );
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (error) {
    return;
  }

  // 跨域资源不拦截、不缓存（本应用本身也不发起任何跨域请求）。
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request)
      .then(function (cached) {
        if (cached) return cached;
        return fetch(request).then(function (response) {
          if (response && response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_NAME)
              .then(function (cache) { return cache.put(request, copy); })
              .catch(function () {});
          }
          return response;
        }).catch(function () {
          // 离线且未命中缓存：导航请求回退到已预缓存的首页。
          if (request.mode === 'navigate') {
            return caches.match('./index.html').then(function (fallback) {
              return fallback || caches.match('./');
            });
          }
          return Response.error();
        });
      })
  );
});
