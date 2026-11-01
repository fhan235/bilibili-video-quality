// ==UserScript==
// @name         Bilibili 视频质量标注
// @namespace    https://github.com/fhan235/bilibili-video-quality
// @version      4.0.1
// @description  在 B 站首页、分区、热门、搜索、视频页侧边推荐、UP 主空间和视频详情页，按点赞 / 投币 / 收藏率给视频打出 S/A/B/C 质量等级，可淡化或隐藏低质视频
// @author       fenghan
// @match        https://www.bilibili.com/*
// @match        https://search.bilibili.com/*
// @match        https://space.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      api.bilibili.com
// @run-at       document-idle
// @noframes
// @license      MIT
// @homepageURL  https://github.com/fhan235/bilibili-video-quality
// @updateURL    https://raw.githubusercontent.com/fhan235/bilibili-video-quality/master/bilibili-video-quality.user.js
// @downloadURL  https://raw.githubusercontent.com/fhan235/bilibili-video-quality/master/bilibili-video-quality.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ==================== 常量 ====================

    const STORE = { settings: 'bvq:settings', cache: 'bvq:cache', baseline: 'bvq:baseline' };
    const API_VIEW = 'https://api.bilibili.com/x/web-interface/view';
    const BVID_RE = /\/video\/(BV[0-9A-Za-z]{10})/;
    const BVID_ONLY = /^BV[0-9A-Za-z]{10}$/;

    // 风控 / 限流：暂停队列并指数退避
    const RATE_LIMIT_CODES = new Set([-412, -509, -799, -352]);
    // 视频不存在、已删除、无权限：不再重试
    const GONE_CODES = new Set([-403, -404, 62002, 62004, 62012]);
    const MAX_RETRIES = 3;
    const MAX_BACKOFF_MS = 60000;

    // B 站视频的大致平均水平，用于平滑与固定标准
    const PRIOR = { like: 0.035, coin: 0.008, fav: 0.010 };
    const WEIGHT = { like: 0.4, coin: 0.35, fav: 0.25 };
    // 平滑强度：相当于先给每个视频加上 2000 次「平均水平」的播放，小样本的比率会被拉向平均值
    const PRIOR_VIEWS = 2000;
    // 固定标准：综合分（相对全站平均的对数比，0 = 平均水平）
    const FIXED_CUTS = { S: 0.8, A: 0.25, B: -0.35 };
    // 分区自适应：在本地同分区样本中超过多少比例
    const PERCENTILE_CUTS = { S: 0.9, A: 0.65, B: 0.25 };

    const BASELINE_MIN_SAMPLES = 30;
    const BASELINE_MAX_SAMPLES = 300;
    const BASELINE_MAX_ZONES = 120;
    const CACHE_MAX = 2000;
    const SAVE_DELAY_MS = 3000;
    const SCAN_THROTTLE_MS = 250;
    const POLL_MS = 2000;
    const HYDRATION_TIMEOUT_MS = 20000;

    const SCENE_LABELS = {
        home: '首页 / 分区 / 频道页',
        popular: '热门 / 排行榜 / 每周必看',
        search: '搜索结果页',
        sidebar: '视频页右侧推荐列表',
        detail: '视频详情页标题旁',
        space: 'UP 主空间',
    };

    const DEFAULTS = Object.freeze({
        gradeMode: 'adaptive', // adaptive：按本地同分区分布；fixed：按固定标准
        minViews: 1000,
        newHours: 24,
        lowAction: 'none', // none | dim | hide
        cacheHours: 2,
        concurrency: 3,
        delay: 250,
        scenes: Object.freeze({ home: true, popular: true, search: true, sidebar: true, detail: true, space: true }),
    });

    // 不同页面的视频卡片：选择器 + 标注插入位置
    const CARD_TYPES = [
        {
            selector: '.bili-video-card',
            compact: false,
            place(card) {
                const bottom = card.querySelector('.bili-video-card__info--bottom');
                if (bottom) return { after: bottom };
                const info = card.querySelector('.bili-video-card__details, .bili-video-card__info--right, .bili-video-card__info');
                return info ? { append: info } : null;
            },
        },
        { selector: '.video-page-card-small', compact: true, place: (card) => appendTo(card, '.info') },
        { selector: '.video-card', compact: false, place: (card) => appendTo(card, '.video-card__info') },
        { selector: '.rank-item', compact: false, place: (card) => appendTo(card, '.info') },
        {
            selector: '.small-item',
            compact: true,
            place(card) {
                const meta = card.querySelector('.meta');
                return meta ? { after: meta } : null;
            },
        },
    ];

    // ==================== 存储 ====================

    function gmGet(key, fallback) {
        try {
            const value = GM_getValue(key, fallback);
            return value === undefined ? fallback : value;
        } catch (error) {
            return fallback;
        }
    }

    function gmSet(key, value) {
        try {
            GM_setValue(key, value);
        } catch (error) {
            console.warn('[BVQ] 写入存储失败', error);
        }
    }

    function gmDelete(key) {
        try {
            GM_deleteValue(key);
        } catch (error) {
            // ignore
        }
    }

    function normalizeSettings(raw) {
        const source = raw && typeof raw === 'object' ? raw : {};
        const int = (value, fallback, low, high) => {
            if (value === undefined || value === null || value === '') return fallback;
            const number = Math.round(Number(value));
            return Number.isFinite(number) ? Math.min(high, Math.max(low, number)) : fallback;
        };
        const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
        const scenes = {};
        Object.keys(DEFAULTS.scenes).forEach((key) => {
            const value = source.scenes && source.scenes[key];
            scenes[key] = typeof value === 'boolean' ? value : DEFAULTS.scenes[key];
        });
        return {
            gradeMode: pick(source.gradeMode, ['adaptive', 'fixed'], DEFAULTS.gradeMode),
            minViews: int(source.minViews, DEFAULTS.minViews, 0, 1000000),
            newHours: int(source.newHours, DEFAULTS.newHours, 0, 720),
            lowAction: pick(source.lowAction, ['none', 'dim', 'hide'], DEFAULTS.lowAction),
            cacheHours: int(source.cacheHours, DEFAULTS.cacheHours, 1, 48),
            concurrency: int(source.concurrency, DEFAULTS.concurrency, 1, 6),
            delay: int(source.delay, DEFAULTS.delay, 0, 5000),
            scenes,
        };
    }

    let settings = normalizeSettings(gmGet(STORE.settings, null));

    // ---------- 数据缓存（跨页面持久化） ----------

    const memCache = new Map(); // bvid -> { ts, d }
    const saveTimers = { cache: 0, baseline: 0 };

    function isCacheEntry(value) {
        return value && typeof value === 'object' && typeof value.ts === 'number' && value.d && typeof value.d === 'object';
    }

    function cacheTtl() {
        return settings.cacheHours * 3600 * 1000;
    }

    function loadCache() {
        const stored = gmGet(STORE.cache, null);
        if (!stored || typeof stored !== 'object') return;
        const now = Date.now();
        Object.entries(stored)
            .filter(([bvid, entry]) => BVID_ONLY.test(bvid) && isCacheEntry(entry) && now - entry.ts < cacheTtl())
            .sort((left, right) => left[1].ts - right[1].ts)
            .forEach(([bvid, entry]) => memCache.set(bvid, entry));
    }

    function getCached(bvid) {
        const entry = memCache.get(bvid);
        if (!entry) return null;
        if (Date.now() - entry.ts >= cacheTtl()) {
            memCache.delete(bvid);
            return null;
        }
        return entry.d;
    }

    function putCache(bvid, data) {
        memCache.delete(bvid);
        memCache.set(bvid, { ts: Date.now(), d: data });
        while (memCache.size > CACHE_MAX) {
            memCache.delete(memCache.keys().next().value);
        }
        scheduleSave('cache');
    }

    // 多个标签页会各自写入，保存时与已存储的数据合并，避免互相覆盖
    function saveCache() {
        const now = Date.now();
        const merged = new Map();
        const stored = gmGet(STORE.cache, null);
        if (stored && typeof stored === 'object') {
            Object.entries(stored).forEach(([bvid, entry]) => {
                if (BVID_ONLY.test(bvid) && isCacheEntry(entry) && now - entry.ts < cacheTtl()) merged.set(bvid, entry);
            });
        }
        memCache.forEach((entry, bvid) => {
            if (now - entry.ts >= cacheTtl()) return;
            const existing = merged.get(bvid);
            if (!existing || existing.ts < entry.ts) merged.set(bvid, entry);
        });
        const entries = [...merged.entries()].sort((left, right) => right[1].ts - left[1].ts).slice(0, CACHE_MAX);
        gmSet(STORE.cache, Object.fromEntries(entries));
    }

    // ---------- 分区本地基准 ----------

    const baseline = new Map(); // zone -> [[bvid, score], ...]

    function loadBaseline() {
        const stored = gmGet(STORE.baseline, null);
        if (!Array.isArray(stored)) return;
        stored.slice(0, BASELINE_MAX_ZONES).forEach((item) => {
            if (!Array.isArray(item) || typeof item[0] !== 'string' || !Array.isArray(item[1])) return;
            const samples = item[1]
                .filter((sample) => Array.isArray(sample) && typeof sample[0] === 'string' && Number.isFinite(sample[1]))
                .slice(-BASELINE_MAX_SAMPLES);
            if (samples.length) baseline.set(item[0].slice(0, 20), samples);
        });
    }

    function saveBaseline() {
        gmSet(STORE.baseline, [...baseline.entries()]);
    }

    function scheduleSave(kind) {
        if (saveTimers[kind]) return;
        saveTimers[kind] = setTimeout(() => {
            saveTimers[kind] = 0;
            if (kind === 'cache') saveCache();
            else saveBaseline();
        }, SAVE_DELAY_MS);
    }

    function flushSaves() {
        if (saveTimers.cache) {
            clearTimeout(saveTimers.cache);
            saveTimers.cache = 0;
            saveCache();
        }
        if (saveTimers.baseline) {
            clearTimeout(saveTimers.baseline);
            saveTimers.baseline = 0;
            saveBaseline();
        }
    }

    function ageHoursOf(data) {
        return data.pubdate ? (Date.now() / 1000 - data.pubdate) / 3600 : Infinity;
    }

    function recordBaseline(bvid, data) {
        // 只用样本充足、发布超过「新视频」时长的数据，避免早期数据把分区基准带偏
        if (!data.zone || data.view < Math.max(settings.minViews, 1) || ageHoursOf(data) < settings.newHours) return;
        let list = baseline.get(data.zone);
        if (!list) {
            if (baseline.size >= BASELINE_MAX_ZONES) return;
            list = [];
            baseline.set(data.zone, list);
        }
        const index = list.findIndex((sample) => sample[0] === bvid);
        if (index >= 0) list.splice(index, 1);
        list.push([bvid, Math.round(computeScore(data).score * 1000) / 1000]);
        if (list.length > BASELINE_MAX_SAMPLES) list.splice(0, list.length - BASELINE_MAX_SAMPLES);
        scheduleSave('baseline');
    }

    function zoneSampleCount(zone) {
        return (zone && baseline.get(zone)?.length) || 0;
    }

    function zonePercentile(zone, score) {
        const list = zone ? baseline.get(zone) : null;
        if (!list || list.length < BASELINE_MIN_SAMPLES) return null;
        let below = 0;
        let equal = 0;
        list.forEach(([, value]) => {
            if (value < score) below += 1;
            else if (value === score) equal += 1;
        });
        return (below + equal / 2) / list.length;
    }

    // ==================== 评分 ====================

    function smoothRate(count, views, prior) {
        return (count + prior * PRIOR_VIEWS) / (views + PRIOR_VIEWS);
    }

    /**
     * 综合分：点赞 / 投币 / 收藏三个比率（平滑后）相对全站平均的对数比加权和。
     * 0 = 平均水平，+1 ≈ 各项都是平均的 2 倍，-1 ≈ 各项都只有一半。
     */
    function computeScore(data) {
        const rates = {};
        const smoothed = {};
        let score = 0;
        Object.keys(PRIOR).forEach((key) => {
            rates[key] = data.view > 0 ? data[key] / data.view : 0;
            smoothed[key] = smoothRate(data[key], data.view, PRIOR[key]);
            const ratio = Math.log2(smoothed[key] / PRIOR[key]);
            score += WEIGHT[key] * Math.min(3, Math.max(-3, ratio));
        });
        return { rates, smoothed, score };
    }

    function gradeByCuts(value, cuts) {
        if (value >= cuts.S) return 'S';
        if (value >= cuts.A) return 'A';
        if (value >= cuts.B) return 'B';
        return 'C';
    }

    function evaluate(data) {
        const { rates, smoothed, score } = computeScore(data);
        const ageHours = ageHoursOf(data);
        const lowSample = data.view < settings.minViews;
        let grade = null;
        let percentile = null;
        let basis = 'fixed';

        if (!lowSample) {
            if (settings.gradeMode === 'adaptive') {
                percentile = zonePercentile(data.zone, score);
                if (percentile !== null) {
                    basis = 'zone';
                    grade = gradeByCuts(percentile, PERCENTILE_CUTS);
                }
            }
            if (!grade) grade = gradeByCuts(score, FIXED_CUTS);
        }

        return {
            grade,
            score,
            rates,
            smoothed,
            percentile,
            basis,
            ageHours,
            lowSample,
            isNew: ageHours < settings.newHours,
            zoneSamples: zoneSampleCount(data.zone),
        };
    }

    // ==================== 请求 ====================

    function toCount(value) {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
    }

    function pickStats(data) {
        const stat = data.stat || {};
        return {
            view: toCount(stat.view),
            like: toCount(stat.like),
            coin: toCount(stat.coin),
            fav: toCount(stat.favorite),
            share: toCount(stat.share),
            reply: toCount(stat.reply),
            danmaku: toCount(stat.danmaku),
            pubdate: toCount(data.pubdate),
            zone: String(data.tname || data.tname_v2 || '').slice(0, 20),
        };
    }

    function requestView(bvid) {
        return new Promise((resolve, reject) => {
            const fail = (message, flags) => reject(Object.assign(new Error(message), flags || {}));
            GM_xmlhttpRequest({
                method: 'GET',
                url: `${API_VIEW}?bvid=${encodeURIComponent(bvid)}`,
                headers: { Referer: 'https://www.bilibili.com/' },
                responseType: 'json',
                timeout: 10000,
                onload(response) {
                    if (response.status === 412 || response.status === 429) {
                        fail('请求过于频繁，已自动放慢', { rateLimited: true, retryable: true });
                        return;
                    }
                    let result = response.response;
                    if (typeof result === 'string') {
                        try {
                            result = JSON.parse(result);
                        } catch (error) {
                            result = null;
                        }
                    }
                    if ((!result || typeof result !== 'object') && response.responseText) {
                        try {
                            result = JSON.parse(response.responseText);
                        } catch (error) {
                            result = null;
                        }
                    }
                    if (!result || typeof result !== 'object') {
                        fail(`响应异常（HTTP ${response.status}）`, { retryable: true });
                        return;
                    }
                    if (result.code === 0 && result.data && result.data.stat) {
                        resolve(pickStats(result.data));
                        return;
                    }
                    if (RATE_LIMIT_CODES.has(result.code)) {
                        fail('请求过于频繁，已自动放慢', { rateLimited: true, retryable: true });
                        return;
                    }
                    if (GONE_CODES.has(result.code)) {
                        fail(result.message || '视频不可用', { gone: true });
                        return;
                    }
                    fail(result.message || `接口错误 ${result.code}`, { retryable: true });
                },
                onerror() {
                    fail('网络错误', { retryable: true });
                },
                ontimeout() {
                    fail('请求超时', { retryable: true });
                },
            });
        });
    }

    /** 并发受限的请求队列：遇到限流时整体暂停并指数退避，失败自动重试 */
    class RequestQueue {
        constructor() {
            this.items = [];
            this.running = 0;
            this.pausedUntil = 0;
            this.backoff = 0;
            this.timer = 0;
        }

        add(task, priority) {
            return new Promise((resolve, reject) => {
                const item = { task, resolve, reject, tries: 0 };
                if (priority) this.items.unshift(item);
                else this.items.push(item);
                this.pump();
            });
        }

        pump() {
            if (this.timer) return;
            const wait = this.pausedUntil - Date.now();
            if (wait > 0) {
                this.timer = setTimeout(() => {
                    this.timer = 0;
                    this.pump();
                }, wait);
                return;
            }
            while (this.running < settings.concurrency && this.items.length) {
                this.run(this.items.shift());
            }
        }

        async run(item) {
            this.running += 1;
            try {
                const value = await item.task();
                this.backoff = 0;
                item.resolve(value);
            } catch (error) {
                if (error.rateLimited) {
                    this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff ? this.backoff * 2 : 5000);
                    this.pausedUntil = Date.now() + this.backoff;
                }
                if (error.retryable && item.tries < MAX_RETRIES) {
                    item.tries += 1;
                    if (error.rateLimited) {
                        this.items.unshift(item);
                    } else {
                        setTimeout(() => {
                            this.items.push(item);
                            this.pump();
                        }, 1500 * item.tries);
                    }
                } else {
                    item.reject(error);
                }
            } finally {
                this.running -= 1;
                setTimeout(() => this.pump(), settings.delay);
            }
        }
    }

    const queue = new RequestQueue();
    const inflight = new Map(); // bvid -> Promise，同一视频同时只发一个请求

    function getStats(bvid, options) {
        const { priority = false } = options || {};
        const cached = getCached(bvid);
        if (cached) return Promise.resolve(cached);
        if (inflight.has(bvid)) return inflight.get(bvid);
        const promise = queue
            .add(() => requestView(bvid), priority)
            .then((data) => {
                putCache(bvid, data);
                recordBaseline(bvid, data);
                return data;
            })
            .finally(() => inflight.delete(bvid));
        inflight.set(bvid, promise);
        return promise;
    }

    // ==================== 格式化 ====================

    function fmtCount(value) {
        if (value >= 100000000) return `${(value / 100000000).toFixed(1)}亿`;
        if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
        return String(value);
    }

    function pct(ratio, digits) {
        return `${(ratio * 100).toFixed(digits)}%`;
    }

    function ageText(hours) {
        if (!Number.isFinite(hours)) return '未知';
        if (hours < 1) return '不到 1 小时前';
        if (hours < 48) return `${Math.floor(hours)} 小时前`;
        if (hours < 24 * 60) return `${Math.floor(hours / 24)} 天前`;
        const date = new Date(Date.now() - hours * 3600 * 1000);
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function appendTo(card, selector) {
        const target = card.querySelector(selector);
        return target ? { append: target } : null;
    }

    // ==================== 标注渲染 ====================

    const barInfo = new WeakMap(); // bar -> { d, ev }
    const retryHandlers = new WeakMap(); // bar -> () => void

    function buildBar(kind) {
        const bar = el('div', `bvq-bar bvq-bar--${kind}`);
        bar.addEventListener('click', (event) => {
            if (!(event.target instanceof Element) || !event.target.closest('.bvq-retry')) return;
            event.preventDefault();
            event.stopPropagation();
            const retry = retryHandlers.get(bar);
            if (retry) retry();
        });
        return bar;
    }

    function gradeChip(ev) {
        if (ev.lowSample) return el('span', 'bvq-grade bvq-grade--na', '样本少');
        return el('span', `bvq-grade bvq-grade--${ev.grade}`, ev.grade);
    }

    function renderLoading(bar) {
        barInfo.delete(bar);
        retryHandlers.delete(bar);
        bar.dataset.state = 'loading';
        bar.replaceChildren(el('span', 'bvq-grade bvq-grade--loading', '…'));
    }

    function renderError(bar, error, onRetry) {
        barInfo.delete(bar);
        bar.dataset.state = 'error';
        const nodes = [el('span', 'bvq-grade bvq-grade--na', error.gone ? '不可用' : '⚠')];
        if (!error.gone && onRetry) {
            const retry = el('span', 'bvq-retry', '重试');
            retry.title = `获取失败：${error.message}`;
            nodes.push(retry);
            retryHandlers.set(bar, onRetry);
        } else {
            retryHandlers.delete(bar);
        }
        bar.replaceChildren(...nodes);
    }

    function renderResult(bar, data, ev) {
        retryHandlers.delete(bar);
        bar.dataset.state = 'ok';
        bar.dataset.grade = ev.lowSample ? 'na' : ev.grade;
        const nodes = [gradeChip(ev)];
        if (ev.isNew) nodes.push(el('span', 'bvq-new', '新'));
        const digits = bar.classList.contains('bvq-bar--detail') ? 2 : 1;
        [['like', '👍'], ['coin', '🪙'], ['fav', '⭐']].forEach(([key, icon]) => {
            const item = el('span', 'bvq-stat', `${icon}${pct(ev.rates[key], digits)}`);
            if (!ev.lowSample && ev.smoothed[key] >= PRIOR[key] * 1.5) item.classList.add('bvq-hi');
            nodes.push(item);
        });
        bar.replaceChildren(...nodes);
        barInfo.set(bar, { d: data, ev });
    }

    // ---------- 悬浮详情 ----------

    let tipEl = null;
    let tipBar = null;

    function headline(data, ev) {
        if (ev.lowSample) return `播放不足 ${settings.minViews}，暂不评级`;
        if (ev.basis === 'zone') return `在本地「${data.zone}」区样本中超过 ${Math.round(ev.percentile * 100)}%`;
        if (settings.gradeMode === 'adaptive' && data.zone) {
            return `「${data.zone}」区本地样本 ${ev.zoneSamples}/${BASELINE_MIN_SAMPLES}，暂按固定标准`;
        }
        return '按固定标准（相对全站平均水平）';
    }

    function buildTip(data, ev) {
        const head = el('div', 'bvq-tip-head');
        head.append(gradeChip(ev), el('span', 'bvq-tip-headline', headline(data, ev)));

        const rows = [
            ['播放', fmtCount(data.view)],
            ['点赞', `${fmtCount(data.like)} · ${pct(ev.rates.like, 2)}`],
            ['投币', `${fmtCount(data.coin)} · ${pct(ev.rates.coin, 2)}`],
            ['收藏', `${fmtCount(data.fav)} · ${pct(ev.rates.fav, 2)}`],
            ['分区', data.zone || '未知'],
            ['发布', ageText(ev.ageHours)],
            ['综合分', `${ev.score >= 0 ? '+' : ''}${ev.score.toFixed(2)}（0 为全站平均水平）`],
        ];
        const table = el('div', 'bvq-tip-rows');
        rows.forEach(([label, value]) => {
            const row = el('div', 'bvq-tip-row');
            row.append(el('span', 'bvq-tip-label', label), el('span', 'bvq-tip-value', value));
            table.append(row);
        });

        const notes = el('div', 'bvq-tip-notes');
        if (ev.isNew) notes.append(el('div', '', `发布不足 ${settings.newHours} 小时，数据仍在快速变化，仅供参考。`));
        notes.append(el('div', '', '平均水平参考：点赞 3.5% · 投币 0.8% · 收藏 1.0%；小样本已向平均值平滑。'));

        return [head, table, notes];
    }

    function hideTip() {
        tipBar = null;
        if (tipEl) tipEl.hidden = true;
    }

    function showTip(bar) {
        const info = barInfo.get(bar);
        if (!info) {
            hideTip();
            return;
        }
        if (!tipEl) {
            tipEl = el('div', 'bvq-tip');
            tipEl.hidden = true;
            document.body.append(tipEl);
        }
        tipEl.replaceChildren(...buildTip(info.d, info.ev));
        tipEl.hidden = false;
        const rect = bar.getBoundingClientRect();
        const width = tipEl.offsetWidth;
        const height = tipEl.offsetHeight;
        const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
        let top = rect.bottom + 6;
        if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
        tipEl.style.left = `${left}px`;
        tipEl.style.top = `${top}px`;
    }

    function setupTooltip() {
        document.addEventListener(
            'mouseover',
            (event) => {
                const bar = event.target instanceof Element ? event.target.closest('.bvq-bar') : null;
                if (bar === tipBar) return;
                tipBar = bar;
                if (bar) showTip(bar);
                else hideTip();
            },
            true,
        );
        window.addEventListener('scroll', hideTip, { passive: true, capture: true });
    }

    // ==================== 页面场景 ====================

    function pageScene() {
        const host = location.hostname;
        const path = location.pathname;
        if (host === 'search.bilibili.com') return { cards: 'search', detail: false };
        if (host === 'space.bilibili.com') return { cards: 'space', detail: false };
        if (/^\/(video|list)\//.test(path)) return { cards: 'sidebar', detail: true };
        if (/^\/v\/popular\//.test(path)) return { cards: 'popular', detail: false };
        if (/^\/(bangumi|read|opus|account|cheese|blackboard)\//.test(path)) return { cards: null, detail: false };
        return { cards: 'home', detail: false };
    }

    let scene = pageScene();

    // ==================== 卡片标注 ====================

    const cardState = new WeakMap(); // card -> { bvid, bar, lowTarget, data }
    const tracked = new Set();

    function extractBvid(card) {
        const candidates = [];
        if (card.matches('a[href]')) candidates.push(card);
        candidates.push(...card.querySelectorAll('a[href*="/video/BV"]'));
        const outer = card.closest('a[href*="/video/BV"]');
        if (outer) candidates.push(outer);
        for (const link of candidates) {
            const match = String(link.getAttribute('href') || '').match(BVID_RE);
            if (match) return match[1];
        }
        const attr = card.getAttribute('data-bvid');
        return attr && BVID_ONLY.test(attr) ? attr : null;
    }

    function insertBar(target, bar) {
        if (target.after) target.after.after(bar);
        else target.append.append(bar);
    }

    function lowTargetOf(card) {
        // 隐藏时要隐藏整个网格项，否则会留下空位
        return card.closest('.feed-card, .bili-feed-card, .video-list-item') || card;
    }

    function clearLow(state) {
        if (state.lowTarget) state.lowTarget.classList.remove('bvq-low-dim', 'bvq-low-hide');
        state.lowTarget = null;
    }

    function applyLow(card, state, ev) {
        clearLow(state);
        if (settings.lowAction === 'none' || ev.lowSample || ev.isNew || ev.grade !== 'C') return;
        state.lowTarget = lowTargetOf(card);
        state.lowTarget.classList.add(settings.lowAction === 'hide' ? 'bvq-low-hide' : 'bvq-low-dim');
    }

    function applyResult(card, state, data) {
        state.data = data;
        const ev = evaluate(data);
        renderResult(state.bar, data, ev);
        applyLow(card, state, ev);
    }

    const io =
        typeof IntersectionObserver === 'function'
            ? new IntersectionObserver(
                  (entries) => {
                      entries.forEach((entry) => {
                          if (!entry.isIntersecting) return;
                          io.unobserve(entry.target);
                          loadCard(entry.target);
                      });
                  },
                  { rootMargin: '400px 0px' },
              )
            : null;

    function loadCard(card) {
        const state = cardState.get(card);
        if (!state || state.data) return;
        renderLoading(state.bar);
        getStats(state.bvid)
            .then((data) => {
                if (cardState.get(card) === state) applyResult(card, state, data);
            })
            .catch((error) => {
                if (cardState.get(card) !== state) return;
                renderError(state.bar, error, () => loadCard(card));
            });
    }

    function untrack(card) {
        const state = cardState.get(card);
        if (state) {
            state.bar.remove();
            clearLow(state);
        }
        cardState.delete(card);
        tracked.delete(card);
        if (io) io.unobserve(card);
    }

    function processCard(card, type) {
        if (card.closest('.bvq-bar')) return;
        const bvid = extractBvid(card);
        const state = cardState.get(card);
        if (!bvid) {
            // 卡片被复用为广告 / 直播等非视频内容
            if (state) untrack(card);
            return;
        }
        if (state && state.bvid === bvid && state.bar.isConnected) return;

        // 信息区还没渲染出来（骨架屏）时不做标记，下次扫描再试
        const target = type.place(card);
        if (!target) return;

        if (state) {
            state.bar.remove();
            clearLow(state);
        }

        const bar = buildBar(type.compact ? 'compact' : 'card');
        insertBar(target, bar);
        const next = { bvid, bar, lowTarget: null, data: null };
        cardState.set(card, next);
        tracked.add(card);

        const cached = getCached(bvid);
        if (cached) {
            applyResult(card, next, cached);
        } else if (io) {
            bar.dataset.state = 'pending';
            io.observe(card);
        } else {
            loadCard(card);
        }
    }

    function scanCards() {
        tracked.forEach((card) => {
            if (!card.isConnected) untrack(card);
        });
        if (!scene.cards || !settings.scenes[scene.cards]) return;
        CARD_TYPES.forEach((type) => {
            document.querySelectorAll(type.selector).forEach((card) => processCard(card, type));
        });
    }

    // ==================== 视频详情页 ====================

    const detail = { bvid: '', bar: null, data: null, error: null, seq: 0, renderedKey: '' };

    function currentDetailBvid() {
        const match = location.pathname.match(BVID_RE);
        if (match) return match[1];
        const query = new URLSearchParams(location.search).get('bvid');
        return query && BVID_ONLY.test(query) ? query : '';
    }

    function resetDetail() {
        detail.seq += 1;
        if (detail.bar) detail.bar.remove();
        detail.bvid = '';
        detail.bar = null;
        detail.data = null;
        detail.error = null;
        detail.renderedKey = '';
    }

    function loadDetail() {
        const seq = (detail.seq += 1);
        const bvid = detail.bvid;
        detail.data = null;
        detail.error = null;
        // 详情页优先于列表卡片请求；数据来自接口而不是页面上的「1.2万」等近似值
        getStats(bvid, { priority: true })
            .then((data) => {
                if (seq !== detail.seq) return;
                detail.data = data;
                renderDetail();
            })
            .catch((error) => {
                if (seq !== detail.seq) return;
                detail.error = error;
                renderDetail();
            });
    }

    function renderDetail(force) {
        const anchor =
            document.querySelector('.video-info-title-inner') ||
            document.querySelector('.video-info-title') ||
            document.querySelector('#viewbox_report .video-title')?.parentElement;
        if (!anchor) return;

        if (!detail.bar) detail.bar = buildBar('detail');
        const moved = detail.bar.parentNode !== anchor;
        if (moved) anchor.append(detail.bar);

        const key = `${detail.bvid}:${detail.data ? 'ok' : detail.error ? 'error' : 'loading'}`;
        if (!force && !moved && key === detail.renderedKey) return;
        detail.renderedKey = key;

        if (detail.data) {
            renderResult(detail.bar, detail.data, evaluate(detail.data));
        } else if (detail.error) {
            renderError(detail.bar, detail.error, () => {
                detail.renderedKey = '';
                loadDetail();
                renderDetail();
            });
        } else {
            renderLoading(detail.bar);
        }
    }

    function scanDetail() {
        if (!scene.detail || !settings.scenes.detail) {
            if (detail.bvid) resetDetail();
            return;
        }
        const bvid = currentDetailBvid();
        if (!bvid) {
            if (detail.bvid) resetDetail();
            return;
        }
        if (bvid !== detail.bvid) {
            resetDetail();
            detail.bvid = bvid;
            loadDetail();
        }
        renderDetail();
    }

    // ==================== 调度 ====================

    let scanTimer = 0;
    let lastHref = location.href;
    // 页面水合完成前不得改动页面 DOM（见 whenHydrated）
    let domReady = false;

    function scanAll() {
        if (!domReady) return;
        if (location.href !== lastHref) {
            lastHref = location.href;
            scene = pageScene();
            hideTip();
        }
        scanDetail();
        scanCards();
    }

    function scheduleScan() {
        if (scanTimer) return;
        scanTimer = setTimeout(() => {
            scanTimer = 0;
            scanAll();
        }, SCAN_THROTTLE_MS);
    }

    function rerenderAll() {
        [...tracked].forEach(untrack);
        resetDetail();
        hideTip();
        scanAll();
    }

    function applySettings(next) {
        settings = normalizeSettings(next);
        gmSet(STORE.settings, settings);
        rerenderAll();
    }

    function clearLocalData() {
        memCache.clear();
        baseline.clear();
        gmDelete(STORE.cache);
        gmDelete(STORE.baseline);
        rerenderAll();
    }

    // ==================== 设置面板 ====================

    const SETTINGS_CSS = `
        :host { all: initial; }
        .mask { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(0, 0, 0, 0.45);
            font: 14px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
        form { width: min(480px, calc(100vw - 32px)); max-height: calc(100vh - 48px); overflow: auto; box-sizing: border-box;
            padding: 22px 24px; border-radius: 14px; color: #18191c; background: #fff; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3); }
        h2 { margin: 0 0 4px; font-size: 18px; }
        h3 { margin: 18px 0 8px; font-size: 13px; color: #61666d; }
        p { margin: 0; color: #9499a0; font-size: 12px; }
        label.field { display: grid; grid-template-columns: 1fr 150px; align-items: center; gap: 12px; margin: 8px 0; }
        label.field small { display: block; color: #9499a0; font-size: 12px; }
        label.check { display: flex; align-items: center; gap: 8px; margin: 6px 0; cursor: pointer; }
        input[type="number"], select { box-sizing: border-box; width: 100%; padding: 6px 8px; border: 1px solid #e3e5e7;
            border-radius: 6px; font: inherit; color: inherit; background: #fff; }
        input[type="checkbox"] { accent-color: #fb7299; }
        .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 18px; }
        button { padding: 7px 14px; border: 1px solid #e3e5e7; border-radius: 6px; font: inherit; color: #18191c;
            background: #f6f7f8; cursor: pointer; }
        button.primary { border-color: #fb7299; color: #fff; background: #fb7299; }
        button.left { margin-right: auto; }
        .status { min-height: 18px; margin-top: 10px; color: #00aeec; font-size: 12px; }
    `;

    function openSettings() {
        if (document.getElementById('bvq-settings-host')) return;
        const host = document.createElement('div');
        host.id = 'bvq-settings-host';
        host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;';
        const root = host.attachShadow({ mode: 'closed' });

        const sceneChecks = Object.entries(SCENE_LABELS)
            .map(([key, label]) => `<label class="check"><input type="checkbox" name="scene-${key}"><span>${label}</span></label>`)
            .join('');

        root.innerHTML = `
            <style>${SETTINGS_CSS}</style>
            <div class="mask">
                <form>
                    <h2>视频质量标注 · 设置</h2>
                    <p data-role="baseline"></p>

                    <h3>评级</h3>
                    <label class="field"><span>评级方式<small>分区自适应：与本地积累的同分区视频比较；样本不足时自动用固定标准</small></span>
                        <select name="gradeMode"><option value="adaptive">分区自适应</option><option value="fixed">固定标准</option></select></label>
                    <label class="field"><span>最低播放量<small>低于此值显示「样本少」，不评级</small></span>
                        <input type="number" name="minViews" min="0" step="100"></label>
                    <label class="field"><span>「新视频」时长（小时）<small>新视频标「新」，不参与淡化 / 隐藏</small></span>
                        <input type="number" name="newHours" min="0" max="720"></label>
                    <label class="field"><span>C 级视频<small>只对样本充足、非新视频生效</small></span>
                        <select name="lowAction"><option value="none">正常显示</option><option value="dim">淡化</option><option value="hide">隐藏</option></select></label>

                    <h3>显示位置</h3>
                    ${sceneChecks}

                    <h3>请求</h3>
                    <label class="field"><span>数据缓存（小时）</span><input type="number" name="cacheHours" min="1" max="48"></label>
                    <label class="field"><span>最大并发数</span><input type="number" name="concurrency" min="1" max="6"></label>
                    <label class="field"><span>请求间隔（毫秒）</span><input type="number" name="delay" min="0" max="5000" step="50"></label>

                    <div class="actions">
                        <button type="button" class="left" data-act="clear">清除缓存与本地基准</button>
                        <button type="button" data-act="reset">恢复默认</button>
                        <button type="button" data-act="cancel">取消</button>
                        <button type="submit" class="primary">保存</button>
                    </div>
                    <div class="status" data-role="status"></div>
                </form>
            </div>
        `;

        const form = root.querySelector('form');
        const status = root.querySelector('[data-role="status"]');
        const baselineText = root.querySelector('[data-role="baseline"]');

        const describeBaseline = () => {
            let samples = 0;
            let ready = 0;
            baseline.forEach((list) => {
                samples += list.length;
                if (list.length >= BASELINE_MIN_SAMPLES) ready += 1;
            });
            baselineText.textContent = `本地基准：${baseline.size} 个分区、${samples} 个样本，其中 ${ready} 个分区样本已满 ${BASELINE_MIN_SAMPLES} 个可用于自适应评级。`;
        };

        const field = (name) => form.elements.namedItem(name);
        const VALUE_FIELDS = ['gradeMode', 'minViews', 'newHours', 'lowAction', 'cacheHours', 'concurrency', 'delay'];

        const fill = (value) => {
            VALUE_FIELDS.forEach((name) => {
                field(name).value = String(value[name]);
            });
            Object.keys(SCENE_LABELS).forEach((key) => {
                field(`scene-${key}`).checked = value.scenes[key];
            });
        };

        const read = () => {
            const raw = { scenes: {} };
            VALUE_FIELDS.forEach((name) => {
                raw[name] = field(name).value;
            });
            Object.keys(SCENE_LABELS).forEach((key) => {
                raw.scenes[key] = field(`scene-${key}`).checked;
            });
            return normalizeSettings(raw);
        };

        const close = () => {
            document.removeEventListener('keydown', onKey, true);
            host.remove();
        };
        const onKey = (event) => {
            if (event.key === 'Escape') close();
        };

        form.addEventListener('submit', (event) => {
            event.preventDefault();
            applySettings(read());
            close();
        });
        root.querySelector('.mask').addEventListener('click', (event) => {
            if (event.target === event.currentTarget) close();
        });
        root.querySelector('[data-act="cancel"]').addEventListener('click', close);
        root.querySelector('[data-act="reset"]').addEventListener('click', () => {
            fill(normalizeSettings({}));
            status.textContent = '已恢复默认值，点击「保存」后生效。';
        });
        root.querySelector('[data-act="clear"]').addEventListener('click', () => {
            clearLocalData();
            describeBaseline();
            status.textContent = '已清除数据缓存与本地分区基准。';
        });
        document.addEventListener('keydown', onKey, true);

        fill(settings);
        describeBaseline();
        document.body.append(host);
    }

    // ==================== 样式 ====================

    const STYLE = `
        .bvq-bar { display: flex; align-items: center; gap: 8px; margin-top: 4px; overflow: hidden; white-space: nowrap;
            color: var(--text3, #9499a0); font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums; cursor: default; }
        .bvq-bar--compact { gap: 6px; margin-top: 2px; font-size: 11px; line-height: 16px; }
        .bvq-bar--detail { display: inline-flex; margin: 0 0 0 10px; vertical-align: middle; font-size: 13px; font-weight: 400; }
        .bvq-grade { display: inline-block; min-width: 18px; padding: 0 5px; border-radius: 4px; color: #fff;
            background: #c9ccd0; font-weight: 800; text-align: center; box-sizing: border-box; }
        .bvq-grade--S { background: linear-gradient(135deg, #ff6b9d, #fb3a5e); }
        .bvq-grade--A { background: #fb7299; }
        .bvq-grade--B { background: #8c9bb5; }
        .bvq-grade--C { color: #61666d; background: #e3e5e7; }
        .bvq-grade--na { color: var(--text3, #9499a0); background: transparent; border: 1px dashed #c9ccd0; font-weight: 600; }
        .bvq-grade--loading { color: #c9ccd0; background: transparent; }
        .bvq-new { color: #00aeec; font-weight: 700; }
        .bvq-stat.bvq-hi { color: #fb7299; font-weight: 600; }
        .bvq-retry { color: #fb7299; text-decoration: underline dotted; cursor: pointer; }
        .bvq-low-dim { opacity: 0.35; filter: grayscale(0.6); transition: opacity 0.2s ease, filter 0.2s ease; }
        .bvq-low-dim:hover { opacity: 1; filter: none; }
        .bvq-low-hide { display: none !important; }
        .bvq-tip { position: fixed; z-index: 2147483646; width: 270px; padding: 12px 14px; border-radius: 10px;
            color: var(--text1, #18191c); background: var(--bg1, #fff); box-shadow: 0 6px 24px rgba(0, 0, 0, 0.16);
            font-size: 12px; line-height: 1.6; pointer-events: none; }
        .bvq-tip[hidden] { display: none; }
        .bvq-tip-head { display: flex; align-items: center; gap: 8px; padding-bottom: 6px; margin-bottom: 6px;
            border-bottom: 1px solid var(--line_regular, #e3e5e7); font-weight: 700; }
        .bvq-tip-headline { white-space: normal; }
        .bvq-tip-row { display: flex; justify-content: space-between; gap: 12px; }
        .bvq-tip-label { color: var(--text3, #9499a0); }
        .bvq-tip-value { font-weight: 600; text-align: right; }
        .bvq-tip-notes { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--line_regular, #e3e5e7);
            color: var(--text3, #9499a0); white-space: normal; }
    `;

    function injectStyle() {
        if (typeof GM_addStyle === 'function') {
            GM_addStyle(STYLE);
            return;
        }
        const style = document.createElement('style');
        style.textContent = STYLE;
        document.head.append(style);
    }

    // ==================== 启动 ====================

    /**
     * 等待 B 站服务端渲染的页面完成水合后再回调。
     *
     * 视频页等页面是 Vue 2 SSR：#app 带 data-server-rendered="true"，水合完成后该属性会被移除。
     * 如果在水合完成前往 #app 内插入任何节点，Vue 会判定 DOM 不一致、放弃水合并整页重新渲染，
     * 导致位于 #app 内的顶栏容器 #biliMainHeader 被替换，B 站顶栏组件随后挂载崩溃，顶栏消失。
     * 注意 window load 事件早于水合，等 load 不够。
     */
    function whenHydrated(callback) {
        const pending = () => document.querySelector('[data-server-rendered="true"]');
        if (!pending()) {
            callback();
            return;
        }
        let done = false;
        let observer = null;
        let poll = 0;
        let timer = 0;
        const finish = () => {
            if (done) return;
            done = true;
            if (observer) observer.disconnect();
            clearInterval(poll);
            clearTimeout(timer);
            callback();
        };
        const check = () => {
            if (!pending()) finish();
        };
        observer = new MutationObserver(check);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-server-rendered'], subtree: true });
        poll = setInterval(check, 500);
        // 兜底：页面脚本加载失败、永远不水合时，也不至于一直不工作
        timer = setTimeout(finish, HYDRATION_TIMEOUT_MS);
    }

    function boot() {
        loadCache();
        loadBaseline();
        // 样式、悬浮提示、菜单都不会改动 #app 内部，可以立即执行
        injectStyle();
        setupTooltip();

        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand('⚙ 视频质量标注设置', openSettings);
            GM_registerMenuCommand('🗑 清除缓存与本地基准', clearLocalData);
        }

        window.addEventListener('pagehide', flushSaves);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flushSaves();
        });

        whenHydrated(start);
    }

    function start() {
        domReady = true;

        // 只关心新增节点和链接变化（Vue 复用卡片时会原地改写 href）；
        // 忽略播放器内部（弹幕）和脚本自己的节点，避免无意义的扫描
        new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'childList' && !mutation.addedNodes.length) continue;
                const target = mutation.target;
                if (target.nodeType === 1 && target.closest('.bpx-player-container, #bilibili-player, .bvq-bar, .bvq-tip')) continue;
                scheduleScan();
                return;
            }
        }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });

        setInterval(scanAll, POLL_MS);
        scanAll();
    }

    boot();

    // 仅供离线测试使用；正常运行时该钩子不存在
    if (typeof globalThis.__BVQ_TEST_HOOK__ === 'function') {
        globalThis.__BVQ_TEST_HOOK__({
            computeScore,
            evaluate,
            zonePercentile,
            recordBaseline,
            normalizeSettings,
            applySettings,
            scanAll,
            flushSaves,
            queue,
            baseline,
            getSettings: () => settings,
        });
    }
})();
