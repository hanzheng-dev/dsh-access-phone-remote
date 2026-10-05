package com.hz.hub;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.DisplayMetrics;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 「网页浮层」—— ds酱 消息里的网页卡片点开后弹出的小窗口。
 *
 * 主人 2026-09-22 原话：
 *   「外面的，比如，后面几天你要提醒我打印准考证，那我直接点网页链接，
 *     展开窗口后，直接操作，不需要切屏，有问题直接告诉你，操作完直接折叠完事」
 *   「不要80%，和那个插入txt占的大小一样，保持格式一致，本来就快捷操作」
 *   「能不能调用带cookie的小框？不然没意义」
 *
 * 设计取舍（写清为什么这么做）：
 *   · **独立 WebView（不是 Dialog 套 iframe）**：webview 的数据目录本身持久 ⇒
 *     登录一次，cookie 就记住了（和电脑 Edge 不共享，Android 跨 App 隔离，主人已接受）。
 *   · **高度 = 75% 屏高**（2026-09-22 23:53 主人："再长一点，现在像蚕蛹" ⇒ 75%），左右各留 12dp。
 *   · **点外面收起**：根布局是遮罩，它自己吃"卡片之外"的点击 ⇒ finish()。
 *   · 外层主题 Theme.Translucent.NoTitleBar（见 Manifest）⇒ 能透出后面的 ds酱。
 *
 * ⭐ 2026-09-22 23:40 样式改造（主人反馈：「样式不太喜欢」「这不是我 app 的东西的感觉」
 *    「网页上面的黑边太厚了，然后太黑了，和 ds酱 背景颜色一样就行，然后倒角」）：
 *   · **遮罩大幅减淡**：原来 60% 黑 ⇒ 浅色 12% / 深色 24%，不再"很黑"。
 *   · **标题栏跟主题同色**：不再写死 #2b2b2b 深灰；由 MainActivity 把"当前页面是深是浅"
 *     随 intent 传进来（复用页面已有 JS 桥 setBarIcons 的思路），浅色主题 = 白底黑字，
 *     深色主题 = #1e1e1e 底浅字 ⇒ 和 ds酱 **一个色**（这就是主人要的"跟背景一样"）。
 *   · **圆角**：卡片 16dp 圆角 + `setClipToOutline` ⇒ WebView 的直角也被裁进圆角里。
 *   · 标题栏**变薄**：去掉原来底部的 host 小字行（两条文字叠起来才显得"厚"）。
 *
 * ⚠️ 编码约定（和 MainActivity 一样）：**禁止匿名内部类** ——
 *    d8 在 JDK 24 上遇到匿名类必崩（NullPointerException）。回调一律具名静态嵌套类。
 *
 * 2026-09-22 创建
 */
public class WebActivity extends Activity {

    static final String TAG = "DsWeb";

    /** 当前活着的浮层实例（onCreate 置、onDestroy 清）。 */
    static WebActivity live;

    // ══════════════════════════════════════════════════════════════════
    // ⭐⭐ 2026-09-23 op：**WebView 预热 + 保活**（主人：「每次启动组件都要加载」）
    //   病根：WebActivity 是独立 Activity ⇒ 关浮层即 onDestroy ⇒ web.destroy()
    //         ⇒ 下次再点又 new WebView ⇒ Chromium 引擎重新冷启动 = 那"一会会"。
    //   做法（方案 A）：
    //     · **预热**：App 启动后（MainActivity.onCreate）在后台建一个空 WebView
    //       （about:blank），让引擎先热起来；建完**不销毁**，留在静态字段里。
    //     · **保活/复用**：浮层打开时**领养**这个静态 WebView（有就用、没有才新建）；
    //       浮层关闭时**不 destroy**，摘出视图树后放回静态字段 ⇒ 第二次开秒开
    //       （连引擎带页面都在）。
    //   ⚠️ **必须在主线程建/用**：WebView 有线程亲和性 —— 若在后台线程建，
    //      主线程的浮层就没法复用它（会崩）。所以预热走 `postDelayed`（延后到
    //      启动流程之后、不卡启动），而不是丢给后台线程。
    //   ⚠️ 一律用 **applicationContext**：静态持有也不泄漏 Activity。
    //   ⚠️ 不把预热的 WebView 加进视图树（不加就不显示）。
    // ══════════════════════════════════════════════════════════════════
    static WebView warm;
    static final Object WARM_LOCK = new Object();

    /** 具名：预热任务（禁止匿名内部类 —— d8/JDK24 会崩） */
    static class PreheatRunnable implements Runnable {
        private final Context ctx;
        PreheatRunnable(Context c) { ctx = c; }
        public void run() {
            synchronized (WARM_LOCK) {
                if (warm != null) return;
                try {
                    WebView w = new WebView(ctx);
                    WebSettings s = w.getSettings();
                    s.setJavaScriptEnabled(true);
                    s.setDomStorageEnabled(true);
                    // ⭐ 2026-09-26：预热的默认页从 about:blank（纯白）换成**本地首页**（两个快捷入口）
                    loadHome(w);
                    warm = w;
                    Log.i(TAG, "WebView 预热完成（引擎常驻，浮层可复用）");
                } catch (Throwable t) {
                    Log.w(TAG, "WebView 预热失败: " + t);
                }
            }
        }
    }

    /** App 启动时调用：延后 800ms 预热（别和启动抢主线程） */
    public static void preheat(Context appCtx) {
        if (appCtx == null) return;
        new Handler(Looper.getMainLooper()).postDelayed(new PreheatRunnable(appCtx), 800);
    }

    /** 领养预热的 WebView（有就返回，没有返回 null ⇒ 调用方新建） */
    static WebView takeWarm() {
        synchronized (WARM_LOCK) {
            WebView w = warm;
            warm = null;
            return w;
        }
    }

    /** 浮层关闭时把 WebView 放回池子（下次复用）；池子已有才真销毁 */
    static void recycle(WebView w) {
        if (w == null) return;
        synchronized (WARM_LOCK) {
            if (warm == null) { warm = w; return; }
        }
        try { w.destroy(); } catch (Throwable t) { /* 忽略 */ }
    }

    /** 浮层高度占屏高的比例 —— 2026-09-22 23:53 主人要"再长一点"（原 60% 像蚕蛹）⇒ 75% */
    private static final double H_RATIO = 0.75;

    // ══════════════════════════════════════════════════════════════════
    // ⭐⭐ 2026-09-26 主人要的：浮层浏览器的**默认页** = 本地首页（搜索框 + 两个快捷入口）。
    //   主人原话：「默认白页 ⇒ 改成带两个快捷按钮的首页：① GG公益站 ② DeepSeek用量」；
    //   ⚠️ 当天当场纠正：「**你给我搜索栏干没了**」⇒ 搜索框必须留着（照 start.html，回车走必应）。
    //   · 内置 HTML 用 `loadDataWithBaseURL` 注入当前 WebView（**不建新 Activity、不联网、离线可用**）。
    //   · 只有"没有 URL 可加载"时才出现（预热 / 无 URL 打开）；带 URL 的网页卡片照旧直接加载那个 URL。
    //   · 按钮做成大块卡片（手指好点），点一下走 `WebClient.shouldOverrideUrlLoading` ⇒
    //     在当前 WebView 里 loadUrl（不跳外部浏览器）；首页留在历史里，标题栏「◀」可退回首页。
    //   · 两个目标都是国内站点，直连即可。
    // ══════════════════════════════════════════════════════════════════
    private static final String HOME_HTML =
        "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'>" +
        "<meta name='viewport' content='width=device-width,initial-scale=1,viewport-fit=cover'>" +
        "<title>搜索</title><style>" +
        "*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}" +
        "html,body{margin:0;padding:0;min-height:100%;background:#fff}" +
        "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;" +
        "color:#202020;padding:26px 22px}" +
        "form{display:flex;align-items:center;gap:10px;border:1px solid #e0e0e0;border-radius:22px;" +
        "background:#fff;padding:0 6px 0 18px;height:48px;margin:0 0 20px}" +
        "form:focus-within{border-color:#b9b9b9;box-shadow:0 1px 6px rgba(0,0,0,.07)}" +
        "input{flex:1;min-width:0;height:100%;border:0;outline:0;background:transparent;" +
        "font-size:16px;color:#202020;font-family:inherit}" +
        "input::placeholder{color:#a0a0a0}" +
        "button.q{flex:none;width:38px;height:38px;border:0;border-radius:50%;background:transparent;" +
        "color:#5a5a5a;display:flex;align-items:center;justify-content:center;padding:0}" +
        "button.q:active{background:#f2f2f2}" +
        "svg{width:19px;height:19px;display:block}" +
        ".stitle{font-size:13px;color:#9a9a9a;margin:0 0 12px}" +
        "a.card{display:flex;align-items:center;gap:14px;text-decoration:none;color:inherit;" +
        "border:1px solid #e6e6e6;border-radius:16px;background:#fafafa;padding:20px 18px;margin:0 0 16px}" +
        "a.card:active{background:#f0f0f0}" +
        ".tx{min-width:0}" +
        ".t{display:block;font-size:16.5px;font-weight:600;margin-bottom:3px}" +
        ".s{display:block;font-size:12.5px;color:#9a9a9a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
        ".arw{margin-left:auto;color:#c0c0c0;font-size:20px}" +
        "</style></head><body>" +
        "<form id='f' autocomplete='off'>" +
        "<input id='q' type='search' placeholder='搜索' enterkeyhint='search' autocomplete='off' autocapitalize='off' spellcheck='false'>" +
        "<button class='q' type='submit' aria-label='搜索'>" +
        "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'>" +
        "<circle cx='11' cy='11' r='7'></circle><path d='M20 20l-3.6-3.6'></path></svg></button></form>" +
        "<p class='stitle'>快捷入口</p>" +
        "<a class='card' href='https://gcli.ggchan.dev'>" +
        "<span class='tx'><span class='t'>GG 公益站</span><span class='s'>gcli.ggchan.dev</span></span>" +
        "<span class='arw'>&#8250;</span></a>" +
        "<a class='card' href='https://platform.deepseek.com/usage'>" +
        "<span class='tx'><span class='t'>DeepSeek 用量</span><span class='s'>platform.deepseek.com/usage</span></span>" +
        "<span class='arw'>&#8250;</span></a>" +
        "<script>(function(){var f=document.getElementById('f'),q=document.getElementById('q');" +
        "f.addEventListener('submit',function(e){e.preventDefault();var v=(q.value||'').trim();if(!v)return;" +
        "location.href='https://cn.bing.com/search?q='+encodeURIComponent(v);});" +
        "try{q.focus();}catch(err){}})();</script>" +
        "</body></html>";

    /** 把本地首页注入指定 WebView（预热 / 无 URL 打开时用） */
    static void loadHome(WebView w) {
        if (w == null) return;
        try {
            w.loadDataWithBaseURL("https://home.dsjiang.local/", HOME_HTML,
                    "text/html", "utf-8", null);
            Log.i(TAG, "加载本地首页（两个快捷入口）");
        } catch (Throwable t) {
            Log.w(TAG, "加载本地首页失败: " + t);
        }
    }

    // ⭐ 2026-10-05 开源版：**已去掉代理概念**。
    //   原实现让"被墙站"走电脑上的 Clash（ProxyConfig / ProxyController + androidx-webkit），
    //   那是原作者的私人环境特征（他有 Clash + VPS）⇒ 开源版一律直连：
    //   少一个字段、少一处困惑、少一个 bug。

    private WebView web;
    private TextView titleView;
    private TextView backView;              // ★ 2026-09-23 标题栏「◀ 返回」
    private String pageUrl;
    private boolean loaded;

    /** 具名：卡片外的点击 ⇒ 收起浮层 */
    static class FinishClick implements View.OnClickListener {
        private final Activity act;
        FinishClick(Activity a) { act = a; }
        public void onClick(View v) { act.finish(); }
    }

    /**
     * ★ 2026-09-23 具名：标题栏「◀ 返回」的点击 ⇒ 能退就退、退到头就关浮层。
     *   ⚠️ 必须是具名类（匿名内部类会让 d8 崩，见文件顶部编码约定）。
     */
    static class BackClick implements View.OnClickListener {
        private final WebActivity act;
        BackClick(WebActivity a) { act = a; }
        public void onClick(View v) { act.doBack(); }
    }

    /** 具名：卡片自己吃点击（不触发遮罩的 finish） */
    static class SwallowClick implements View.OnClickListener {
        public void onClick(View v) { /* 故意留空：只是消费掉这次点击 */ }
    }

    /** 具名：网页内部跳转仍在浮层里加载（不跳外部浏览器） */
    static class WebClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView v, String url) {
            v.loadUrl(url);
            return true;
        }
    }

    /** 具名：网页标题回填到浮层标题栏 */
    static class Chrome extends WebChromeClient {
        private final WebActivity act;
        Chrome(WebActivity a) { act = a; }
        @Override
        public void onReceivedTitle(WebView v, String t) { act.applyTitle(t); }
    }

    int dp(float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
                getResources().getDisplayMetrics());
    }

    void applyTitle(String t) {
        if (titleView != null && t != null && t.trim().length() > 0) {
            titleView.setText(t.trim());
        }
    }

    /** 加载当前页面（onCreate 里调用一次；空 URL = 本地首页） */
    synchronized void loadOnce() {
        if (loaded) return;
        loaded = true;
        if (web == null) return;
        if (pageUrl != null) {
            web.loadUrl(pageUrl);
            // ⭐ 复用的 WebView 带着上一次的历史/空白页 ⇒ 清掉，避免"返回"退到旧页面
            try { web.clearHistory(); } catch (Throwable t) { /* 忽略 */ }
        } else {
            // ⭐ 2026-09-26：没有 URL 可加载（预热 / 无 URL 打开）⇒ 显示本地首页
            loadHome(web);
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        live = this;

        Intent it = getIntent();
        final String url = it != null ? it.getStringExtra("url") : null;
        String title = it != null ? it.getStringExtra("title") : null;
        // ⭐ 2026-09-22：主题由 MainActivity 随 intent 传（网页通过 setBarIcons 桥报上来的）
        final boolean dark = it != null && it.getBooleanExtra("dark", false);

        // 二次校验（Java 侧也不许跑 javascript:/file:/data: —— 网页侧已拦一道）
        // ⭐ 2026-09-26：**空 URL = 显示本地首页**（两个快捷入口），不再直接 finish；
        //   只有"传了 URL 但不是 http/https"才拒（防 javascript:/file:/data:）。
        final boolean hasUrl = url != null && url.trim().length() > 0;
        if (hasUrl && !(url.startsWith("http://") || url.startsWith("https://"))) {
            Log.w(TAG, "非法 url: " + url);
            finish();
            return;
        }

        // 配色：**和 ds酱 同色**（浅色 #fff / 深色 #1e1e1e），不用纯黑
        final int cardBg   = dark ? 0xff1e1e1e : 0xffffffff;
        final int lineCol  = dark ? 0x33ffffff : 0x22000000;
        final int titleCol = dark ? 0xfff0f0f0 : 0xff141414;
        final int closeCol = dark ? 0xffc9c9c9 : 0xff6b6b6b;
        final int webBg    = dark ? 0xff111111 : 0xffffffff;
        final int maskCol  = dark ? 0x3d000000 : 0x1f000000;   // 12%/24%，不再 60% 黑

        // 软键盘：网页里有输入框（登录/搜索）时要顶得起来
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        // ---------- 遮罩（点它 = 收起）—— 很淡，能看见下面的 ds酱 ----------
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(maskCol);
        root.setOnClickListener(new FinishClick(this));

        // ---------- 卡片（圆角 + 同主题色） ----------
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable cardBgDraw = new GradientDrawable();
        cardBgDraw.setColor(cardBg);
        cardBgDraw.setCornerRadius(dp(16));
        cardBgDraw.setStroke(dp(1), lineCol);
        card.setBackground(cardBgDraw);
        card.setClipToOutline(true);             // ⭐ 把 WebView 的直角也裁进圆角里
        card.setClickable(true);                 // 吃掉卡片内的点击，别传到遮罩
        card.setOnClickListener(new SwallowClick());

        // 高度 = 75% 屏高（getRealMetrics 拿整屏，不含虚拟导航栏的裁切）
        DisplayMetrics dm = new DisplayMetrics();
        getWindowManager().getDefaultDisplay().getRealMetrics(dm);
        int cardH = (int) (dm.heightPixels * H_RATIO);
        int side = dp(12);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, cardH, Gravity.CENTER);
        lp.leftMargin = side;
        lp.rightMargin = side;
        root.addView(card, lp);

        // ---------- 标题栏：标题 + ✕（变薄；和卡片同色） ----------
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(cardBg);
        bar.setPadding(dp(16), dp(9), dp(6), dp(9));

        // ---------- ★ 2026-09-23 主人要求：加「◀ 返回」按钮 ----------
        //   原因（主人原话）：「给浏览器悬浮窗加个返回按钮，不然退不了」
        //   行为：能后退就后退（网页内的上一页）；退到头了就关掉整个浮层。
        backView = new TextView(this);
        backView.setText("◀");
        backView.setTextColor(closeCol);
        backView.setTextSize(16);
        backView.setGravity(Gravity.CENTER);
        backView.setPadding(dp(14), dp(4), dp(14), dp(4));
        backView.setContentDescription("返回");
        // ⚠️ 必须用具名类：匿名内部类会让 d8（JDK24）崩 —— 见文件顶部编码约定
        backView.setOnClickListener(new BackClick(this));
        bar.addView(backView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        titleView = new TextView(this);
        titleView.setText(title != null && title.trim().length() > 0
                ? title.trim() : (hasUrl ? "网页" : "浏览器"));
        titleView.setTextColor(titleCol);
        titleView.setTextSize(14.5f);
        titleView.setSingleLine(true);
        titleView.setEllipsize(TextUtils.TruncateAt.END);
        titleView.setPadding(dp(4), 0, 0, 0);
        bar.addView(titleView, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView close = new TextView(this);
        close.setText("✕");
        close.setTextColor(closeCol);
        close.setTextSize(17);
        close.setGravity(Gravity.CENTER);
        close.setPadding(dp(14), dp(4), dp(14), dp(4));
        close.setOnClickListener(new FinishClick(this));
        bar.addView(close, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        card.addView(bar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // 标题栏下面一条极细分割线（区别于网页本体，又不显得"厚边"）
        View divider = new View(this);
        divider.setBackgroundColor(lineCol);
        card.addView(divider, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(1)));

        // ---------- 网页本体 ----------
        // ⭐ 2026-09-23：优先领养预热/上次留下的 WebView（引擎 + 页面都还在 ⇒ 秒开）
        web = takeWarm();
        if (web == null) web = new WebView(getApplicationContext());
        web.setBackgroundColor(webBg);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);          // 现代网页没它不能登录
        s.setDomStorageEnabled(true);          // 不少站点登录依赖 localStorage
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(true);                // 允许双指缩放（小浮层看网页必备）
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        // ⭐ 持久 cookie：WebView 的 CookieManager 默认写自己的数据目录 ⇒
        //    登录一次以后都认得（重启 App 也还在）。**与电脑 Edge 不共享**（Android 跨 App 隔离）。
        try {
            CookieManager cm = CookieManager.getInstance();
            cm.setAcceptCookie(true);
            cm.setAcceptThirdPartyCookies(web, true);
        } catch (Exception e) {
            Log.w(TAG, "CookieManager 设置失败: " + e.getMessage());
        }

        web.setWebViewClient(new WebClient());
        web.setWebChromeClient(new Chrome(this));
        card.addView(web, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);
        // ⭐ 2026-09-26：空 URL ⇒ pageUrl=null ⇒ loadOnce 里改成加载本地首页
        // ⭐ 2026-10-05 开源版：已去掉代理概念，直接加载（默认直连）
        this.pageUrl = hasUrl ? url : null;
        loadOnce();
        Log.i(TAG, "浮层打开: " + (this.pageUrl == null ? "(本地首页)" : this.pageUrl));
    }

    /**
     * ★ 2026-09-23 统一的后退逻辑（标题栏「◀」按钮 和 系统返回键 共用）
     *   规则：网页能后退 ⇒ 后退一页（网页内的上一页）；
     *         退到头了   ⇒ 关闭整个浮层。
     *   ⚠️ 主人原话：「给浏览器悬浮窗加个返回按钮，不然退不了」——
     *      之前只有系统返回键，手机全屏手势下不好按/按不到，所以在标题栏补了一个。
     */
    void doBack() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        finish();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            doBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (live == this) live = null;
        if (web != null) {
            // ⭐ A-2：先摘出视图树，再**放回静态池**（不销毁）⇒ 下次开浮层直接复用
            try {
                ViewGroup p = (ViewGroup) web.getParent();
                if (p != null) p.removeView(web);
            } catch (Throwable t) {
                Log.w(TAG, "摘出 WebView 失败: " + t);
            }
            recycle(web);
            web = null;
        }
        super.onDestroy();
    }
}
