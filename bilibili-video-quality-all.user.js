// ==UserScript==
// @name         Bilibili 视频数据标注（全场景版）
// @namespace    https://github.com/bilibili-video-quality
// @version      3.0.0
// @description  在B站首页和视频详情页侧边推荐列表，显示每个视频的点赞率和投币率
// @author       fenghan
// @match        https://www.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      api.bilibili.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ==================== 配置 ====================
    const CONFIG = {
        LIKE_RATIO_THRESHOLD: 0.05,   // 点赞率 ≥5% 为好
        COIN_RATIO_FACTOR: 0.5,       // 投币率 ≥ 点赞率×0.5 为好
        API_DELAY: 200,               // 请求间隔 ms
        CONCURRENT_LIMIT: 3,          // 并发数
        CACHE_TTL: 10 * 60 * 1000,    // 缓存 10 分钟
        DEBUG: false,
    };

    // ==================== 样式 ====================
    GM_addStyle(`
        /* ---- 通用数据条 ---- */
        .bvq-stats-bar {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-top: 4px;
            padding: 0 2px;
            font-size: 12px;
            font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif;
            line-height: 18px;
            white-space: nowrap;
        }

        .bvq-stat-item {
            display: inline-flex;
            align-items: center;
            gap: 2px;
            color: #9499a0;
        }

        .bvq-stat-item.bvq-good {
            color: #fb7299;
            font-weight: 600;
        }

        .bvq-stat-label {
            opacity: 0.8;
        }

        .bvq-stat-value {
            font-variant-numeric: tabular-nums;
        }

        .bvq-loading {
            color: #c9ccd0;
            font-size: 12px;
            margin-top: 4px;
            padding: 0 2px;
        }

        /* ---- 侧边推荐卡片的数据条 ---- */
        .bvq-stats-bar--side {
            margin-top: 2px;
            padding: 0;
            font-size: 11px;
            line-height: 16px;
            gap: 8px;
        }

        .bvq-loading--side {
            font-size: 11px;
            margin-top: 2px;
            padding: 0;
        }
    `);

    // ==================== 缓存 ====================
    const cache = new Map();

    function getCached(bvid) {
        const item = cache.get(bvid);
        if (item && Date.now() - item.ts < CONFIG.CACHE_TTL) return item.data;
        cache.delete(bvid);
        return null;
    }

    // ==================== API ====================
    function fetchStat(bvid) {
        return new Promise((resolve, reject) => {
            const cached = getCached(bvid);
            if (cached) return resolve(cached);

            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
                headers: { 'Referer': 'https://www.bilibili.com/' },
                responseType: 'json',
                onload(resp) {
                    try {
                        const r = typeof resp.response === 'string' ? JSON.parse(resp.response) : resp.response;
                        if (r && r.code === 0 && r.data && r.data.stat) {
                            const s = r.data.stat;
                            const data = { view: s.view || 0, like: s.like || 0, coin: s.coin || 0 };
                            cache.set(bvid, { data, ts: Date.now() });
                            resolve(data);
                        } else {
                            reject(new Error(r ? r.message : 'unknown'));
                        }
                    } catch (e) { reject(e); }
                },
                onerror() { reject(new Error('network')); },
                ontimeout() { reject(new Error('timeout')); },
            });
        });
    }

    // ==================== 并发队列 ====================
    class Queue {
        constructor(n, delay) { this.n = n; this.delay = delay; this.running = 0; this.q = []; }
        add(fn) {
            return new Promise((res, rej) => {
                this.q.push({ fn, res, rej });
                this._next();
            });
        }
        _next() {
            while (this.running < this.n && this.q.length) {
                const { fn, res, rej } = this.q.shift();
                this.running++;
                fn().then(res).catch(rej).finally(() => {
                    this.running--;
                    setTimeout(() => this._next(), this.delay);
                });
            }
        }
    }
    const queue = new Queue(CONFIG.CONCURRENT_LIMIT, CONFIG.API_DELAY);

    // ==================== 工具 ====================
    function pct(ratio) { return (ratio * 100).toFixed(2) + '%'; }
    function log(...a) { CONFIG.DEBUG && console.log('[BVQ-ALL]', ...a); }

    function extractBVID(el) {
        const link = el.querySelector('a[href*="/video/BV"]');
        if (link) {
            const m = link.href.match(/\/video\/(BV[a-zA-Z0-9]+)/);
            if (m) return m[1];
        }
        return null;
    }

    function createStatsBar(stat, sideMode) {
        const likeRatio = stat.view > 0 ? stat.like / stat.view : 0;
        const coinRatio = stat.view > 0 ? stat.coin / stat.view : 0;
        const coinThreshold = likeRatio * CONFIG.COIN_RATIO_FACTOR;

        const likeGood = likeRatio >= CONFIG.LIKE_RATIO_THRESHOLD;
        const coinGood = coinRatio >= coinThreshold && coinThreshold > 0;

        const bar = document.createElement('div');
        bar.className = 'bvq-stats-bar' + (sideMode ? ' bvq-stats-bar--side' : '');
        bar.innerHTML = `
            <span class="bvq-stat-item ${likeGood ? 'bvq-good' : ''}">
                <span class="bvq-stat-label">👍</span>
                <span class="bvq-stat-value">${pct(likeRatio)}</span>
            </span>
            <span class="bvq-stat-item ${coinGood ? 'bvq-good' : ''}">
                <span class="bvq-stat-label">🪙</span>
                <span class="bvq-stat-value">${pct(coinRatio)}</span>
            </span>
        `;
        return bar;
    }

    // ==================== 已处理标记 ====================
    const processed = new WeakSet();

    function markProcessed(el) {
        if (processed.has(el)) return false;
        processed.add(el);
        return true;
    }

    // ==================== 场景一：首页视频卡片 ====================
    function scanHomepage() {
        const cards = document.querySelectorAll('.bili-video-card');
        let count = 0;

        cards.forEach(card => {
            if (!markProcessed(card)) return;
            const bvid = extractBVID(card);
            if (!bvid) return;

            count++;

            const bottom = card.querySelector('.bili-video-card__info--bottom')
                || card.querySelector('.bili-video-card__info');
            if (!bottom) return;

            const placeholder = document.createElement('div');
            placeholder.className = 'bvq-loading';
            placeholder.textContent = '⏳';
            bottom.parentNode.insertBefore(placeholder, bottom.nextSibling);

            queue.add(() => fetchStat(bvid))
                .then(stat => {
                    placeholder.replaceWith(createStatsBar(stat, false));
                })
                .catch(err => {
                    placeholder.textContent = '';
                    log(bvid, 'err:', err.message);
                });
        });

        if (count > 0) log(`首页：扫描到 ${count} 个新卡片`);
    }

    // ==================== 场景二：视频详情页侧边推荐 ====================
    function scanSidebar() {
        // 推荐列表中的视频卡片
        const cards = document.querySelectorAll('.video-page-card-small');
        let count = 0;

        cards.forEach(card => {
            if (!markProcessed(card)) return;
            const bvid = extractBVID(card);
            if (!bvid) return;

            count++;

            // 侧边推荐的结构：.card-box > (.pic-box + .info)
            // .info 下有 a>p.title, .upname, .playinfo
            // 我们在 .info 的最后追加数据
            const info = card.querySelector('.info');
            if (!info) return;

            const placeholder = document.createElement('div');
            placeholder.className = 'bvq-loading bvq-loading--side';
            placeholder.textContent = '⏳';
            info.appendChild(placeholder);

            queue.add(() => fetchStat(bvid))
                .then(stat => {
                    placeholder.replaceWith(createStatsBar(stat, true));
                })
                .catch(err => {
                    placeholder.textContent = '';
                    log(bvid, 'err:', err.message);
                });
        });

        if (count > 0) log(`侧边栏：扫描到 ${count} 个新卡片`);
    }

    // ==================== 统一扫描 ====================
    function scanAll() {
        const url = location.href;

        // 首页
        if (url === 'https://www.bilibili.com/'
            || url.startsWith('https://www.bilibili.com/?')
            || url === 'https://www.bilibili.com') {
            scanHomepage();
        }

        // 视频详情页（始终扫描侧边栏，因为首页也可能没有但不影响）
        if (url.includes('/video/')) {
            scanSidebar();
        }

        // 兜底：两种场景都扫一次，不会重复（WeakSet 保证）
        scanHomepage();
        scanSidebar();
    }

    // ==================== 启动 ====================
    let timer = null;
    function debounceScan() {
        clearTimeout(timer);
        timer = setTimeout(scanAll, 300);
    }

    // 监听 DOM 变化
    new MutationObserver(muts => {
        for (const m of muts) {
            if (m.addedNodes.length) { debounceScan(); break; }
        }
    }).observe(document.body, { childList: true, subtree: true });

    // 监听滚动（首页无限滚动 + 侧边栏也可能滚动加载）
    window.addEventListener('scroll', () => debounceScan(), { passive: true });

    // 监听 B 站 SPA 路由变化
    let lastUrl = location.href;
    new MutationObserver(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            log('路由变化:', lastUrl);
            // 路由变化后稍等 DOM 更新
            setTimeout(scanAll, 800);
            setTimeout(scanAll, 2000);
        }
    }).observe(document.querySelector('title') || document.head, {
        childList: true,
        subtree: true,
        characterData: true,
    });

    // 初始扫描
    setTimeout(scanAll, 1200);
    setInterval(scanAll, 6000);

    log('全场景视频数据标注脚本已启动 ✓');
})();
