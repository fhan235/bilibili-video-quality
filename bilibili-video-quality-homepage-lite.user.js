// ==UserScript==
// @name         Bilibili 首页视频数据标注（简洁版）
// @namespace    https://github.com/bilibili-video-quality
// @version      2.0.0
// @description  在B站首页每个视频卡片下方直接显示点赞率和投币率，一目了然
// @author       fenghan
// @match        https://www.bilibili.com/
// @match        https://www.bilibili.com/?*
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
    function log(...a) { CONFIG.DEBUG && console.log('[BVQ]', ...a); }

    // ==================== 核心逻辑 ====================
    const processed = new WeakSet();

    function extractBVID(card) {
        const link = card.querySelector('a[href*="/video/BV"]');
        if (link) {
            const m = link.href.match(/\/video\/(BV[a-zA-Z0-9]+)/);
            if (m) return m[1];
        }
        return null;
    }

    function createStatsBar(stat) {
        const likeRatio = stat.view > 0 ? stat.like / stat.view : 0;
        const coinRatio = stat.view > 0 ? stat.coin / stat.view : 0;
        const coinThreshold = likeRatio * CONFIG.COIN_RATIO_FACTOR;

        const likeGood = likeRatio >= CONFIG.LIKE_RATIO_THRESHOLD;
        const coinGood = coinRatio >= coinThreshold && coinThreshold > 0;

        const bar = document.createElement('div');
        bar.className = 'bvq-stats-bar';
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

    function scan() {
        const cards = document.querySelectorAll('.bili-video-card');
        let count = 0;

        cards.forEach(card => {
            if (processed.has(card)) return;
            const bvid = extractBVID(card);
            if (!bvid) return;

            processed.add(card);
            count++;

            // 找到信息区底部（UP主那一行），在其后面插入
            const bottom = card.querySelector('.bili-video-card__info--bottom')
                || card.querySelector('.bili-video-card__info');
            if (!bottom) return;

            // 添加 loading 占位
            const placeholder = document.createElement('div');
            placeholder.className = 'bvq-loading';
            placeholder.textContent = '⏳ 加载中...';
            bottom.parentNode.insertBefore(placeholder, bottom.nextSibling);

            queue.add(() => fetchStat(bvid))
                .then(stat => {
                    placeholder.replaceWith(createStatsBar(stat));
                    log(bvid, `👍${pct(stat.view > 0 ? stat.like/stat.view : 0)} 🪙${pct(stat.view > 0 ? stat.coin/stat.view : 0)}`);
                })
                .catch(err => {
                    placeholder.textContent = '';
                    log(bvid, 'err:', err.message);
                });
        });

        if (count > 0) log(`扫描到 ${count} 个新卡片`);
    }

    // ==================== 启动 ====================
    let timer = null;
    function debounceScan() {
        clearTimeout(timer);
        timer = setTimeout(scan, 300);
    }

    new MutationObserver(muts => {
        for (const m of muts) {
            if (m.addedNodes.length) { debounceScan(); break; }
        }
    }).observe(document.body, { childList: true, subtree: true });

    window.addEventListener('scroll', () => debounceScan(), { passive: true });

    setTimeout(scan, 1200);
    setInterval(scan, 6000);

    log('首页视频数据标注脚本已启动 ✓');
})();
