// ==UserScript==
// @name         Bilibili 视频质量标注
// @namespace    https://github.com/bilibili-video-quality
// @version      1.0.0
// @description  根据播放量、点赞数、投币数的比值自动标注视频质量（好视频/普通视频）
// @author       fenghan
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ==================== 配置区 ====================
    const CONFIG = {
        // 点赞率阈值：点赞数 / 播放量 >= 5% 即为好视频
        LIKE_RATIO_THRESHOLD: 0.05,
        // 投币率阈值：投币数 / 播放量 >= 点赞率的一半 即为好视频
        // 即 投币率 >= 点赞率 / 2
        COIN_RATIO_FACTOR: 0.5,
        // 轮询间隔（毫秒），等待页面数据加载
        POLL_INTERVAL: 500,
        // 最大轮询次数
        MAX_POLL_COUNT: 40,
        // 调试模式
        DEBUG: false,
    };

    // ==================== 样式 ====================
    GM_addStyle(`
        .bvq-badge-container {
            display: inline-flex;
            align-items: center;
            margin-left: 12px;
            animation: bvq-fade-in 0.4s ease-out;
        }

        .bvq-badge {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 3px 12px;
            border-radius: 20px;
            font-size: 13px;
            font-weight: 600;
            letter-spacing: 0.5px;
            cursor: pointer;
            position: relative;
            transition: transform 0.2s ease, box-shadow 0.2s ease;
            user-select: none;
        }

        .bvq-badge:hover {
            transform: translateY(-1px);
        }

        .bvq-badge-good {
            background: linear-gradient(135deg, #ff6b9d 0%, #fb3a5e 100%);
            color: #fff;
            box-shadow: 0 2px 8px rgba(251, 58, 94, 0.35);
        }

        .bvq-badge-good:hover {
            box-shadow: 0 4px 14px rgba(251, 58, 94, 0.5);
        }

        .bvq-badge-normal {
            background: linear-gradient(135deg, #a8b8d8 0%, #8899bb 100%);
            color: #fff;
            box-shadow: 0 2px 8px rgba(136, 153, 187, 0.3);
        }

        .bvq-badge-normal:hover {
            box-shadow: 0 4px 14px rgba(136, 153, 187, 0.45);
        }

        /* 详情提示框 */
        .bvq-tooltip {
            display: none;
            position: absolute;
            top: calc(100% + 8px);
            left: 50%;
            transform: translateX(-50%);
            background: #fff;
            border-radius: 12px;
            padding: 14px 18px;
            box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
            z-index: 99999;
            min-width: 260px;
            font-weight: 400;
            color: #333;
            font-size: 13px;
            line-height: 1.7;
        }

        .bvq-badge:hover .bvq-tooltip {
            display: block;
        }

        .bvq-tooltip::before {
            content: '';
            position: absolute;
            top: -6px;
            left: 50%;
            transform: translateX(-50%);
            border-left: 6px solid transparent;
            border-right: 6px solid transparent;
            border-bottom: 6px solid #fff;
        }

        .bvq-tooltip-title {
            font-weight: 700;
            font-size: 14px;
            margin-bottom: 8px;
            padding-bottom: 6px;
            border-bottom: 1px solid #eee;
        }

        .bvq-tooltip-row {
            display: flex;
            justify-content: space-between;
            padding: 2px 0;
        }

        .bvq-tooltip-label {
            color: #999;
        }

        .bvq-tooltip-value {
            font-weight: 600;
        }

        .bvq-tooltip-value.bvq-pass {
            color: #fb3a5e;
        }

        .bvq-tooltip-value.bvq-fail {
            color: #999;
        }

        .bvq-tooltip-divider {
            height: 1px;
            background: #eee;
            margin: 6px 0;
        }

        @keyframes bvq-fade-in {
            from { opacity: 0; transform: translateY(-4px); }
            to   { opacity: 1; transform: translateY(0); }
        }
    `);

    // ==================== 工具函数 ====================

    /**
     * 解析 B 站数字文本，支持 "万" 和 "亿" 等单位
     * 例如: "1.2万" -> 12000, "156" -> 156, "3.5亿" -> 350000000
     */
    function parseNumber(text) {
        if (!text) return 0;
        text = text.trim().replace(/,/g, '');

        // 处理 "万" 单位
        if (text.includes('万')) {
            const num = parseFloat(text.replace('万', ''));
            return isNaN(num) ? 0 : Math.round(num * 10000);
        }

        // 处理 "亿" 单位
        if (text.includes('亿')) {
            const num = parseFloat(text.replace('亿', ''));
            return isNaN(num) ? 0 : Math.round(num * 100000000);
        }

        const num = parseInt(text, 10);
        return isNaN(num) ? 0 : num;
    }

    function log(...args) {
        if (CONFIG.DEBUG) {
            console.log('[BVQ]', ...args);
        }
    }

    // ==================== 数据获取 ====================

    /**
     * 从页面 DOM 中提取视频统计数据
     * B 站视频页面的数据结构：
     *   播放量: .video-info-detail .view-text 或 data 属性
     *   点赞数: .video-like-info .video-like-num
     *   投币数: .video-coin-info .video-coin-num
     */
    function extractVideoStats() {
        let plays = 0;
        let likes = 0;
        let coins = 0;

        // --- 播放量 ---
        // 新版页面
        const viewEl = document.querySelector('.video-info-detail-list .item:first-child .view-text')
            || document.querySelector('.video-info-detail .view-text')
            || document.querySelector('.video-data-list .view .video-data-text');
        if (viewEl) {
            plays = parseNumber(viewEl.textContent);
        }

        // 尝试从播放器内获取
        if (plays === 0) {
            const viewSpan = document.querySelector('.bpx-player-video-info-online span');
            if (viewSpan) {
                plays = parseNumber(viewSpan.textContent);
            }
        }

        // --- 点赞数 ---
        const likeEl = document.querySelector('.video-like .video-like-info')
            || document.querySelector('.video-toolbar-left-item .video-like-info')
            || document.querySelector('[data-v-like] .info-text');
        if (likeEl) {
            likes = parseNumber(likeEl.textContent);
        }

        // --- 投币数 ---
        const coinEl = document.querySelector('.video-coin .video-coin-info')
            || document.querySelector('.video-toolbar-left-item .video-coin-info')
            || document.querySelector('[data-v-coin] .info-text');
        if (coinEl) {
            coins = parseNumber(coinEl.textContent);
        }

        log('提取到数据 -', '播放:', plays, '点赞:', likes, '投币:', coins);
        return { plays, likes, coins };
    }

    // ==================== 质量评估 ====================

    /**
     * 评估视频质量
     * 规则：
     *   1. 点赞率 = 点赞数 / 播放量 >= 5%  → 好视频
     *   2. 投币率 = 投币数 / 播放量 >= 点赞率 / 2  → 好视频
     *   满足任意一条即为好视频
     */
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
                reason: '播放量为0，无法评估',
            };
        }

        const likeRatio = likes / plays;
        const coinRatio = coins / plays;
        const coinThreshold = likeRatio * CONFIG.COIN_RATIO_FACTOR;

        const likePass = likeRatio >= CONFIG.LIKE_RATIO_THRESHOLD;
        const coinPass = coinRatio >= coinThreshold && coinThreshold > 0;

        const isGood = likePass || coinPass;

        const reasons = [];
        if (likePass) reasons.push(`点赞率 ${(likeRatio * 100).toFixed(2)}% ≥ ${CONFIG.LIKE_RATIO_THRESHOLD * 100}%`);
        if (coinPass) reasons.push(`投币率 ${(coinRatio * 100).toFixed(2)}% ≥ 点赞率一半 ${(coinThreshold * 100).toFixed(2)}%`);
        if (!isGood) reasons.push('未达到好视频标准');

        return {
            isGood,
            likeRatio,
            coinRatio,
            likeThreshold: CONFIG.LIKE_RATIO_THRESHOLD,
            coinThreshold,
            likePass,
            coinPass,
            reason: reasons.join('；'),
        };
    }

    // ==================== UI 渲染 ====================

    function formatPercent(ratio) {
        return (ratio * 100).toFixed(2) + '%';
    }

    function formatCount(num) {
        if (num >= 100000000) return (num / 100000000).toFixed(1) + '亿';
        if (num >= 10000) return (num / 10000).toFixed(1) + '万';
        return num.toLocaleString();
    }

    function createBadge(stats, quality) {
        // 移除旧标注
        document.querySelectorAll('.bvq-badge-container').forEach(el => el.remove());

        const container = document.createElement('span');
        container.className = 'bvq-badge-container';

        const isGood = quality.isGood;
        const icon = isGood ? '🔥' : '📊';
        const label = isGood ? '优质视频' : '普通视频';
        const badgeClass = isGood ? 'bvq-badge-good' : 'bvq-badge-normal';

        container.innerHTML = `
            <span class="bvq-badge ${badgeClass}">
                <span>${icon}</span>
                <span>${label}</span>
                <div class="bvq-tooltip">
                    <div class="bvq-tooltip-title">${icon} 视频质量分析</div>
                    <div class="bvq-tooltip-row">
                        <span class="bvq-tooltip-label">播放量</span>
                        <span class="bvq-tooltip-value">${formatCount(stats.plays)}</span>
                    </div>
                    <div class="bvq-tooltip-row">
                        <span class="bvq-tooltip-label">点赞数</span>
                        <span class="bvq-tooltip-value">${formatCount(stats.likes)}</span>
                    </div>
                    <div class="bvq-tooltip-row">
                        <span class="bvq-tooltip-label">投币数</span>
                        <span class="bvq-tooltip-value">${formatCount(stats.coins)}</span>
                    </div>
                    <div class="bvq-tooltip-divider"></div>
                    <div class="bvq-tooltip-row">
                        <span class="bvq-tooltip-label">点赞率（≥5%为好）</span>
                        <span class="bvq-tooltip-value ${quality.likePass ? 'bvq-pass' : 'bvq-fail'}">${formatPercent(quality.likeRatio)} ${quality.likePass ? '✅' : '❌'}</span>
                    </div>
                    <div class="bvq-tooltip-row">
                        <span class="bvq-tooltip-label">投币率</span>
                        <span class="bvq-tooltip-value">${formatPercent(quality.coinRatio)}</span>
                    </div>
                    <div class="bvq-tooltip-row">
                        <span class="bvq-tooltip-label">投币率阈值（点赞率/2）</span>
                        <span class="bvq-tooltip-value ${quality.coinPass ? 'bvq-pass' : 'bvq-fail'}">${formatPercent(quality.coinThreshold)} ${quality.coinPass ? '✅' : '❌'}</span>
                    </div>
                    <div class="bvq-tooltip-divider"></div>
                    <div class="bvq-tooltip-row">
                        <span class="bvq-tooltip-label">综合结论</span>
                        <span class="bvq-tooltip-value ${isGood ? 'bvq-pass' : 'bvq-fail'}">${label}</span>
                    </div>
                </div>
            </span>
        `;

        // 插入到视频标题旁边
        const titleEl = document.querySelector('.video-info-title .video-title')
            || document.querySelector('#viewbox_report .video-title')
            || document.querySelector('.video-info-title');

        if (titleEl) {
            titleEl.parentNode.insertBefore(container, titleEl.nextSibling);
            log('标注已插入到标题旁');
        } else {
            // 备用位置：视频信息区域
            const infoEl = document.querySelector('.video-info-detail')
                || document.querySelector('#viewbox_report');
            if (infoEl) {
                infoEl.appendChild(container);
                log('标注已插入到信息区');
            }
        }
    }

    // ==================== 主逻辑 ====================

    function run() {
        let pollCount = 0;

        const timer = setInterval(() => {
            pollCount++;
            const stats = extractVideoStats();

            // 等数据加载完成（至少播放量 > 0）
            if (stats.plays > 0) {
                clearInterval(timer);
                const quality = evaluateQuality(stats);
                log('评估结果:', quality);
                createBadge(stats, quality);
            }

            if (pollCount >= CONFIG.MAX_POLL_COUNT) {
                clearInterval(timer);
                log('超时：未能获取到视频数据');
            }
        }, CONFIG.POLL_INTERVAL);
    }

    // 监听 URL 变化（B站 SPA 路由切换）
    let lastUrl = location.href;
    const observer = new MutationObserver(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            log('页面切换，重新评估:', lastUrl);
            // 延迟执行，等待新页面 DOM 加载
            setTimeout(run, 1000);
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // 首次运行
    run();

    log('Bilibili 视频质量标注脚本已启动 ✓');
})();
