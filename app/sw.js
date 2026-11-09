/* 《背语雁》Service Worker —— 页面导航网络优先 + 离线缓存兜底，保证打开即最新版。
 * 只缓存同源 GET 资源；任何跨域请求一律直接放行，不拦截、不写入缓存。
 * install 预缓存 URL 会继承本 SW 注册 URL 的查询串凭据，避免无凭据 403。
 *
 * v1.14.0 修复「打开先显示旧版本画面、再跳到新版本」：
 * 旧策略 navigation 用 stale-while-revalidate，命中缓存立即把上次的旧 HTML
 * 交给浏览器渲染，后台才更新缓存 —— 用户每次打开都先看旧界面，直到下一次
 * 刷新才变成新版。现改为 network-first：有网时先取服务器最新 HTML 并做版本
 * 闸门校验，成功后写回缓存再出画面；只有离线、超时或服务器返回更旧版本时
 * 才回退缓存。超时后网络请求仍在后台完成写缓存，下一次打开即为最新版。
 * 静态资源仍保持缓存优先，不影响打开速度。
 *
 * 缓存名带包名前缀与版本号（由 scripts/pwa.mjs 在构建时注入 package.json
 * 的 version），发新版时缓存名变化，activate 清理旧缓存，避免永远读旧页面。
 * activate 阶段同时一次性兼容清理更名前 wenyan-recite-pwa-* 旧缓存。
 */
const CACHE_VERSION = '1.14.0';
const CACHE_PREFIX = 'beiyuyan-pwa-';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
const LEGACY_CACHE_PREFIXES = ['wenyan-recite-pwa-'];
/** 导航等待网络的上限；超时后用缓存兜底，不让用户干等。 */
const NAV_TIMEOUT_MS = 4000;

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

/** 联网取最新内容并在成功后写回缓存；异常响应不污染缓存。静态资源专用。 */
function refresh(request) {
  return fetch(request).then(function (response) {
    if (response && response.ok && response.type === 'basic') {
      const copy = response.clone();
      caches.open(CACHE_NAME)
        .then(function (cache) { return cache.put(request, copy); })
        .catch(function () {});
    }
    return response;
  });
}

/** 从 HTML 文本读出 <meta name="app-version" content="..."> 的版本号。 */
function readAppVersion(text) {
  var m = /<meta\s+name=["']app-version["']\s+content=["']([^"']+)["']/i.exec(text)
    || /<meta\s+content=["']([^"']+)["']\s+name=["']app-version["']/i.exec(text);
  return m ? m[1] : '';
}

/** 语义化版本比较：a > b 返回 1，a < b 返回 -1，相等返回 0。 */
function compareVersion(a, b) {
  var pa = String(a || '').split('.');
  var pb = String(b || '').split('.');
  var len = Math.max(pa.length, pb.length);
  for (var i = 0; i < len; i += 1) {
    var na = parseInt(pa[i], 10); if (isNaN(na)) na = 0;
    var nb = parseInt(pb[i], 10); if (isNaN(nb)) nb = 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/** 离线 / 超时兜底：优先命中导航缓存，再退回预缓存首页。 */
function cachedNavigation(request) {
  return caches.match(request).then(function (cached) {
    if (cached) return cached;
    return caches.match('./index.html').then(function (fallback) {
      return fallback || caches.match('./');
    });
  });
}

/**
 * 页面导航网络优先：
 *  - 有网：取服务器最新 HTML；版本不低于本 SW 版本（或读不到版本号，视为
 *    兼容）才写回缓存并返回，保证打开就是最新版、不会先闪旧画面；
 *  - 服务器回源到更旧版本：不写缓存，优先返回缓存里已有的较新页面，
 *    避免 CDN 抖动把缓存污染成旧版；
 *  - 离线 / 超时：立即回退缓存，同时让网络请求在后台继续完成写缓存。
 */
function networkFirstNavigation(request) {
  var network = fetch(request).then(function (response) {
    if (!response || !response.ok || response.type !== 'basic') {
      throw new Error('导航网络响应异常');
    }
    var inspect = response.clone();
    var cacheCopy = response.clone();
    return inspect.text().then(function (text) {
      var remoteVersion = readAppVersion(text);
      if (remoteVersion && compareVersion(remoteVersion, CACHE_VERSION) < 0) {
        return cachedNavigation(request).then(function (cached) {
          return cached || response;
        });
      }
      caches.open(CACHE_NAME)
        .then(function (cache) { return cache.put(request, cacheCopy); })
        .catch(function () {});
      return response;
    }).catch(function () { return response; });
  });

  var timeout = new Promise(function (resolve, reject) {
    setTimeout(function () { reject(new Error('导航网络超时')); }, NAV_TIMEOUT_MS);
  });

  return Promise.race([network, timeout]).catch(function () {
    // 超时不代表失败：后台继续把最新页面写回缓存，下次打开即为新版。
    network.catch(function () {});
    return cachedNavigation(request);
  });
}

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

  // 页面导航：网络优先出最新版，离线 / 超时才用缓存，不再先显示旧页面。
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  // 图标 / manifest 等静态资源：缓存优先，未命中才联网并回填。
  event.respondWith(
    caches.match(request).then(function (cached) {
      if (cached) return cached;
      return refresh(request).catch(function () { return Response.error(); });
    })
  );
});
