// ==UserScript==
// @name         Bilibili 首页视频质量标注
// @namespace    https://github.com/bilibili-video-quality
// @version      1.0.0
// @description  在B站首页/推荐页直接标注每个视频的质量（好视频/普通视频），无需点进视频
// @author       fenghan
// @match        https://www.bilibili.com/
// @match        https://www.bilibili.com/?*
// @match        https://www.bilibili.com/channel/*
// @match        https://www.bilibili.com/v/*
// @match        https://search.bilibili.com/*
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
        // 点赞率阈值：点赞数 / 播放量 >= 5% 即为好视频
        LIKE_RATIO_THRESHOLD: 0.05,
        // 投币率因子：投币率 >= 点赞率 × 0.5 即为好视频
        COIN_RATIO_FACTOR: 0.5,
        // API 请求间隔（毫秒），避免请求过快被限流
        API_DELAY: 200,
        // 同时进行的 API 请求数量上限
        CONCURRENT_LIMIT: 3,
        // DOM 扫描间隔（毫秒）
        SCAN_INTERVAL: 1500,
        // API 结果缓存过期时间（毫秒），默认 10 分钟
        CACHE_TTL: 10 * 60 * 1000,
        // 调试模式
        DEBUG: false,
    };

    // ==================== 样式 ====================
    GM_addStyle(`
        /* 视频卡片上的标签 */
        .bvq-home-badge {
            position: absolute;
            top: 8px;
            left: 8px;
            z-index: 10;
            display: inline-flex;
            align-items: center;
            gap: 3px;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0.3px;
            pointer-events: auto;
            cursor: default;
            transition: opacity 0.2s ease;
            line-height: 20px;
        }

        .bvq-home-badge-good {
            background: rgba(251, 58, 94, 0.9);
            color: #fff;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
        }

        .bvq-home-badge-normal {
            background: rgba(120, 130, 150, 0.85);
            color: #fff;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
        }

        .bvq-home-badge-loading {
            background: rgba(0, 0, 0, 0.45);
            color: #ddd;
        }

        /* 悬浮详情面板 */
        .bvq-home-badge:hover .bvq-detail-panel {
            display: block;
        }

        .bvq-detail-panel {
            display: none;
            position: absolute;
            top: calc(100% + 6px);
            left: 0;
            background: #fff;
            border-radius: 10px;
            padding: 12px 16px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
            min-width: 240px;
            font-weight: 400;
            color: #333;
            font-size: 12px;
            line-height: 1.6;
            z-index: 99999;
            text-shadow: none;
            cursor: default;
            pointer-events: auto;
        }

        .bvq-detail-panel::before {
            content: '';
            position: absolute;
            top: -5px;
            left: 12px;
            border-left: 5px solid transparent;
            border-right: 5px solid transparent;
            border-bottom: 5px solid #fff;
        }

        .bvq-detail-title {
            font-weight: 700;
            font-size: 13px;
            margin-bottom: 6px;
            padding-bottom: 5px;
            border-bottom: 1px solid #f0f0f0;
            color: #333;
        }

        .bvq-detail-row {
            display: flex;
            justify-content: space-between;
            padding: 2px 0;
        }

        .bvq-detail-label {
            color: #999;
        }

        .bvq-detail-value {
            font-weight: 600;
            color: #333;
        }

        .bvq-detail-value.bvq-pass {
            color: #fb3a5e;
        }

        .bvq-detail-value.bvq-fail {
            color: #aaa;
        }

        .bvq-detail-divider {
            height: 1px;
            background: #f0f0f0;
            margin: 5px 0;
        }

        /* 确保视频卡片的封面容器是 relative 定位 */
        .bili-video-card__cover {
            position: relative !important;
        }

        .feed-card .bili-video-card__cover {
            position: relative !important;
        }

        .bili-video-card .bili-video-card__cover {
            position: relative !important;
        }
    `);

    // ==================== 缓存 ====================
    const videoCache = new Map();

    function getCachedData(bvid) {
        const cached = videoCache.get(bvid);
        if (cached && Date.now() - cached.timestamp < CONFIG.CACHE_TTL) {
            return cached.data;
        }
        videoCache.delete(bvid);
        return null;
    }

    function setCachedData(bvid, data) {
        videoCache.set(bvid, { data, timestamp: Date.now() });
    }

    // ==================== API 请求 ====================

    /**
     * 通过 GM_xmlhttpRequest 调用 B 站 API 获取视频详情
     * 使用 GM_xmlhttpRequest 可以绕过跨域限制
     */
    function fetchVideoStat(bvid) {
        return new Promise((resolve, reject) => {
            // 先查缓存
            const cached = getCachedData(bvid);
            if (cached) {
                resolve(cached);
                return;
            }

            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
                headers: {
                    'Referer': 'https://www.bilibili.com/',
                    'User-Agent': navigator.userAgent,
                },
                responseType: 'json',
                onload: function (response) {
                    try {
                        const result = typeof response.response === 'string'
                            ? JSON.parse(response.response)
                            : response.response;

                        if (result && result.code === 0 && result.data && result.data.stat) {
                            const stat = result.data.stat;
                            const data = {
                                plays: stat.view || 0,
                                likes: stat.like || 0,
                                coins: stat.coin || 0,
                                favorites: stat.favorite || 0,
                                shares: stat.share || 0,
                                danmaku: stat.danmaku || 0,
                                comments: stat.reply || 0,
                                title: result.data.title || '',
                            };
                            setCachedData(bvid, data);
                            resolve(data);
                        } else {
                            log('API 返回异常:', bvid, result);
                            reject(new Error(`API error: ${result ? result.message : 'unknown'}`));
                        }
                    } catch (e) {
                        reject(e);
                    }
                },
                onerror: function (err) {
                    reject(new Error('网络请求失败'));
                },
                ontimeout: function () {
                    reject(new Error('请求超时'));
                },
            });
        });
    }

    // ==================== 并发控制 ====================

    class TaskQueue {
        constructor(concurrency, delay) {
            this.concurrency = concurrency;
            this.delay = delay;
            this.running = 0;
            this.queue = [];
        }

        enqueue(task) {
            return new Promise((resolve, reject) => {
                this.queue.push({ task, resolve, reject });
                this._run();
            });
        }

        _run() {
            while (this.running < this.concurrency && this.queue.length > 0) {
                const { task, resolve, reject } = this.queue.shift();
                this.running++;
                task()
                    .then(resolve)
                    .catch(reject)
                    .finally(() => {
                        this.running--;
                        // 延迟后执行下一个
                        setTimeout(() => this._run(), this.delay);
                    });
            }
        }
    }

    const apiQueue = new TaskQueue(CONFIG.CONCURRENT_LIMIT, CONFIG.API_DELAY);

    // ==================== 质量评估 ====================

    function evaluateQuality(stats) {
        const { plays, likes, coins } = stats;

        if (plays === 0) {
            return {
                isGood: false,
                likeRatio: 0,
                coinRatio: 0,
                likeThreshold: CONFIG.LIKE_RATIO_THRESHOLD,
                coinThreshold: 0,
                likePass: false,
                coinPass: false,
            };
        }

        const likeRatio = likes / plays;
        const coinRatio = coins / plays;
        const coinThreshold = likeRatio * CONFIG.COIN_RATIO_FACTOR;

        const likePass = likeRatio >= CONFIG.LIKE_RATIO_THRESHOLD;
        const coinPass = coinRatio >= coinThreshold && coinThreshold > 0;

        return {
            isGood: likePass || coinPass,
            likeRatio,
            coinRatio,
            likeThreshold: CONFIG.LIKE_RATIO_THRESHOLD,
            coinThreshold,
            likePass,
            coinPass,
        };
    }

    // ==================== 工具函数 ====================

    function formatPercent(ratio) {
        return (ratio * 100).toFixed(2) + '%';
    }

    function formatCount(num) {
        if (num >= 100000000) return (num / 100000000).toFixed(1) + '亿';
        if (num >= 10000) return (num / 10000).toFixed(1) + '万';
        return num.toLocaleString();
    }

    function log(...args) {
        if (CONFIG.DEBUG) {
            console.log('[BVQ-Home]', ...args);
        }
    }

    // ==================== 从页面提取 BV 号 ====================

    /**
     * 从视频卡片中提取 BV 号
     * B 站首页卡片的链接格式：/video/BV1xxxxxxxxx/
     */
    function extractBVID(cardEl) {
        // 方法 1：从卡片内的链接提取
        const links = cardEl.querySelectorAll('a[href*="/video/BV"]');
        for (const link of links) {
            const match = link.href.match(/\/video\/(BV[a-zA-Z0-9]+)/);
            if (match) return match[1];
        }

        // 方法 2：从卡片 data 属性提取
        const dataAttr = cardEl.getAttribute('data-bvid')
            || cardEl.querySelector('[data-bvid]')?.getAttribute('data-bvid');
        if (dataAttr) return dataAttr;

        // 方法 3：从外层链接提取
        const parentLink = cardEl.closest('a[href*="/video/BV"]');
        if (parentLink) {
            const match = parentLink.href.match(/\/video\/(BV[a-zA-Z0-9]+)/);
            if (match) return match[1];
        }

        return null;
    }

    // ==================== UI 渲染 ====================

    function createBadgeHTML(icon, label, badgeClass, detailHTML) {
        return `
            <div class="bvq-home-badge ${badgeClass}">
                <span>${icon}</span>
                <span>${label}</span>
                ${detailHTML || ''}
            </div>
        `;
    }

    function createDetailPanel(stats, quality) {
        const isGood = quality.isGood;
        return `
            <div class="bvq-detail-panel">
                <div class="bvq-detail-title">${isGood ? '🔥' : '📊'} 视频质量分析</div>
                <div class="bvq-detail-row">
                    <span class="bvq-detail-label">播放量</span>
                    <span class="bvq-detail-value">${formatCount(stats.plays)}</span>
                </div>
                <div class="bvq-detail-row">
                    <span class="bvq-detail-label">点赞数</span>
                    <span class="bvq-detail-value">${formatCount(stats.likes)}</span>
                </div>
                <div class="bvq-detail-row">
                    <span class="bvq-detail-label">投币数</span>
                    <span class="bvq-detail-value">${formatCount(stats.coins)}</span>
                </div>
                <div class="bvq-detail-divider"></div>
                <div class="bvq-detail-row">
                    <span class="bvq-detail-label">点赞率（≥5% 达标）</span>
                    <span class="bvq-detail-value ${quality.likePass ? 'bvq-pass' : 'bvq-fail'}">
                        ${formatPercent(quality.likeRatio)} ${quality.likePass ? '✅' : '❌'}
                    </span>
                </div>
                <div class="bvq-detail-row">
                    <span class="bvq-detail-label">投币率</span>
                    <span class="bvq-detail-value">${formatPercent(quality.coinRatio)}</span>
                </div>
                <div class="bvq-detail-row">
                    <span class="bvq-detail-label">投币阈值（点赞率/2）</span>
                    <span class="bvq-detail-value ${quality.coinPass ? 'bvq-pass' : 'bvq-fail'}">
                        ${formatPercent(quality.coinThreshold)} ${quality.coinPass ? '✅' : '❌'}
                    </span>
                </div>
                <div class="bvq-detail-divider"></div>
                <div class="bvq-detail-row">
                    <span class="bvq-detail-label">综合结论</span>
                    <span class="bvq-detail-value ${isGood ? 'bvq-pass' : 'bvq-fail'}">
                        ${isGood ? '🔥 优质视频' : '📊 普通视频'}
                    </span>
                </div>
            </div>
        `;
    }

    // ==================== 主处理逻辑 ====================

    // 已经处理过的卡片集合（避免重复处理）
    const processedCards = new WeakSet();

    /**
     * 扫描页面上的视频卡片，提取 BV 号并请求数据
     */
    function scanAndAnnotate() {
        // 选择所有可能的视频卡片容器
        const cardSelectors = [
            '.bili-video-card',                      // 首页推荐卡片
            '.feed-card .bili-video-card',            // Feed 流卡片
            '.recommended-card',                      // 推荐卡片
            '.video-card',                            // 通用视频卡片
            '.bili-video-card__wrap',                  // 包裹层
        ];

        const cards = document.querySelectorAll(cardSelectors.join(', '));
        let newCount = 0;

        cards.forEach(card => {
            // 跳过已处理的
            if (processedCards.has(card)) return;

            const bvid = extractBVID(card);
            if (!bvid) return;

            processedCards.add(card);
            newCount++;

            // 找到封面容器，用于放置标签
            const coverEl = card.querySelector('.bili-video-card__cover')
                || card.querySelector('.v-img')
                || card.querySelector('.cover-container')
                || card.querySelector('picture')?.parentElement
                || card.querySelector('.bili-video-card__image');

            // 如果找不到合适的封面容器，用卡片本身
            const targetEl = coverEl || card;

            // 确保容器是 relative
            const computedStyle = getComputedStyle(targetEl);
            if (computedStyle.position === 'static') {
                targetEl.style.position = 'relative';
            }

            // 先放一个 loading 标签
            const loadingBadge = document.createElement('div');
            loadingBadge.className = 'bvq-home-badge bvq-home-badge-loading';
            loadingBadge.innerHTML = '<span>⏳</span><span>分析中</span>';
            targetEl.appendChild(loadingBadge);

            // 排队请求 API
            apiQueue.enqueue(() => fetchVideoStat(bvid))
                .then(stats => {
                    const quality = evaluateQuality(stats);
                    log(`${bvid}: 播放${formatCount(stats.plays)} 赞${formatCount(stats.likes)} 币${formatCount(stats.coins)} → ${quality.isGood ? '优质' : '普通'}`);

                    // 替换 loading 标签
                    loadingBadge.remove();

                    const isGood = quality.isGood;
                    const badge = document.createElement('div');
                    badge.className = `bvq-home-badge ${isGood ? 'bvq-home-badge-good' : 'bvq-home-badge-normal'}`;
                    badge.innerHTML = `
                        <span>${isGood ? '🔥' : '📊'}</span>
                        <span>${isGood ? '优质' : '普通'}</span>
                        ${createDetailPanel(stats, quality)}
                    `;
                    targetEl.appendChild(badge);
                })
                .catch(err => {
                    log(`${bvid} 获取失败:`, err.message);
                    // 获取失败时移除 loading，显示错误状态
                    loadingBadge.innerHTML = '<span>⚠️</span>';
                    loadingBadge.title = '数据获取失败，刷新重试';
                });
        });

        if (newCount > 0) {
            log(`本次扫描发现 ${newCount} 个新视频卡片`);
        }
    }

    // ==================== 启动 ====================

    // 使用 MutationObserver 监听 DOM 变化（首页无限滚动加载新内容）
    let scanTimer = null;

    function debouncedScan() {
        if (scanTimer) clearTimeout(scanTimer);
        scanTimer = setTimeout(() => {
            scanAndAnnotate();
        }, 300);
    }

    // 监听页面 DOM 变化
    const observer = new MutationObserver((mutations) => {
        // 检查是否有新节点添加
        let hasNewNodes = false;
        for (const mutation of mutations) {
            if (mutation.addedNodes.length > 0) {
                hasNewNodes = true;
                break;
            }
        }
        if (hasNewNodes) {
            debouncedScan();
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
    });

    // 监听滚动事件（作为补充，确保滚动加载的新卡片也能被处理）
    let scrollTimer = null;
    window.addEventListener('scroll', () => {
        if (scrollTimer) clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
            scanAndAnnotate();
        }, CONFIG.SCAN_INTERVAL);
    }, { passive: true });

    // 首次扫描（延迟执行，等待页面渲染）
    setTimeout(scanAndAnnotate, 1500);

    // 定期补扫（兜底，防止某些动态加载的卡片漏掉）
    setInterval(scanAndAnnotate, 5000);

    log('Bilibili 首页视频质量标注脚本已启动 ✓');
})();
