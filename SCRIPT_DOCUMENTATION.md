# Bilibili 视频质量标注脚本 - 完整阅读文档

> 本文档面向 JavaScript 初学者，详细解析脚本的每一个部分，帮助你理解油猴脚本的工作原理。

---

## 目录

1. [脚本概述](#1-脚本概述)
2. [什么是油猴脚本](#2-什么是油猴脚本)
3. [脚本元数据块详解](#3-脚本元数据块详解)
4. [代码整体结构](#4-代码整体结构)
5. [配置区详解](#5-配置区详解)
6. [CSS 样式详解](#6-css-样式详解)
7. [工具函数详解](#7-工具函数详解)
8. [数据获取详解](#8-数据获取详解)
9. [质量评估算法详解](#9-质量评估算法详解)
10. [UI 渲染详解](#10-ui-渲染详解)
11. [主逻辑与页面监听](#11-主逻辑与页面监听)
12. [核心概念总结](#12-核心概念总结)
13. [常见问题](#13-常见问题)

---

## 1. 脚本概述

### 1.1 这个脚本做什么？

这个脚本是一个**浏览器用户脚本（UserScript）**，运行在 Bilibili（B站）视频页面上。它的功能是：

1. **自动获取**当前视频的播放量、点赞数、投币数
2. **根据算法计算**视频是否为"优质视频"
3. **在页面上显示**一个漂亮的标签（"🔥 优质视频"或"📊 普通视频"）
4. **鼠标悬停时**显示详细的数据分析

### 1.2 判断标准

脚本使用以下规则判断视频质量：

| 指标 | 计算方式 | 好视频标准 |
|------|----------|------------|
| 点赞率 | 点赞数 ÷ 播放量 | ≥ 5% |
| 投币率 | 投币数 ÷ 播放量 | ≥ 点赞率的一半 |

**只要满足其中一条，就被判定为"优质视频"。**

---

## 2. 什么是油猴脚本

### 2.1 油猴（Tampermonkey）

**油猴**是一个浏览器扩展，允许用户运行自定义的 JavaScript 脚本来修改网页的行为和外观。

常见的油猴扩展：
- **Tampermonkey**（最流行，支持 Chrome、Firefox、Edge 等）
- **Greasemonkey**（Firefox 原版）
- **Violentmonkey**（开源替代品）

### 2.2 用户脚本的工作原理

```
用户访问网页 → 浏览器加载页面 → 油猴检测 URL 是否匹配 → 注入并执行脚本 → 脚本修改页面
```

### 2.3 为什么需要油猴脚本？

- 网页本身不提供某些功能（如视频质量评估）
- 用户想要自定义网页的显示方式
- 自动化一些重复操作

---

## 3. 脚本元数据块详解

脚本开头的注释块不是普通注释，而是**油猴专用的元数据声明**：

```javascript
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
```

### 3.1 各字段详解

| 字段 | 含义 | 本脚本的值 | 说明 |
|------|------|------------|------|
| `@name` | 脚本名称 | `Bilibili 视频质量标注` | 显示在油猴管理界面中 |
| `@namespace` | 命名空间 | `https://github.com/bilibili-video-quality` | 用于区分同名脚本，通常是作者的网站或项目地址 |
| `@version` | 版本号 | `1.0.0` | 遵循语义化版本规范（主版本.次版本.修订号） |
| `@description` | 描述 | `根据播放量...` | 脚本功能的简短说明 |
| `@author` | 作者 | `fenghan` | 脚本作者名 |
| `@match` | 匹配的 URL | `https://www.bilibili.com/video/*` | 脚本只在这些页面上运行 |
| `@icon` | 图标 | `https://www.bilibili.com/favicon.ico` | 显示在油猴管理界面中 |
| `@grant` | 授权 API | `GM_addStyle` | 申请使用油猴提供的特殊功能 |
| `@run-at` | 运行时机 | `document-idle` | 指定脚本何时执行 |

### 3.2 @match 详解

```javascript
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
```

`@match` 使用**匹配模式**来指定脚本在哪些页面运行：

- `https://` - 协议部分，表示只匹配 HTTPS 页面
- `www.bilibili.com` - 域名部分
- `/video/*` - 路径部分，`*` 是通配符，匹配任意字符

**示例匹配：**
- ✅ `https://www.bilibili.com/video/BV1xx411c7mD`
- ✅ `https://www.bilibili.com/video/av170001`
- ✅ `https://www.bilibili.com/list/watchlater`
- ❌ `https://www.bilibili.com/` （首页不匹配）
- ❌ `https://search.bilibili.com/` （搜索页不匹配）

### 3.3 @grant 详解

```javascript
// @grant        GM_addStyle
```

`@grant` 用于申请**油猴专用 API**。这些 API 是普通网页脚本无法使用的。

| API | 功能 |
|-----|------|
| `GM_addStyle` | 向页面注入 CSS 样式 |
| `GM_getValue` / `GM_setValue` | 持久化存储数据 |
| `GM_xmlhttpRequest` | 跨域 HTTP 请求 |
| `GM_notification` | 显示桌面通知 |
| `GM_setClipboard` | 复制内容到剪贴板 |

本脚本只用了 `GM_addStyle`，用于注入美化标签的 CSS 样式。

### 3.4 @run-at 详解

```javascript
// @run-at       document-idle
```

指定脚本的执行时机：

| 值 | 执行时机 | 适用场景 |
|----|----------|----------|
| `document-start` | 页面开始加载时（DOM 还没准备好） | 需要最早介入的情况 |
| `document-end` | DOM 加载完成时（相当于 DOMContentLoaded） | 大多数情况 |
| `document-idle` | 页面完全空闲时（所有资源加载完毕） | 不急于执行的脚本 |

本脚本使用 `document-idle`，因为需要等待 B 站的 JavaScript 把视频数据渲染到页面上。

---

## 4. 代码整体结构

```javascript
(function () {
    'use strict';

    // 1. 配置区 - 定义阈值和参数
    const CONFIG = { ... };

    // 2. 样式区 - CSS 样式定义
    GM_addStyle(`...`);

    // 3. 工具函数 - 数字解析、日志打印
    function parseNumber(text) { ... }
    function log(...args) { ... }

    // 4. 数据获取 - 从页面抓取视频数据
    function extractVideoStats() { ... }

    // 5. 质量评估 - 计算视频是否优质
    function evaluateQuality(stats) { ... }

    // 6. UI 渲染 - 创建并显示标签
    function formatPercent(ratio) { ... }
    function formatCount(num) { ... }
    function createBadge(stats, quality) { ... }

    // 7. 主逻辑 - 轮询和页面监听
    function run() { ... }

    // 8. 页面监听 - 处理 B 站的 SPA 路由
    let lastUrl = location.href;
    const observer = new MutationObserver(() => { ... });
    observer.observe(document.body, { childList: true, subtree: true });

    // 9. 启动
    run();
    log('Bilibili 视频质量标注脚本已启动 ✓');
})();
```

### 4.1 IIFE 立即执行函数

```javascript
(function () {
    'use strict';
    // 所有代码...
})();
```

**什么是 IIFE？**

IIFE = Immediately Invoked Function Expression（立即调用函数表达式）

**为什么要用 IIFE？**

1. **隔离作用域**：函数内的变量不会污染全局命名空间
2. **避免冲突**：脚本的变量不会和网页原有的变量冲突
3. **立即执行**：定义后马上运行

**示例对比：**

```javascript
// ❌ 不好的写法 - 污染全局
var CONFIG = { ... };  // 可能覆盖网页已有的 CONFIG 变量

// ✅ 好的写法 - IIFE 隔离
(function () {
    var CONFIG = { ... };  // 只在函数内部有效
})();
```

### 4.2 'use strict' 严格模式

```javascript
'use strict';
```

启用 JavaScript 的**严格模式**，提供更严格的错误检查：

| 普通模式 | 严格模式 |
|----------|----------|
| 允许使用未声明的变量 | 报错 |
| 允许删除变量 | 报错 |
| 允许重复参数名 | 报错 |
| `this` 在函数中是全局对象 | `this` 是 `undefined` |

**好处**：帮助发现潜在的 bug，让代码更安全。

---

## 5. 配置区详解

```javascript
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
```

### 5.1 为什么要用配置对象？

将可调整的参数集中在一个对象中，有以下好处：

1. **易于修改**：想调整阈值时，只需改这里
2. **易于理解**：所有"魔法数字"都有命名和注释
3. **易于维护**：不用在代码中到处找硬编码的数值

### 5.2 各配置项详解

#### LIKE_RATIO_THRESHOLD（点赞率阈值）

```javascript
LIKE_RATIO_THRESHOLD: 0.05,  // 5%
```

- **含义**：点赞数 ÷ 播放量 ≥ 5% 就算好视频
- **为什么是 5%**：根据 B 站的普遍数据，5% 的点赞率已经算是比较高的了
- **类型**：小数（0.05 = 5%）

**计算示例**：
- 播放量 10000，点赞 600 → 点赞率 6% ≥ 5% → 好视频 ✅
- 播放量 10000，点赞 300 → 点赞率 3% < 5% → 不满足 ❌

#### COIN_RATIO_FACTOR（投币率系数）

```javascript
COIN_RATIO_FACTOR: 0.5,  // 投币率阈值 = 点赞率 × 0.5
```

- **含义**：投币率需要达到点赞率的一半
- **逻辑**：投币比点赞成本高（用户需要花费硬币），所以标准降低一半
- **动态阈值**：投币率的合格线取决于该视频的点赞率

**计算示例**：
- 点赞率 4% → 投币率阈值 = 4% × 0.5 = 2%
- 如果投币率 ≥ 2%，则满足条件

#### POLL_INTERVAL（轮询间隔）

```javascript
POLL_INTERVAL: 500,  // 500 毫秒 = 0.5 秒
```

- **含义**：每隔 500 毫秒检查一次页面数据
- **为什么需要轮询**：B 站是动态加载的，视频数据不是立即可用的
- **单位**：毫秒（1000 毫秒 = 1 秒）

#### MAX_POLL_COUNT（最大轮询次数）

```javascript
MAX_POLL_COUNT: 40,  // 最多轮询 40 次
```

- **含义**：最多尝试 40 次（40 × 500ms = 20 秒）
- **作用**：防止无限循环，如果 20 秒还获取不到数据就放弃
- **计算**：`MAX_POLL_COUNT × POLL_INTERVAL = 40 × 500 = 20000ms = 20秒`

#### DEBUG（调试模式）

```javascript
DEBUG: false,  // 关闭调试日志
```

- **含义**：是否在控制台打印调试信息
- **用法**：开发时设为 `true`，发布时设为 `false`
- **查看**：打开浏览器开发者工具（F12）→ Console 标签页

---

## 6. CSS 样式详解

脚本使用 `GM_addStyle` 向页面注入 CSS 样式：

```javascript
GM_addStyle(`
    /* CSS 代码 */
`);
```

### 6.1 GM_addStyle 函数

这是油猴提供的 API，作用是向页面的 `<head>` 中添加一个 `<style>` 标签。

**等效于：**
```javascript
const style = document.createElement('style');
style.textContent = `/* CSS 代码 */`;
document.head.appendChild(style);
```

但 `GM_addStyle` 更简洁，且在某些情况下更可靠。

### 6.2 徽章容器样式

```css
.bvq-badge-container {
    display: inline-flex;      /* 行内弹性盒子 */
    align-items: center;       /* 垂直居中 */
    margin-left: 12px;         /* 左边距，与标题保持间距 */
    animation: bvq-fade-in 0.4s ease-out;  /* 淡入动画 */
}
```

**CSS 命名规范**：

所有类名都以 `bvq-` 开头（Bilibili Video Quality 的缩写），这是为了：
- 避免与 B 站原有的 CSS 类名冲突
- 便于识别这是脚本添加的样式

### 6.3 徽章基础样式

```css
.bvq-badge {
    display: inline-flex;      /* 行内弹性盒子，让图标和文字并排 */
    align-items: center;       /* 垂直居中对齐 */
    gap: 4px;                  /* 图标和文字之间的间距 */
    padding: 3px 12px;         /* 内边距：上下3px，左右12px */
    border-radius: 20px;       /* 圆角，数值越大越圆 */
    font-size: 13px;           /* 字体大小 */
    font-weight: 600;          /* 字体粗细，600 是半粗体 */
    letter-spacing: 0.5px;     /* 字母间距，微调美观 */
    cursor: pointer;           /* 鼠标悬停时显示手型 */
    position: relative;        /* 相对定位，作为提示框的定位参照 */
    transition: transform 0.2s ease, box-shadow 0.2s ease;  /* 过渡动画 */
    user-select: none;         /* 禁止选中文字 */
}

.bvq-badge:hover {
    transform: translateY(-1px);  /* 悬停时上移 1px，产生浮起效果 */
}
```

### 6.4 好视频徽章样式

```css
.bvq-badge-good {
    background: linear-gradient(135deg, #ff6b9d 0%, #fb3a5e 100%);
    /* 线性渐变背景：
       135deg = 从左上到右下的角度
       #ff6b9d (浅粉红) → #fb3a5e (深粉红)
    */
    color: #fff;               /* 白色文字 */
    box-shadow: 0 2px 8px rgba(251, 58, 94, 0.35);
    /* 阴影效果：
       0 = 水平偏移
       2px = 垂直偏移
       8px = 模糊半径
       rgba(251, 58, 94, 0.35) = 粉红色，35% 不透明度
    */
}

.bvq-badge-good:hover {
    box-shadow: 0 4px 14px rgba(251, 58, 94, 0.5);
    /* 悬停时阴影更大、更明显 */
}
```

### 6.5 普通视频徽章样式

```css
.bvq-badge-normal {
    background: linear-gradient(135deg, #a8b8d8 0%, #8899bb 100%);
    /* 蓝灰色渐变，相比好视频更低调 */
    color: #fff;
    box-shadow: 0 2px 8px rgba(136, 153, 187, 0.3);
}
```

### 6.6 提示框样式

```css
.bvq-tooltip {
    display: none;             /* 默认隐藏 */
    position: absolute;        /* 绝对定位，相对于父元素（徽章） */
    top: calc(100% + 8px);     /* 在徽章下方 8px 处 */
    left: 50%;                 /* 水平居中 */
    transform: translateX(-50%);  /* 配合 left:50% 实现完美居中 */
    background: #fff;          /* 白色背景 */
    border-radius: 12px;       /* 圆角 */
    padding: 14px 18px;        /* 内边距 */
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);  /* 阴影 */
    z-index: 99999;            /* 层级，确保显示在最上层 */
    min-width: 260px;          /* 最小宽度 */
    font-weight: 400;          /* 正常字重 */
    color: #333;               /* 深灰色文字 */
    font-size: 13px;           /* 字体大小 */
    line-height: 1.7;          /* 行高 */
}

.bvq-badge:hover .bvq-tooltip {
    display: block;            /* 鼠标悬停在徽章上时，显示提示框 */
}
```

**居中技巧详解**：

```css
left: 50%;                 /* 左边缘在父元素中点 */
transform: translateX(-50%);  /* 向左移动自身宽度的一半 */
```

这是 CSS 中常用的**水平居中**技巧：
1. `left: 50%` 把元素左边缘放到父元素中点
2. `translateX(-50%)` 把元素向左移动自身宽度的一半
3. 结果：元素的中心正好在父元素的中心

### 6.7 提示框三角箭头

```css
.bvq-tooltip::before {
    content: '';               /* 空内容，但必须有这个属性 */
    position: absolute;        /* 绝对定位 */
    top: -6px;                 /* 在提示框上方 6px */
    left: 50%;                 /* 水平居中 */
    transform: translateX(-50%);
    border-left: 6px solid transparent;    /* 左边透明 */
    border-right: 6px solid transparent;   /* 右边透明 */
    border-bottom: 6px solid #fff;         /* 底边白色 */
}
```

**CSS 三角形原理**：

使用边框（border）可以创建三角形。原理是边框在角落处会形成斜切：

```
透明         透明
  \         /
   \       /
    \_____/
      白色
```

### 6.8 提示框内部样式

```css
.bvq-tooltip-title {
    font-weight: 700;          /* 粗体 */
    font-size: 14px;
    margin-bottom: 8px;
    padding-bottom: 6px;
    border-bottom: 1px solid #eee;  /* 下边框分隔线 */
}

.bvq-tooltip-row {
    display: flex;             /* 弹性盒子 */
    justify-content: space-between;  /* 两端对齐 */
    padding: 2px 0;
}

.bvq-tooltip-label {
    color: #999;               /* 灰色标签 */
}

.bvq-tooltip-value {
    font-weight: 600;          /* 半粗体数值 */
}

.bvq-tooltip-value.bvq-pass {
    color: #fb3a5e;            /* 通过时显示粉红色 */
}

.bvq-tooltip-value.bvq-fail {
    color: #999;               /* 未通过时显示灰色 */
}
```

### 6.9 淡入动画

```css
@keyframes bvq-fade-in {
    from { 
        opacity: 0;                    /* 开始时完全透明 */
        transform: translateY(-4px);   /* 开始时上移 4px */
    }
    to { 
        opacity: 1;                    /* 结束时完全不透明 */
        transform: translateY(0);      /* 结束时回到原位 */
    }
}
```

**@keyframes 详解**：

- `@keyframes` 定义一个动画序列
- `bvq-fade-in` 是动画的名称
- `from` 是动画开始状态（等同于 `0%`）
- `to` 是动画结束状态（等同于 `100%`）

**使用动画**：

```css
animation: bvq-fade-in 0.4s ease-out;
/*
   bvq-fade-in = 使用的动画名称
   0.4s = 动画持续时间
   ease-out = 缓动函数（先快后慢）
*/
```

---

## 7. 工具函数详解

### 7.1 parseNumber - 数字解析函数

```javascript
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
```

**为什么需要这个函数？**

B 站为了显示简洁，会把大数字简化显示：
- `12000` 显示为 `1.2万`
- `350000000` 显示为 `3.5亿`

我们需要把这些文本转换回真实数字进行计算。

**逐行解析**：

```javascript
if (!text) return 0;
```
- 如果 `text` 是 `null`、`undefined`、空字符串，返回 0
- `!text` 是空值检查的简写

```javascript
text = text.trim().replace(/,/g, '');
```
- `trim()` 去除首尾空格，如 `" 1.2万 "` → `"1.2万"`
- `replace(/,/g, '')` 移除所有逗号，如 `"1,234"` → `"1234"`
- `/,/g` 是正则表达式，`g` 表示全局替换（所有逗号都替换）

```javascript
if (text.includes('万')) {
    const num = parseFloat(text.replace('万', ''));
    return isNaN(num) ? 0 : Math.round(num * 10000);
}
```
- `includes('万')` 检查字符串是否包含"万"
- `replace('万', '')` 移除"万"字，如 `"1.2万"` → `"1.2"`
- `parseFloat()` 解析为浮点数，如 `"1.2"` → `1.2`
- `isNaN(num)` 检查是否为 NaN（非数字）
- `Math.round(num * 10000)` 乘以 10000 并四舍五入

```javascript
const num = parseInt(text, 10);
return isNaN(num) ? 0 : num;
```
- `parseInt(text, 10)` 解析为整数，第二个参数 `10` 指定十进制
- 如果解析失败返回 0，否则返回数字

**测试用例**：

| 输入 | 输出 | 说明 |
|------|------|------|
| `"1.2万"` | `12000` | 1.2 × 10000 |
| `"3.5亿"` | `350000000` | 3.5 × 100000000 |
| `"1,234"` | `1234` | 移除逗号 |
| `"156"` | `156` | 普通整数 |
| `""` | `0` | 空字符串 |
| `null` | `0` | 空值 |

### 7.2 log - 日志函数

```javascript
function log(...args) {
    if (CONFIG.DEBUG) {
        console.log('[BVQ]', ...args);
    }
}
```

**参数解析**：

```javascript
function log(...args)
```
- `...args` 是**剩余参数**（Rest Parameters）
- 它可以接收任意数量的参数，并把它们收集到一个数组中

**示例**：
```javascript
log('你好', '世界', 123);
// args = ['你好', '世界', 123]
```

**函数体解析**：

```javascript
if (CONFIG.DEBUG) {
    console.log('[BVQ]', ...args);
}
```
- 只有 `CONFIG.DEBUG` 为 `true` 时才打印
- `[BVQ]` 是前缀，方便在控制台中识别
- `...args` 是**展开语法**（Spread Syntax），把数组展开为多个参数

**调试示例**：

```javascript
// 当 CONFIG.DEBUG = true 时
log('提取到数据', '播放:', 10000);
// 控制台输出: [BVQ] 提取到数据 播放: 10000

// 当 CONFIG.DEBUG = false 时
log('提取到数据', '播放:', 10000);
// 无输出
```

---

## 8. 数据获取详解

### 8.1 extractVideoStats - 从页面提取视频数据

```javascript
function extractVideoStats() {
    let plays = 0;
    let likes = 0;
    let coins = 0;

    // --- 播放量 ---
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
```

### 8.2 document.querySelector 详解

```javascript
document.querySelector(selector)
```

- 在页面中查找**第一个**匹配 CSS 选择器的元素
- 如果找不到，返回 `null`
- 相关方法：`querySelectorAll()` 返回**所有**匹配的元素

**CSS 选择器复习**：

| 选择器 | 含义 | 示例 |
|--------|------|------|
| `.class` | 类选择器 | `.video-like` |
| `#id` | ID 选择器 | `#viewbox_report` |
| `tag` | 标签选择器 | `div`、`span` |
| `.a .b` | 后代选择器 | `.video-info .view-text` |
| `.a > .b` | 直接子元素 | `.item > .text` |
| `.a:first-child` | 伪类选择器 | `.item:first-child` |
| `[attr]` | 属性选择器 | `[data-v-like]` |

### 8.3 多选择器备选策略

```javascript
const viewEl = document.querySelector('.video-info-detail-list .item:first-child .view-text')
    || document.querySelector('.video-info-detail .view-text')
    || document.querySelector('.video-data-list .view .video-data-text');
```

**为什么要用多个选择器？**

B 站有不同版本的页面结构，或者会进行 A/B 测试。使用 `||`（逻辑或）运算符可以实现**备选方案**：

1. 先尝试第一个选择器
2. 如果返回 `null`，尝试第二个
3. 如果还是 `null`，尝试第三个

**|| 运算符的工作原理**：

```javascript
null || 'B' || 'C'  // 返回 'B'
'A' || 'B' || 'C'   // 返回 'A'
null || null || 'C' // 返回 'C'
null || null || null // 返回 null
```

`||` 返回第一个"真值"（truthy value），如果都是假值则返回最后一个。

### 8.4 textContent 属性

```javascript
plays = parseNumber(viewEl.textContent);
```

- `textContent` 获取元素内的**纯文本内容**
- 不包含 HTML 标签
- 类似的还有 `innerHTML`（包含 HTML）和 `innerText`（考虑样式）

**示例**：

```html
<span class="view-text">1.2万</span>
```

```javascript
viewEl.textContent  // "1.2万"
viewEl.innerHTML    // "1.2万"
```

### 8.5 返回对象

```javascript
return { plays, likes, coins };
```

这是 ES6 的**对象属性简写**：

```javascript
// 等同于
return { plays: plays, likes: likes, coins: coins };
```

当属性名和变量名相同时，可以简写。

---

## 9. 质量评估算法详解

### 9.1 evaluateQuality 函数

```javascript
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
```

### 9.2 解构赋值

```javascript
const { plays, likes, coins } = stats;
```

这是 ES6 的**对象解构**（Destructuring）：

```javascript
// 等同于
const plays = stats.plays;
const likes = stats.likes;
const coins = stats.coins;
```

### 9.3 边界情况处理

```javascript
if (plays === 0) {
    return {
        isGood: false,
        likeRatio: 0,
        coinRatio: 0,
        // ...
        reason: '播放量为0，无法评估',
    };
}
```

**为什么要检查播放量为 0？**

- 除以 0 在数学上是未定义的
- JavaScript 中 `x / 0` 会得到 `Infinity`（无穷大）
- 这会导致后续计算出错

### 9.4 核心算法

```javascript
const likeRatio = likes / plays;           // 点赞率 = 点赞数 / 播放量
const coinRatio = coins / plays;           // 投币率 = 投币数 / 播放量
const coinThreshold = likeRatio * CONFIG.COIN_RATIO_FACTOR;  // 投币率阈值 = 点赞率 × 0.5

const likePass = likeRatio >= CONFIG.LIKE_RATIO_THRESHOLD;   // 点赞率 ≥ 5%
const coinPass = coinRatio >= coinThreshold && coinThreshold > 0;  // 投币率 ≥ 阈值，且阈值 > 0

const isGood = likePass || coinPass;       // 满足任一条件即为好视频
```

**算法流程图**：

```
开始
  │
  ├─ 播放量 = 0? ─是→ 返回"无法评估"
  │    │
  │    否
  │    │
  │    ▼
  │  计算点赞率 = 点赞数 / 播放量
  │  计算投币率 = 投币数 / 播放量
  │  计算投币阈值 = 点赞率 × 0.5
  │    │
  │    ▼
  │  检查条件1：点赞率 ≥ 5%?
  │  检查条件2：投币率 ≥ 投币阈值?
  │    │
  │    ▼
  │  任一条件满足? ─是→ 好视频 🔥
  │    │
  │    否
  │    │
  │    ▼
  │  普通视频 📊
  │
结束
```

### 9.5 示例计算

**示例 1**：点赞率高的视频

| 指标 | 值 |
|------|-----|
| 播放量 | 100,000 |
| 点赞数 | 8,000 |
| 投币数 | 2,000 |

计算：
- 点赞率 = 8000 / 100000 = 8% ≥ 5% ✅
- 投币率 = 2000 / 100000 = 2%
- 投币阈值 = 8% × 0.5 = 4%
- 投币率 2% < 4% ❌

结论：点赞率达标，是**好视频** 🔥

**示例 2**：投币率高的视频

| 指标 | 值 |
|------|-----|
| 播放量 | 100,000 |
| 点赞数 | 4,000 |
| 投币数 | 2,500 |

计算：
- 点赞率 = 4000 / 100000 = 4% < 5% ❌
- 投币率 = 2500 / 100000 = 2.5%
- 投币阈值 = 4% × 0.5 = 2%
- 投币率 2.5% ≥ 2% ✅

结论：投币率达标，是**好视频** 🔥

**示例 3**：普通视频

| 指标 | 值 |
|------|-----|
| 播放量 | 100,000 |
| 点赞数 | 2,000 |
| 投币数 | 500 |

计算：
- 点赞率 = 2000 / 100000 = 2% < 5% ❌
- 投币率 = 500 / 100000 = 0.5%
- 投币阈值 = 2% × 0.5 = 1%
- 投币率 0.5% < 1% ❌

结论：两项都不达标，是**普通视频** 📊

### 9.6 构建原因字符串

```javascript
const reasons = [];
if (likePass) reasons.push(`点赞率 ${(likeRatio * 100).toFixed(2)}% ≥ ${CONFIG.LIKE_RATIO_THRESHOLD * 100}%`);
if (coinPass) reasons.push(`投币率 ${(coinRatio * 100).toFixed(2)}% ≥ 点赞率一半 ${(coinThreshold * 100).toFixed(2)}%`);
if (!isGood) reasons.push('未达到好视频标准');

// ...
reason: reasons.join('；'),
```

**数组方法解析**：

- `push()` - 向数组末尾添加元素
- `join('；')` - 把数组元素用指定分隔符连接成字符串

```javascript
['A', 'B', 'C'].join('；')  // "A；B；C"
```

**toFixed() 方法**：

```javascript
(0.08).toFixed(2)  // "8.00"
(0.123).toFixed(2) // "12.30"
```
- 把数字格式化为指定小数位数的字符串
- 参数是小数位数

---

## 10. UI 渲染详解

### 10.1 格式化函数

```javascript
function formatPercent(ratio) {
    return (ratio * 100).toFixed(2) + '%';
}
```
- 把小数转换为百分比字符串
- 例：`0.05` → `"5.00%"`

```javascript
function formatCount(num) {
    if (num >= 100000000) return (num / 100000000).toFixed(1) + '亿';
    if (num >= 10000) return (num / 10000).toFixed(1) + '万';
    return num.toLocaleString();
}
```
- 把大数字格式化为易读的形式
- `100000000` → `"1.0亿"`
- `50000` → `"5.0万"`
- `1234` → `"1,234"`（使用 `toLocaleString` 添加千分位逗号）

### 10.2 createBadge - 创建徽章

```javascript
function createBadge(stats, quality) {
    // 1. 移除旧标注
    document.querySelectorAll('.bvq-badge-container').forEach(el => el.remove());

    // 2. 创建容器元素
    const container = document.createElement('span');
    container.className = 'bvq-badge-container';

    // 3. 准备数据
    const isGood = quality.isGood;
    const icon = isGood ? '🔥' : '📊';
    const label = isGood ? '优质视频' : '普通视频';
    const badgeClass = isGood ? 'bvq-badge-good' : 'bvq-badge-normal';

    // 4. 设置 HTML 内容
    container.innerHTML = `...`;

    // 5. 插入到页面
    const titleEl = document.querySelector('.video-info-title .video-title')
        || document.querySelector('#viewbox_report .video-title')
        || document.querySelector('.video-info-title');

    if (titleEl) {
        titleEl.parentNode.insertBefore(container, titleEl.nextSibling);
        log('标注已插入到标题旁');
    } else {
        const infoEl = document.querySelector('.video-info-detail')
            || document.querySelector('#viewbox_report');
        if (infoEl) {
            infoEl.appendChild(container);
            log('标注已插入到信息区');
        }
    }
}
```

### 10.3 移除旧标注

```javascript
document.querySelectorAll('.bvq-badge-container').forEach(el => el.remove());
```

- `querySelectorAll` 返回**所有**匹配元素的 NodeList
- `forEach` 遍历每个元素
- `el.remove()` 从 DOM 中移除元素

**为什么要移除？**

当用户在同一页面切换视频时（B 站的 SPA 路由），需要先清除旧的标注再创建新的。

### 10.4 创建 DOM 元素

```javascript
const container = document.createElement('span');
container.className = 'bvq-badge-container';
```

- `document.createElement('span')` 创建一个新的 `<span>` 元素
- `className` 设置元素的 CSS 类

### 10.5 三元运算符

```javascript
const icon = isGood ? '🔥' : '📊';
```

三元运算符语法：`条件 ? 真时的值 : 假时的值`

```javascript
// 等同于
let icon;
if (isGood) {
    icon = '🔥';
} else {
    icon = '📊';
}
```

### 10.6 模板字符串

```javascript
container.innerHTML = `
    <span class="bvq-badge ${badgeClass}">
        <span>${icon}</span>
        <span>${label}</span>
        <div class="bvq-tooltip">
            <div class="bvq-tooltip-title">${icon} 视频质量分析</div>
            ...
        </div>
    </span>
`;
```

**模板字符串特点**：

1. 使用反引号 `` ` `` 包裹
2. 支持多行
3. 使用 `${变量}` 插入变量值
4. 比字符串拼接更清晰

**对比**：

```javascript
// 旧方式（字符串拼接）
'<span class="bvq-badge ' + badgeClass + '">' +
    '<span>' + icon + '</span>' +
'</span>'

// 新方式（模板字符串）
`<span class="bvq-badge ${badgeClass}">
    <span>${icon}</span>
</span>`
```

### 10.7 innerHTML 属性

```javascript
container.innerHTML = `<span>...</span>`;
```

- `innerHTML` 设置元素内的 HTML 内容
- 浏览器会自动解析 HTML 字符串并创建对应的 DOM 节点
- ⚠️ 安全警告：不要把用户输入直接放入 innerHTML，可能导致 XSS 攻击

### 10.8 插入 DOM 元素

```javascript
titleEl.parentNode.insertBefore(container, titleEl.nextSibling);
```

**DOM 树关系**：

```
parentNode (父节点)
├── titleEl (标题元素)
├── [container 将被插入这里]
└── titleEl.nextSibling (下一个兄弟元素)
```

**方法解析**：

- `titleEl.parentNode` - 获取父元素
- `titleEl.nextSibling` - 获取下一个兄弟元素
- `insertBefore(新元素, 参照元素)` - 在参照元素之前插入新元素

**效果**：把 container 插入到标题元素的**后面**（下一个兄弟元素的前面）

### 10.9 appendChild 方法

```javascript
infoEl.appendChild(container);
```

- 把元素添加为最后一个子元素
- 这是备用方案，当找不到标题元素时使用

---

## 11. 主逻辑与页面监听

### 11.1 run 函数 - 轮询逻辑

```javascript
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
```

### 11.2 setInterval 定时器

```javascript
const timer = setInterval(() => {
    // 这里的代码会反复执行
}, 500);  // 每 500 毫秒执行一次
```

- `setInterval(回调函数, 间隔时间)` 创建定时器
- 返回一个**定时器 ID**，用于后续清除
- 回调函数会按指定间隔**反复执行**

### 11.3 clearInterval 清除定时器

```javascript
clearInterval(timer);
```

- 停止定时器，不再执行回调
- 必须传入 `setInterval` 返回的 ID

### 11.4 轮询流程图

```
run() 开始
    │
    ▼
创建定时器 (500ms)
    │
    ├───────────────────┐
    ▼                   │
[定时器触发]            │
    │                   │
pollCount++             │
    │                   │
提取视频数据            │
    │                   │
    ├─ plays > 0? ───否─┤
    │      │            │
    │     是            │
    │      │            │
    │ 清除定时器         │
    │ 评估质量           │
    │ 创建徽章           │
    │ [结束]             │
    │                   │
    ├─ pollCount ≥ 40? ─┤
    │      │            │
    │     是            │
    │      │            │
    │ 清除定时器         │
    │ 打印超时日志       │
    │ [结束]             │
    │                   │
    │     否            │
    │      │            │
    └──────┴─ 等待 500ms 后重复
```

### 11.5 箭头函数

```javascript
const timer = setInterval(() => {
    // 函数体
}, 500);
```

箭头函数是 ES6 的简写语法：

```javascript
// 传统函数
setInterval(function() {
    // 函数体
}, 500);

// 箭头函数
setInterval(() => {
    // 函数体
}, 500);
```

**箭头函数特点**：
1. 更简洁的语法
2. 没有自己的 `this`（继承外层的 `this`）
3. 不能用作构造函数

### 11.6 MutationObserver - 监听 DOM 变化

```javascript
let lastUrl = location.href;
const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
        lastUrl = location.href;
        log('页面切换，重新评估:', lastUrl);
        setTimeout(run, 1000);
    }
});

observer.observe(document.body, { childList: true, subtree: true });
```

**为什么需要这个？**

B 站是**单页应用（SPA）**，切换视频时不会真正刷新页面，只是改变 URL 和部分内容。普通的页面加载事件无法检测到这种变化。

### 11.7 MutationObserver 详解

```javascript
const observer = new MutationObserver(callback);
```

- 创建一个**变化观察器**
- 当被观察的 DOM 发生变化时，调用回调函数

```javascript
observer.observe(document.body, { 
    childList: true,   // 观察子元素的添加/移除
    subtree: true      // 观察所有后代元素
});
```

**配置选项**：

| 选项 | 含义 |
|------|------|
| `childList` | 观察子节点的增删 |
| `subtree` | 观察所有后代节点（不只是直接子节点） |
| `attributes` | 观察属性变化 |
| `characterData` | 观察文本内容变化 |

### 11.8 检测 URL 变化

```javascript
let lastUrl = location.href;

// 在 MutationObserver 回调中
if (location.href !== lastUrl) {
    lastUrl = location.href;
    // URL 发生了变化
}
```

**原理**：

1. 保存当前 URL
2. 每次 DOM 变化时检查 URL 是否改变
3. 如果改变了，更新保存的 URL 并执行操作

**为什么不直接监听 URL？**

浏览器没有提供直接的 URL 变化事件（`popstate` 事件只在浏览器前进/后退时触发）。监听 DOM 变化是一种间接但可靠的方法。

### 11.9 setTimeout 延迟执行

```javascript
setTimeout(run, 1000);
```

- 延迟 1000 毫秒后执行 `run` 函数
- 与 `setInterval` 不同，`setTimeout` 只执行一次

**为什么要延迟？**

页面 URL 变化后，新的视频数据不会立即加载完成。延迟 1 秒给 B 站足够的时间渲染新内容。

---

## 12. 核心概念总结

### 12.1 JavaScript 基础概念

| 概念 | 说明 | 本脚本中的使用 |
|------|------|----------------|
| IIFE | 立即执行函数，隔离作用域 | 整个脚本包裹在 IIFE 中 |
| 严格模式 | 更严格的错误检查 | `'use strict'` |
| 常量 | 不可重新赋值的变量 | `const CONFIG = {...}` |
| 对象 | 键值对的集合 | `{ plays: 0, likes: 0 }` |
| 数组 | 有序的值列表 | `const reasons = []` |
| 箭头函数 | 简洁的函数语法 | `() => {...}` |
| 模板字符串 | 支持插值的字符串 | `` `${变量}` `` |
| 解构赋值 | 从对象/数组提取值 | `const { plays } = stats` |
| 展开语法 | 展开数组/对象 | `...args` |
| 三元运算符 | 条件表达式 | `a ? b : c` |

### 12.2 DOM 操作概念

| 概念 | 说明 | 示例 |
|------|------|------|
| querySelector | 选择单个元素 | `document.querySelector('.class')` |
| querySelectorAll | 选择多个元素 | `document.querySelectorAll('.class')` |
| createElement | 创建元素 | `document.createElement('span')` |
| appendChild | 添加子元素 | `parent.appendChild(child)` |
| insertBefore | 在指定位置插入 | `parent.insertBefore(new, ref)` |
| remove | 移除元素 | `element.remove()` |
| textContent | 获取/设置文本 | `el.textContent` |
| innerHTML | 获取/设置 HTML | `el.innerHTML = '<span>'` |
| className | 获取/设置类名 | `el.className = 'my-class'` |

### 12.3 定时器与异步

| 概念 | 说明 | 示例 |
|------|------|------|
| setTimeout | 延迟执行（一次） | `setTimeout(fn, 1000)` |
| setInterval | 重复执行 | `setInterval(fn, 500)` |
| clearInterval | 停止重复执行 | `clearInterval(timer)` |
| MutationObserver | 观察 DOM 变化 | `new MutationObserver(fn)` |

### 12.4 油猴专用 API

| API | 功能 |
|-----|------|
| `GM_addStyle` | 注入 CSS 样式 |
| `GM_getValue` | 读取存储的数据 |
| `GM_setValue` | 存储数据 |
| `GM_xmlhttpRequest` | 跨域请求 |

---

## 13. 常见问题

### Q1: 脚本没有生效怎么办？

1. 检查油猴扩展是否已启用
2. 检查脚本是否已启用
3. 刷新页面
4. 检查 URL 是否匹配 `@match` 规则

### Q2: 如何查看调试日志？

1. 把 `CONFIG.DEBUG` 改为 `true`
2. 打开浏览器开发者工具（F12）
3. 切换到 Console（控制台）标签
4. 刷新页面，查看以 `[BVQ]` 开头的日志

### Q3: 如何调整判断标准？

修改 CONFIG 中的阈值：

```javascript
const CONFIG = {
    LIKE_RATIO_THRESHOLD: 0.05,  // 改成 0.03 就是 3%
    COIN_RATIO_FACTOR: 0.5,      // 改成 0.3 就是点赞率的 30%
    // ...
};
```

### Q4: 为什么要用轮询？

B 站页面是动态加载的，视频数据不是一开始就有的。轮询是等待数据加载的可靠方式。

### Q5: 为什么要监听 DOM 变化？

B 站是单页应用（SPA），切换视频不会触发页面加载事件。监听 DOM 变化可以检测到这种软切换。

---

## 附录：完整代码流程图

```
用户访问 B 站视频页
        │
        ▼
油猴检测 URL 匹配
        │
        ▼
注入并执行脚本
        │
        ├─────────────────────────────────┐
        ▼                                 │
    注入 CSS 样式                          │
        │                                 │
        ▼                                 │
    启动 MutationObserver                 │
    (监听 URL 变化)                        │
        │                                 │
        ▼                                 │
    执行 run()                            │
        │                                 │
        ▼                                 │
    开始轮询 (每 500ms)                    │
        │                                 │
        ▼                                 │
    extractVideoStats()                   │
    从 DOM 提取数据                        │
        │                                 │
        ├─ 播放量 > 0?                     │
        │      │                          │
        │     是                          │
        │      │                          │
        │      ▼                          │
        │  evaluateQuality()              │
        │  评估视频质量                    │
        │      │                          │
        │      ▼                          │
        │  createBadge()                  │
        │  创建并显示徽章                  │
        │      │                          │
        │      ▼                          │
        │  [等待用户切换视频]              │
        │      │                          │
        │      ▼                          │
        │  MutationObserver 检测到变化 ────┤
        │                                 │
        │     否                          │
        │      │                          │
        │      ▼                          │
        └─ 继续轮询 (最多 40 次)
```

---

## 结语

恭喜你读完了这份详细的文档！通过这个脚本，你学习了：

1. **油猴脚本的基本结构**：元数据块、IIFE、严格模式
2. **DOM 操作**：选择元素、创建元素、修改内容
3. **CSS 注入**：使用 `GM_addStyle` 添加样式
4. **异步编程**：定时器、轮询、MutationObserver
5. **ES6 语法**：箭头函数、模板字符串、解构赋值

希望这份文档能帮助你理解 JavaScript 和用户脚本开发。如果有任何问题，欢迎继续学习和探索！

---

*文档版本：1.0.0*
*最后更新：2026年3月*
