package com.hz.hub;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.text.InputType;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * ds酱 —— 手机端外壳
 *
 * 设计：全屏 WebView 加载电脑上的界面。
 * 好处：改 UI 只需改服务器上的 HTML，APK 不用重装。
 *
 * ⚠️ 编码约定（2026-09-13 血泪教训）：
 *   本工程禁止使用匿名内部类 —— d8 在 JDK 24 上遇到匿名类必崩
 *   （NullPointerException: Cannot invoke "String.length()"）。
 *   所有回调一律写成【具名静态嵌套类】。
 *
 * 2026-09-15 创建
 * 2026-09-17 op 加：拍照 / 相册直发（JS 桥 + 原生上传 + /api/push）
 */
public class MainActivity extends Activity {

    // ══════════════════════════════════════════════════════════════
    // ★ 2026-10-05 开源版：地址 / 口令**不再写死**，改为运行期配置。
    //   来源 = SharedPreferences（文件 "dsj"），由首次配置页写入（见 showConfig / submitConfig）。
    //     · HUB  = 服务基址，如 http://192.168.1.100:3099（不带尾斜杠）
    //     · HOME = HUB + "/"
    //     · AUTH = 服务端口令（原生请求走 X-Auth 头；WebView 靠 /?t= 首次访问种 Cookie）
    //   同一份配置也供 NotifyService / WebActivity 读取：hubOf() / authOf()。
    // ══════════════════════════════════════════════════════════════
    static String HUB = "";
    static String HOME = "";
    static String AUTH = "";
    // 配置存储（SharedPreferences 文件名 + 键名）
    static final String PREFS = "dsj";
    static final String K_HUB = "hub";
    static final String K_AUTH = "auth";
    private static final String TAG = "DsMain";
    private static final int REQ_NOTIFY = 101;
    private static final int REQ_CAM = 201;
    private static final int REQ_PICK = 202;
    private static final int REQ_FILE = 203;
    private static final int REQ_LOC = 301;   // ⭐ 2026-09-30：定位权限动态申请
    private static final int REQ_STORE = 302; // ⭐ 2026-10-05（阶段7）：存储权限（仅 API<29 收文件用）

    // ⭐ 2026-09-22 op：**全屏（edge-to-edge）后，状态栏图标黑/白的自动同步脚本**。
    //   为什么由原生注入、不改 index.html：index.html 是主人手机正在用的生产页面，
    //   改错 = 白屏（备份+本地测的成本也高）。这里只**读**页面顶部的颜色，回调原生。
    //   逻辑：在状态栏高度内取 3 个点 → elementFromPoint → 沿祖先链找第一个
    //         不透明的 backgroundColor → 算亮度 ⇒ 浅色页面用深色图标。
    //   触发：页面加载完 + 每秒一次（SPA 切页/切主题没有事件可听）+ html class 变化。
    private static final String EDGE_JS =
        "(function(){if(window.__dsBarSync)return;window.__dsBarSync=1;" +
        "var last=null;" +
        "function lum(c){var m=/rgba?\\(([^)]+)\\)/.exec(c||'');if(!m)return -1;" +
        "var p=m[1].split(',');var a=p.length>3?parseFloat(p[3]):1;if(a<0.5)return -1;" +
        "return 0.299*parseFloat(p[0])+0.587*parseFloat(p[1])+0.114*parseFloat(p[2]);}" +
        "function sample(){try{var x=Math.round(window.innerWidth/2);var ys=[4,10,18];" +
        "for(var i=0;i<ys.length;i++){var el=document.elementFromPoint(x,ys[i]);" +
        "while(el){var L=lum(getComputedStyle(el).backgroundColor);if(L>=0)return L>140;" +
        "el=el.parentElement||null;}}}catch(e){}" +
        "return !document.documentElement.classList.contains('dark');}" +
        "function tick(){var light=sample();if(light!==last){last=light;" +
        "try{window.DsNative.setBarIcons(light);}catch(e){}}}" +
        "tick();setInterval(tick,800);" +
        "try{new MutationObserver(tick).observe(document.documentElement," +
        "{attributes:true,attributeFilter:['class']});}catch(e){}" +
        "})();";

    private WebView web;
    /** 全分辨率拍照的目标（MediaStore 里新建的那行；API<29 时为 null ⇒ 退回缩略图） */
    private Uri camUri;
    /** WebView 的 <input type=file> 回调（不实现它，网页里的文件选择器根本不弹） */
    private ValueCallback<Uri[]> fileCb;
    /** ⭐ 2026-09-22：页面顶部当前是不是浅色（由网页 JS 桥 setBarIcons 报上来）——
     *  开「网页浮层」时按它给浮层选浅色/深色皮肤（和 ds酱 同色）。 */
    private boolean lastLightBg = true;

    // ★ 2026-10-05：配置页控件 + 主页加载状态（右上角「⚙ 配置」兜底按钮用）
    private EditText cfgUrl;
    private TextView cfgPill;
    private long loadStartedAt = 0;
    private long lastErrorAt = 0;

    // ⭐⭐ 2026-09-30 op：**定位（按需）** —— 只有前端点「📍 定位」才请求，不常驻、不耗电。
    private LocationManager locMgr;
    private LocListener locListener;
    private final Handler locHandler = new Handler(Looper.getMainLooper());
    private Runnable locTimeout;

    /** 具名 WebViewClient —— 不能用匿名类 */
    static class HubWebViewClient extends WebViewClient {
        private final MainActivity act;
        HubWebViewClient(MainActivity a) { act = a; }
        @Override
        public boolean shouldOverrideUrlLoading(WebView v, String url) {
            v.loadUrl(url);
            return true;
        }
        @Override
        public void onPageFinished(WebView v, String url) {
            // ⭐ 2026-09-22 op：每次页面加载完注入状态栏图标同步脚本（SPA 内部切页不管，
            //   页面不重载 ⇒ 靠脚本里的 setInterval 兜）
            try { v.evaluateJavascript(MainActivity.EDGE_JS, null); } catch (Exception e) {}
            act.onPageDone();   // ★ 开源版：本次加载没出错 ⇒ 收起「⚙ 配置」
        }
        @Override
        public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
            // ★ 开源版：主页面加载失败（地址变了 / 服务没开）⇒ 右上角浮出「⚙ 配置」
            if (req != null && req.isForMainFrame()) act.onLoadError();
        }
    }

    /** 具名 WebChromeClient —— 转发文件选择器（<input type=file> 必需） */
    static class HubChromeClient extends WebChromeClient {
        private final MainActivity act;
        HubChromeClient(MainActivity a) { act = a; }
        @Override
        public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb,
                                         FileChooserParams params) {
            return act.openFileChooser(cb, params);
        }
    }

    // ══════════════════════════════════════════════════════════════
    // 2026-09-17 op：**拍照 / 相册 → 直接发给 dsh**
    //   主人原话：「拍照直接发你」
    //   链路：网页按钮 → window.DsNative.takePhoto() → 系统相机/相册
    //         → 原生读字节 → POST /api/upload → POST /api/push(image)
    //         → hub 走 SSE 把带图消息推回页面（不用 JS 传 base64，几 MB 的相册图也不怕）
    // ══════════════════════════════════════════════════════════════

    /** JS 桥。方法在 WebView 的 JS 线程被调用 ⇒ 一律 runOnUiThread 回主线程起 Activity。 */
    static class DsNative {
        private final MainActivity act;
        DsNative(MainActivity a) { act = a; }
        @JavascriptInterface
        public void takePhoto() { act.runOnUiThread(new TakePhotoRunnable(act)); }
        @JavascriptInterface
        public void pickPhoto() { act.runOnUiThread(new PickPhotoRunnable(act)); }
        /** ⭐ 2026-09-22：消息里的「网页卡片」点开 ⇒ 弹一个小浮层（WebActivity）。
         *  主人：「直接点网页链接，展开窗口后直接操作，不需要切屏」 */
        @JavascriptInterface
        public void openWeb(String url, String title) {
            act.runOnUiThread(new OpenWebRunnable(act, url, title));
        }
        /** ⭐ 2026-09-22：页面顶部是浅色(true)还是深色(false) ⇒ 状态栏图标用黑还是白 */
        @JavascriptInterface
        public void setBarIcons(boolean lightBg) {
            act.runOnUiThread(new BarIconsRunnable(act, lightBg));
        }
        /** ⭐⭐ 2026-09-30：**定位**（按需）。页面弹「位置」页时调它。
         *  结果通过 `window.DsLoc.onResult(json)` / `onError(msg)` 回给页面；
         *  同时原生会 POST /api/loc 上报 hub（窗口 AI 可读）。 */
        @JavascriptInterface
        public void getLocation() { act.runOnUiThread(new LocRunner(act)); }
        /** ⭐ 2026-09-30：**用地图打开** —— 通用 `geo:`（不用 key，唤起手机上已装的地图 App） */
        @JavascriptInterface
        public void openGeo(String lat, String lng, String name) {
            act.runOnUiThread(new GeoRunnable(act, lat, lng, name, false));
        }
        /** ⭐ 2026-09-30：**导航到…** —— 高德 `androidamap://` → 百度 `baidumap://` → geo 兜底 */
        @JavascriptInterface
        public void openNav(String name, String lat, String lng) {
            act.runOnUiThread(new GeoRunnable(act, lat, lng, name, true));
        }
        /** ★ 2026-10-05 开源版：页面想改地址 ⇒ 调 `window.DsNative.reconfigure()` 打开配置页 */
        @JavascriptInterface
        public void reconfigure() {
            act.runOnUiThread(new ReconfigRunnable(act));
        }
    }

    static class BarIconsRunnable implements Runnable {
        private final MainActivity act;
        private final boolean lightBg;
        BarIconsRunnable(MainActivity a, boolean b) { act = a; lightBg = b; }
        public void run() { act.applyBarIcons(lightBg); }
    }

    static class TakePhotoRunnable implements Runnable {
        private final MainActivity act;
        TakePhotoRunnable(MainActivity a) { act = a; }
        public void run() { act.startCamera(); }
    }

    static class PickPhotoRunnable implements Runnable {
        private final MainActivity act;
        PickPhotoRunnable(MainActivity a) { act = a; }
        public void run() { act.startPicker(); }
    }

    /** ⭐ 2026-09-22：网页浮层（具名类 —— 工程禁止匿名内部类，d8 会崩） */
    static class OpenWebRunnable implements Runnable {
        private final MainActivity act;
        private final String url;
        private final String title;
        OpenWebRunnable(MainActivity a, String u, String t) { act = a; url = u; title = t; }
        public void run() { act.startWebLayer(url, title); }
    }

    /** ★ 2026-10-05：JS 桥 `reconfigure()` ⇒ 打开配置页（具名类，禁止匿名内部类） */
    static class ReconfigRunnable implements Runnable {
        private final MainActivity act;
        ReconfigRunnable(MainActivity a) { act = a; }
        public void run() { act.showConfig(); }
    }

    /** ★ 2026-10-05：配置页「连接」按钮（具名类） */
    static class ConnectClick implements View.OnClickListener {
        private final MainActivity act;
        ConnectClick(MainActivity a) { act = a; }
        public void onClick(View v) { act.submitConfig(); }
    }

    /** ★ 2026-10-05：主页右上角「⚙ 配置」兜底按钮（具名类） */
    static class ConfigClick implements View.OnClickListener {
        private final MainActivity act;
        ConfigClick(MainActivity a) { act = a; }
        public void onClick(View v) { act.showConfig(); }
    }

    // ⭐⭐ 2026-09-30 op：定位相关 —— 全部具名类（禁止匿名内部类，d8 在 JDK24 上会崩）
    static class LocRunner implements Runnable {
        private final MainActivity act;
        LocRunner(MainActivity a) { act = a; }
        public void run() { act.requestLocation(); }
    }

    /** LocationListener 具名实现 —— 只关心"拿到新位置" */
    static class LocListener implements LocationListener {
        private final MainActivity act;
        LocListener(MainActivity a) { act = a; }
        @Override public void onLocationChanged(Location loc) { act.onLocFix(loc); }
        @Override public void onStatusChanged(String p, int s, Bundle b) {}
        @Override public void onProviderEnabled(String p) {}
        @Override public void onProviderDisabled(String p) {}
    }

    /** 把坐标 POST 到 hub /api/loc（后台线程，别堵 UI） */
    static class LocPostRunner implements Runnable {
        private final MainActivity act;
        private final JSONObject body;
        LocPostRunner(MainActivity a, JSONObject b) { act = a; body = b; }
        public void run() { act.postLocation(body); }
    }

    /** 定位超时收工（防止一直挂着耗电） */
    static class LocTimeoutRunner implements Runnable {
        private final MainActivity act;
        LocTimeoutRunner(MainActivity a) { act = a; }
        public void run() { act.stopLocating(); }
    }

    /** 唤起地图 / 导航（UI 线程） */
    static class GeoRunnable implements Runnable {
        private final MainActivity act;
        private final String lat, lng, name;
        private final boolean nav;
        GeoRunnable(MainActivity a, String la, String lo, String n, boolean nv) {
            act = a; lat = la; lng = lo; name = n; nav = nv;
        }
        public void run() {
            if (nav) act.startNav(name, lat, lng);
            else act.startGeo(lat, lng, name);
        }
    }

    /** 读图 + 上传（放后台线程，别堵 UI） */
    static class ImageRunner implements Runnable {
        private final MainActivity act;
        private final Uri uri;
        private final Bitmap bm;
        private final String label;
        ImageRunner(MainActivity a, Uri u, Bitmap b, String l) {
            act = a; uri = u; bm = b; label = l;
        }
        public void run() {
            if (bm != null) act.handleThumb(bm, label);
            else act.handleImage(uri, label);
        }
    }

    static class ToastRunnable implements Runnable {
        private final MainActivity act;
        private final String msg;
        ToastRunnable(MainActivity a, String m) { act = a; msg = m; }
        public void run() {
            try { Toast.makeText(act, msg, Toast.LENGTH_SHORT).show(); } catch (Exception e) {}
        }
    }

    void toast(String s) { runOnUiThread(new ToastRunnable(this, s)); }

    // ═══════════════════════════════════════════════════════════════════
    // ⭐ 2026-09-22 op：**真·全屏（edge-to-edge）** —— 主人：「最顶上那几px的小黑条是什么鬼？？」
    //   病根：主题 Theme.Black + 窗口默认给状态栏让位 ⇒ WebView 被**挤到状态栏下面**，
    //         顶上那条露的是窗口背景（黑色）⇒ 浅色页面（账本 #f7f5ef）上特别刺眼。
    //   做法（方案 A —— 老 API，兼容 targetSdk=33 / android.jar API 33）：
    //     · 状态栏/导航栏**透明** + LAYOUT_FULLSCREEN|LAYOUT_HIDE_NAVIGATION
    //       ⇒ 布局铺到整屏，内容**压在**状态栏下面
    //     · 图标黑白：页面侧脚本按"顶部颜色"回调 setBarIcons()，动态切
    //     · 页面侧留白：index.html 已有 viewport-fit=cover + env(safe-area-inset-*)（现成）
    //   ⚠️ 为什么不用 setDecorFitsSystemWindows(false)（API 30+）：
    //      它是 API 30 才有的新 API，而且会关掉窗口自动 inset（软键盘 adjustResize 行为有变）。
    //      老标志位在 Android 16 上对 targetSdk<35 的 App 照常生效（兼容模式），零风险。
    //   ⚠️ 为什么不改 Manifest 的 Theme.Black：铺满后状态栏那条**画的是网页自己的底色**，
    //      窗口背景只在启动那一瞬可见（和 WebView 背景 #0d0d0d 同色，无违和）。
    // ═══════════════════════════════════════════════════════════════════
    void setupEdgeToEdge() {
        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        w.setStatusBarColor(Color.TRANSPARENT);
        w.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= 29) {
            // 手势导航栏默认会自动加一层灰底 ⇒ 关掉，才是真透
            w.setStatusBarContrastEnforced(false);
            w.setNavigationBarContrastEnforced(false);
        }
        if (Build.VERSION.SDK_INT >= 28) {
            // 刘海/挖孔屏：允许铺进挖孔区（否则系统给窗口两侧加黑边）
            WindowManager.LayoutParams lp = w.getAttributes();
            lp.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            w.setAttributes(lp);
        }
        applyBarIcons(false);   // 初始按深色给（浅色页面加载后 JS 会回调纠正）
    }

    /** lightBg=true ⇒ 顶部浅色 ⇒ 图标用深色；false ⇒ 图标用浅色（白）
     *
     *  ⚠️ 2026-09-22 实测（两台状态都验过）：
     *    · 带上 `LAYOUT_HIDE_NAVIGATION` 后，**软键盘照常把页面顶上去**
     *      （账本页截图：内容正好停在键盘上沿 y=1971 = 3200-1229，adjustResize 没坏；
     *       中间那次"键盘不弹"是**页面自己重渲染抢走了输入焦点**，与本改动无关）
     *    ⇒ 顶部**和**底部一起铺满（底部也不留黑条）。
     */
    void applyBarIcons(boolean lightBg) {
        lastLightBg = lightBg;   // ⭐ 记下来，给「网页浮层」选皮肤用
        View dv = getWindow().getDecorView();
        int v = dv.getSystemUiVisibility();
        v |= View.SYSTEM_UI_FLAG_LAYOUT_STABLE
           | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
           | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
        if (lightBg) {
            v |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            v |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        } else {
            v &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            v &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        dv.setSystemUiVisibility(v);
    }

    void startCamera() {
        Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        camUri = null;
        // API 29+ 可以往 MediaStore 里插一行拿到 content:// 目标（不需要 FileProvider，也不需要存储权限）
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Images.Media.DISPLAY_NAME,
                        "ds_" + System.currentTimeMillis() + ".jpg");
                v.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                v.put(MediaStore.Images.Media.RELATIVE_PATH,
                        Environment.DIRECTORY_PICTURES + "/dsjiang");
                camUri = getContentResolver().insert(
                        MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
            } catch (Exception e) {
                camUri = null;
                Log.w(TAG, "MediaStore insert 失败，退回缩略图: " + e.getMessage());
            }
        }
        if (camUri != null) {
            i.putExtra(MediaStore.EXTRA_OUTPUT, camUri);
            i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        }
        try {
            startActivityForResult(i, REQ_CAM);
        } catch (Exception e) {
            toast("没有相机应用");
            Log.w(TAG, "启动相机失败: " + e.getMessage());
        }
    }

    /** ⭐ 2026-09-22：打开「网页浮层」—— 主页「控制」板块的 🌐 浏览器按钮 / 消息里的网页卡片都走这里。
     *  ⚠️ 只放行 http/https（javascript:/file:/data: 一律拒），Java 侧再拦一道。 */
    void startWebLayer(String url, String title) {
        String u = url == null ? "" : url.trim();
        // ⭐ 2026-09-26：**空 URL = 打开浮层的本地首页**（两个快捷入口；APK 内置、不联网）。
        boolean home = u.length() == 0;
        if (!home && !(u.startsWith("http://") || u.startsWith("https://"))) {
            toast("只支持 http/https 网页");
            Log.w(TAG, "拒开非法 url: " + u);
            return;
        }
        try {
            Intent i = new Intent(this, WebActivity.class);
            if (!home) i.putExtra("url", u);          // 空 URL 不传 ⇒ WebActivity 显示本地首页
            i.putExtra("title", title == null ? "" : title);
            i.putExtra("dark", !lastLightBg);   // ⭐ 跟 ds酱 当前主题一致
            startActivity(i);
        } catch (Exception e) {
            toast("打不开浮层：" + e.getMessage());
            Log.w(TAG, "打开浮层失败: " + e.getMessage());
        }
    }

    void startPicker() {
        Intent i;
        if (Build.VERSION.SDK_INT >= 33) {
            i = new Intent(MediaStore.ACTION_PICK_IMAGES);   // 免存储权限的照片选择器
            i.setType("image/*");
        } else {
            i = new Intent(Intent.ACTION_GET_CONTENT);
            i.setType("image/*");
            i.addCategory(Intent.CATEGORY_OPENABLE);
        }
        try {
            startActivityForResult(i, REQ_PICK);
        } catch (Exception e) {
            toast("打不开相册");
            Log.w(TAG, "启动相册失败: " + e.getMessage());
        }
    }

    // ══════════════════════════════════════════════════════════════
    // ⭐⭐ 2026-09-30 op：**定位（第一阶段，不依赖地图 key）**
    //   主人原话：「给 ds酱 加一个 gps 功能…能应用网上地图，还有导航功能，
    //    但是 app 的位置请求得有，这样我就能问你，最近的味千在哪里」
    //   · 用 **LocationManager**（GPS_PROVIDER / NETWORK_PROVIDER）——
    //     ⛔ 不用 FusedLocationProvider（要 Google Play 服务，国内手机没有）。
    //   · **按需定位**：只有前端打开「位置」页点「定位」才请求，拿到就停，不常驻耗电。
    //   · ⚠️ 坐标系：Android 给的是 **WGS84**；高德/百度要 **GCJ02** ⇒ 这里一并算好
    //     gcjLat/gcjLng 一起上报（原始 WGS84 也保留）。
    //   · ⚠️ 隐私：坐标只 POST 到 hub，hub 端**只在内存**留最近一次，不落盘。
    // ══════════════════════════════════════════════════════════════

    /** 前端点了「定位」→ 先看权限，没给就动态申请（Android 6+ 必须） */
    void requestLocation() {
        if (Build.VERSION.SDK_INT >= 23) {
            boolean fine = checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED;
            boolean coarse = checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED;
            if (!fine && !coarse) {
                requestPermissions(new String[]{
                        android.Manifest.permission.ACCESS_FINE_LOCATION,
                        android.Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOC);
                return;
            }
        }
        startLocating();
    }

    void startLocating() {
        try {
            locMgr = (LocationManager) getSystemService(LOCATION_SERVICE);
            if (locMgr == null) { locCallbackError("这台手机没有定位服务"); return; }
            locListener = new LocListener(this);
            // ① 先给"最后已知位置"（秒出，可能偏）—— 让页面立刻有东西显示
            Location last = null;
            try { last = locMgr.getLastKnownLocation(LocationManager.NETWORK_PROVIDER); } catch (Exception e) {}
            try {
                Location g = locMgr.getLastKnownLocation(LocationManager.GPS_PROVIDER);
                if (g != null && (last == null || g.getTime() > last.getTime())) last = g;
            } catch (Exception e) {}
            if (last != null) onLocFix(last);
            // ② 再订实时更新（更准）—— 拿够就 stopLocating
            boolean any = false;
            try {
                if (locMgr.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                    locMgr.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 1000L, 0f,
                            locListener, Looper.getMainLooper());
                    any = true;
                }
            } catch (Exception e) {}
            try {
                if (locMgr.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                    locMgr.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f,
                            locListener, Looper.getMainLooper());
                    any = true;
                }
            } catch (Exception e) {}
            if (!any) { locCallbackError("手机的定位开关没打开"); return; }
            // ③ 兜底：20 秒后无论如何收工（不许一直挂着耗电）
            locTimeout = new LocTimeoutRunner(this);
            locHandler.postDelayed(locTimeout, 20000);
        } catch (Exception e) {
            locCallbackError("定位失败：" + e.getMessage());
        }
    }

    /** 拿到/停止更新 —— 幂等 */
    void stopLocating() {
        try { if (locMgr != null && locListener != null) locMgr.removeUpdates(locListener); } catch (Exception e) {}
        if (locTimeout != null) {
            try { locHandler.removeCallbacks(locTimeout); } catch (Exception e) {}
            locTimeout = null;
        }
    }

    /** 收到一个定位点 */
    void onLocFix(Location loc) {
        if (loc == null) return;
        // GPS 定位到、或精度够（≤30m）⇒ 收工，不再耗电
        boolean good = LocationManager.GPS_PROVIDER.equals(loc.getProvider())
                || (loc.hasAccuracy() && loc.getAccuracy() <= 30f);
        if (good) stopLocating();
        JSONObject o = locJson(loc);
        if (o == null) return;
        // 回传页面（本回调在 UI 线程 ⇒ evaluateJavascript 合法）
        try {
            if (web != null) {
                web.evaluateJavascript(
                        "(function(){try{window.DsLoc&&window.DsLoc.onResult(" + o.toString() + ");}catch(e){}})();",
                        null);
            }
        } catch (Exception e) {}
        // 上报 hub（后台线程）
        new Thread(new LocPostRunner(this, o)).start();
        Log.i(TAG, "定位 " + loc.getProvider() + " " + loc.getLatitude() + "," + loc.getLongitude()
                + " ±" + (loc.hasAccuracy() ? loc.getAccuracy() : -1));
    }

    /** Location → JSON（WGS84 原始 + GCJ02 转换值） */
    JSONObject locJson(Location loc) {
        try {
            double wlat = loc.getLatitude(), wlng = loc.getLongitude();
            double[] gcj = wgs84ToGcj02(wlat, wlng);
            JSONObject o = new JSONObject();
            o.put("lat", wlat);
            o.put("lng", wlng);
            o.put("acc", loc.hasAccuracy() ? loc.getAccuracy() : -1);
            o.put("provider", String.valueOf(loc.getProvider()));
            o.put("ts", loc.getTime());
            o.put("src", "phone");
            o.put("gcjLat", gcj[0]);
            o.put("gcjLng", gcj[1]);
            return o;
        } catch (Exception e) {
            return null;
        }
    }

    void postLocation(JSONObject o) {
        try {
            byte[] body = o.toString().getBytes("UTF-8");
            HttpURLConnection c = (HttpURLConnection) new URL(HUB + "/api/loc").openConnection();
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setConnectTimeout(15000);
            c.setReadTimeout(15000);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            c.setRequestProperty("X-Auth", AUTH);
            c.setFixedLengthStreamingMode(body.length);
            OutputStream os = c.getOutputStream();
            os.write(body);
            os.flush();
            os.close();
            int code = c.getResponseCode();
            Log.i(TAG, "loc 上报 " + code);
        } catch (Exception e) {
            Log.w(TAG, "loc 上报失败: " + e.getMessage());
        }
    }

    /** 定位失败 ⇒ 页面 toast + 回调 */
    void locCallbackError(String msg) {
        Log.w(TAG, "定位: " + msg);
        try { runOnUiThread(new ToastRunnable(this, msg)); } catch (Exception e) {}
        try {
            String m = msg.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ");
            if (web != null) {
                web.evaluateJavascript(
                        "(function(){try{window.DsLoc&&window.DsLoc.onError('" + m + "');}catch(e){}})();", null);
            }
        } catch (Exception e) {}
    }

    /** ⭐ 用地图打开（通用 geo:，不用 key）—— 坐标用 GCJ02（国内地图 App 认 GCJ02） */
    void startGeo(String lat, String lng, String name) {
        String nm = name == null ? "" : name;
        String q = lat + "," + lng + (nm.length() > 0 ? "(" + Uri.encode(nm) + ")" : "");
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("geo:" + lat + "," + lng + "?q=" + q)));
        } catch (Exception e) {
            try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("geo:" + lat + "," + lng))); }
            catch (Exception e2) { toast("没找到地图应用"); }
        }
    }

    /** ⭐ 导航到…（高德 → 百度 → geo 兜底，不用 key）。
     *  · 有地名：按名字让地图 App 自己搜（amap 的 dname / baidu 的 destination 支持中文地名）
     *  · 有坐标：直接给终点坐标（amap dlat/dlon、baidu destination=latlng:…）
     *  ⚠️ 坐标一律按 **GCJ02** 传（coord_type=gcj02）。 */
    void startNav(String name, String lat, String lng) {
        String nm = name == null ? "" : name.trim();
        boolean hasName = nm.length() > 0;
        boolean hasPos = lat != null && lng != null && lat.length() > 0 && lng.length() > 0;
        // 1) 高德
        try {
            StringBuilder sb = new StringBuilder("androidamap://route/plan/?sourceApplication=dsjiang&dev=0&t=0");
            if (hasPos) sb.append("&dlat=").append(lat).append("&dlon=").append(lng);
            if (hasName) sb.append("&dname=").append(Uri.encode(nm));
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(sb.toString())));
            return;
        } catch (Exception e) {}
        // 2) 百度
        try {
            String dest = hasPos ? ("latlng:" + lat + "," + lng + "|" + (hasName ? nm : "终点")) : nm;
            String url = "baidumap://map/direction?coord_type=gcj02&mode=driving&destination="
                    + Uri.encode(dest);
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            return;
        } catch (Exception e) {}
        // 3) 兜底
        if (hasPos) { startGeo(lat, lng, nm); return; }
        toast("没找到地图应用");
    }

    // ---- WGS84 → GCJ02（国测局加密坐标）标准算法 ----
    static final double GEO_PI = 3.1415926535897932384626;
    static final double GEO_A = 6378245.0;
    static final double GEO_EE = 0.00669342162296594323;

    static boolean outOfChina(double lat, double lng) {
        return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
    }
    static double transformLat(double x, double y) {
        double ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
        ret += (20.0 * Math.sin(6.0 * x * GEO_PI) + 20.0 * Math.sin(2.0 * x * GEO_PI)) * 2.0 / 3.0;
        ret += (20.0 * Math.sin(y * GEO_PI) + 40.0 * Math.sin(y / 3.0 * GEO_PI)) * 2.0 / 3.0;
        ret += (160.0 * Math.sin(y / 12.0 * GEO_PI) + 320 * Math.sin(y * GEO_PI / 30.0)) * 2.0 / 3.0;
        return ret;
    }
    static double transformLng(double x, double y) {
        double ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
        ret += (20.0 * Math.sin(6.0 * x * GEO_PI) + 20.0 * Math.sin(2.0 * x * GEO_PI)) * 2.0 / 3.0;
        ret += (20.0 * Math.sin(x * GEO_PI) + 40.0 * Math.sin(x / 3.0 * GEO_PI)) * 2.0 / 3.0;
        ret += (150.0 * Math.sin(x / 12.0 * GEO_PI) + 300.0 * Math.sin(x / 30.0 * GEO_PI)) * 2.0 / 3.0;
        return ret;
    }
    static double[] wgs84ToGcj02(double lat, double lng) {
        if (outOfChina(lat, lng)) return new double[]{lat, lng};
        double dLat = transformLat(lng - 105.0, lat - 35.0);
        double dLng = transformLng(lng - 105.0, lat - 35.0);
        double radLat = lat / 180.0 * GEO_PI;
        double magic = Math.sin(radLat);
        magic = 1 - GEO_EE * magic * magic;
        double sqrtMagic = Math.sqrt(magic);
        dLat = (dLat * 180.0) / ((GEO_A * (1 - GEO_EE)) / (magic * sqrtMagic) * GEO_PI);
        dLng = (dLng * 180.0) / (GEO_A / sqrtMagic * Math.cos(radLat) * GEO_PI);
        return new double[]{lat + dLat, lng + dLng};
    }

    /** <input type=file> 的文件选择器（不实现这个，WebView 里的 file input 没反应） */
    boolean openFileChooser(ValueCallback<Uri[]> cb, WebChromeClient.FileChooserParams params) {
        if (fileCb != null) {
            try { fileCb.onReceiveValue(null); } catch (Exception e) {}
        }
        fileCb = cb;
        try {
            startActivityForResult(params.createIntent(), REQ_FILE);
            return true;
        } catch (Exception e) {
            fileCb = null;
            toast("打不开文件选择器");
            return false;
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);

        if (req == REQ_FILE) {
            Uri[] out = null;
            if (res == RESULT_OK && data != null) {
                if (data.getData() != null) {
                    out = new Uri[]{ data.getData() };
                } else if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    out = new Uri[n];
                    for (int i = 0; i < n; i++) {
                        out[i] = data.getClipData().getItemAt(i).getUri();
                    }
                }
            }
            if (fileCb != null) {
                try { fileCb.onReceiveValue(out); } catch (Exception e) {}
                fileCb = null;
            }
            return;
        }

        if (req == REQ_CAM) {
            if (res != RESULT_OK) {
                if (camUri != null) {   // 取消拍照 ⇒ 把 MediaStore 里那行空记录删掉，别在相册留坏图
                    try { getContentResolver().delete(camUri, null, null); } catch (Exception e) {}
                    camUri = null;
                }
                toast("取消了");
                return;
            }
            if (camUri != null) {
                Uri u = camUri;
                camUri = null;
                new Thread(new ImageRunner(this, u, null, "📷 拍照")).start();
            } else if (data != null && data.getExtras() != null) {
                Object o = data.getExtras().get("data");
                if (o instanceof Bitmap) {
                    new Thread(new ImageRunner(this, null, (Bitmap) o, "📷 拍照")).start();
                } else {
                    toast("相机没给图");
                }
            } else {
                toast("相机没给图");
            }
            return;
        }

        if (req == REQ_PICK) {
            if (res != RESULT_OK || data == null || data.getData() == null) {
                toast("取消了");
                return;
            }
            new Thread(new ImageRunner(this, data.getData(), null, "🖼 相册")).start();
        }
    }

    // ---------- 读图 / 上传 ----------

    void handleImage(Uri uri, String label) {
        try {
            InputStream in = getContentResolver().openInputStream(uri);
            if (in == null) { toast("读不到图"); return; }
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            in.close();
            String mime = getContentResolver().getType(uri);
            if (mime == null || !mime.startsWith("image/")) mime = "image/jpeg";
            String ext = mime.indexOf("png") >= 0 ? ".png"
                    : (mime.indexOf("webp") >= 0 ? ".webp" : ".jpg");
            sendToHub(bo.toByteArray(), "ds_" + System.currentTimeMillis() + ext, mime, label);
        } catch (Exception e) {
            toast("读取失败：" + e.getMessage());
            Log.w(TAG, "读图失败: " + e.getMessage());
        }
    }

    void handleThumb(Bitmap bm, String label) {
        try {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            bm.compress(Bitmap.CompressFormat.JPEG, 92, bo);
            sendToHub(bo.toByteArray(), "ds_" + System.currentTimeMillis() + ".jpg",
                    "image/jpeg", label);
        } catch (Exception e) {
            toast("压缩失败：" + e.getMessage());
        }
    }

    void sendToHub(byte[] data, String fname, String mime, String label) {
        try {
            String url = uploadBytes(data, fname, mime);
            if (url == null) { toast("上传失败"); return; }
            pushImage(url, label);
            toast("已发给你：" + label);
            Log.i(TAG, "已发图 " + url + " (" + data.length + " B)");
        } catch (Exception e) {
            toast("发送失败：" + e.getMessage());
            Log.w(TAG, "发送失败: " + e.getMessage());
        }
    }

    /** 手写 multipart（和 hub-server.js 的 /api/upload 解析方式一致：单文件） */
    String uploadBytes(byte[] data, String fname, String mime) throws Exception {
        String bnd = "----dsjiang" + System.currentTimeMillis();
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        bo.write(("--" + bnd + "\r\n").getBytes("UTF-8"));
        bo.write(("Content-Disposition: form-data; name=\"file\"; filename=\""
                + fname + "\"\r\n").getBytes("UTF-8"));
        bo.write(("Content-Type: " + mime + "\r\n\r\n").getBytes("UTF-8"));
        bo.write(data);
        bo.write(("\r\n--" + bnd + "--\r\n").getBytes("UTF-8"));
        byte[] body = bo.toByteArray();

        HttpURLConnection c = (HttpURLConnection) new URL(HUB + "/api/upload").openConnection();
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setConnectTimeout(15000);
        c.setReadTimeout(90000);
        c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + bnd);
        c.setRequestProperty("X-Auth", AUTH);   // 2026-09-22 口令鉴权
        c.setFixedLengthStreamingMode(body.length);
        OutputStream os = c.getOutputStream();
        os.write(body);
        os.flush();
        os.close();

        int code = c.getResponseCode();
        String resp = readAll(code >= 200 && code < 300 ? c.getInputStream() : c.getErrorStream());
        Log.i(TAG, "upload " + code + " " + resp);
        if (code != 200) return null;
        JSONObject o = new JSONObject(resp);
        if (!o.optBoolean("ok")) return null;
        String u = o.optString("url", null);
        return (u == null || u.length() == 0) ? null : u;
    }

    void pushImage(String url, String label) throws Exception {
        JSONObject o = new JSONObject();
        o.put("text", label);
        o.put("image", url);
        o.put("kind", "chat");
        byte[] body = o.toString().getBytes("UTF-8");

        HttpURLConnection c = (HttpURLConnection) new URL(HUB + "/api/push").openConnection();
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        c.setRequestProperty("X-Auth", AUTH);   // 2026-09-22 口令鉴权
        c.setFixedLengthStreamingMode(body.length);
        OutputStream os = c.getOutputStream();
        os.write(body);
        os.flush();
        os.close();

        int code = c.getResponseCode();
        String resp = readAll(code >= 200 && code < 300 ? c.getInputStream() : c.getErrorStream());
        Log.i(TAG, "push " + code + " " + resp);
        if (code != 200) throw new Exception("push HTTP " + code);
    }

    static String readAll(InputStream in) {
        if (in == null) return "";
        try {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            in.close();
            return bo.toString("UTF-8");
        } catch (Exception e) {
            return "";
        }
    }

    // ══════════════════════════════════════════════════════════════
    // ★ 2026-10-05 开源版：**首次配置页 + 运行期地址**
    //   · 启动时没有配置 ⇒ 直接显示配置页；有配置 ⇒ 进 WebView
    //   · 输入整条地址（形如 http://192.168.1.100:3099/?t=xxxx）⇒ 自动拆成
    //     HUB（协议+主机+端口）与 AUTH（?t= 口令）
    //   · 重新配置入口（三个，都不容易误触）：
    //       ① 页面里调 JS 桥 window.DsNative.reconfigure()
    //       ② 老设备的菜单键（KEYCODE_MENU）
    //       ③ 主页加载失败时右上角浮出的「⚙ 配置」（地址变了/服务没开时最有用）
    // ══════════════════════════════════════════════════════════════

    /** 读服务地址（静态方法，供 NotifyService / WebActivity 用；没配返回空串） */
    static String hubOf(Context c) {
        try {
            return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(K_HUB, "");
        } catch (Exception e) {
            return "";
        }
    }

    /** 读口令（没配返回空串 ⇒ 服务端没开口令时照常可用） */
    static String authOf(Context c) {
        try {
            return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(K_AUTH, "");
        } catch (Exception e) {
            return "";
        }
    }

    /** 把 SharedPreferences 里的配置载入静态字段 */
    void loadConfig() {
        HUB = hubOf(this);
        AUTH = authOf(this);
        HOME = HUB.isEmpty() ? "" : HUB + "/";
    }

    /** dp → px（配置页纯代码布局用） */
    int dp(float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
                getResources().getDisplayMetrics());
    }

    /**
     * 解析用户粘贴的「完整地址」⇒ String[]{HUB, AUTH}；格式不对返回 null。
     * 容错：
     *   · 没带 ?t=            ⇒ AUTH 留空（服务端可能没开口令）
     *   · 带 #锚点 / 其它参数 ⇒ 只取 t
     *   · 末尾多余的 /        ⇒ 规范化（HUB 不带尾斜杠，HOME 统一拼）
     *   · 没写协议头          ⇒ 自动补 http://
     */
    static String[] parseConfig(String raw) {
        if (raw == null) return null;
        String s = raw.trim().replace("\n", "").replace("\r", "").replace(" ", "");
        if (s.isEmpty()) return null;
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://" + s;
        Uri u = Uri.parse(s);
        String scheme = u.getScheme();
        String host = u.getHost();
        if (host == null || host.isEmpty()) return null;
        if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
        int port = u.getPort();
        String hub = scheme + "://" + host + (port > 0 ? ":" + port : "");
        String auth = u.getQueryParameter("t");
        if (auth == null) auth = "";
        return new String[]{hub, auth};
    }

    /** 构造配置页视图（纯代码，不动 res/）—— 配色跟开源版网页登录页一套 */
    View buildConfigView() {
        final int BG = 0xff14130f;
        final int CARD = 0xff201f1a;
        final int LINE = 0xff3a382f;
        final int TXT = 0xffeeeeee;
        final int MUTED = 0xff9a9a9a;
        final int ACCENT = 0xffffc98a;
        final int ACCENT_TXT = 0xff2a2419;

        ScrollView sc = new ScrollView(this);
        sc.setBackgroundColor(BG);
        sc.setFillViewport(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(24);
        root.setPadding(pad, dp(48), pad, pad);
        sc.addView(root, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView title = new TextView(this);
        title.setText("dsj-open");
        title.setTextColor(TXT);
        title.setTextSize(26);
        title.setGravity(Gravity.CENTER);
        root.addView(title, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView sub = new TextView(this);
        sub.setText("第一次使用，请填电脑地址");
        sub.setTextColor(MUTED);
        sub.setTextSize(14);
        sub.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        slp.topMargin = dp(8);
        root.addView(sub, slp);

        GradientDrawable inputBg = new GradientDrawable();
        inputBg.setColor(CARD);
        inputBg.setCornerRadius(dp(10));
        inputBg.setStroke(dp(1), LINE);

        cfgUrl = new EditText(this);
        cfgUrl.setHint("粘贴完整地址");
        cfgUrl.setHintTextColor(0xff6b675c);
        cfgUrl.setTextColor(TXT);
        cfgUrl.setTextSize(15);
        cfgUrl.setSingleLine(true);
        cfgUrl.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        cfgUrl.setBackground(inputBg);
        cfgUrl.setPadding(dp(14), dp(13), dp(14), dp(13));
        LinearLayout.LayoutParams ulp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ulp.topMargin = dp(28);
        root.addView(cfgUrl, ulp);

        TextView eg = new TextView(this);
        eg.setText("形如 http://192.168.1.100:3099/?t=xxxxx");
        eg.setTextColor(0xff6b675c);
        eg.setTextSize(12);
        eg.setPadding(dp(4), dp(6), dp(4), 0);
        root.addView(eg, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView tip = new TextView(this);
        tip.setText("在电脑上启动服务后：口令看启动日志（或项目根目录 .hub-token），"
                + "电脑 IP 用 ipconfig 查（局域网 192.168.x.x）；"
                + "在外面用就填 Tailscale 的 100.x.x.x。\n"
                + "把这两样拼成上面那种地址，整条复制粘贴过来即可。");
        tip.setTextColor(MUTED);
        tip.setTextSize(13);
        tip.setLineSpacing(dp(4), 1f);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tlp.topMargin = dp(14);
        root.addView(tip, tlp);

        TextView btn = new TextView(this);
        btn.setText("连  接");
        btn.setTextColor(ACCENT_TXT);
        btn.setTextSize(16);
        btn.setGravity(Gravity.CENTER);
        GradientDrawable btnBg = new GradientDrawable();
        btnBg.setColor(ACCENT);
        btnBg.setCornerRadius(dp(10));
        btn.setBackground(btnBg);
        btn.setOnClickListener(new ConnectClick(this));
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(46));
        blp.topMargin = dp(26);
        root.addView(btn, blp);

        return sc;
    }

    /** 显示配置页（可重复进入；会销毁旧 WebView） */
    void showConfig() {
        if (web != null) {
            try { web.destroy(); } catch (Exception e) {}
            web = null;
        }
        cfgPill = null;
        setContentView(buildConfigView());
        // 预填当前配置（重新配置时不用重打）
        if (HUB != null && HUB.length() > 0 && cfgUrl != null) {
            String cur = (AUTH != null && AUTH.length() > 0)
                    ? HUB + "/?t=" + AUTH
                    : HUB + "/";
            cfgUrl.setText(cur);
            cfgUrl.setSelection(cur.length());
        }
    }

    /** 配置页点「连接」：解析 → 存盘 → 重启通知服务 → 进主页 */
    void submitConfig() {
        String raw = cfgUrl == null ? "" : cfgUrl.getText().toString();
        String[] cfg = parseConfig(raw);
        if (cfg == null) {
            toast("地址格式不对，示例：http://192.168.1.100:3099/?t=xxxx");
            return;
        }
        String host = Uri.parse(cfg[0]).getHost();
        if ("127.0.0.1".equals(host) || "localhost".equalsIgnoreCase(host)
                || "::1".equals(host)) {
            toast("127.0.0.1 是电脑自己，手机连不上——请填电脑的局域网 IP（192.168.x.x）或 Tailscale IP（100.x.x.x）");
            return;
        }
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString(K_HUB, cfg[0])
                .putString(K_AUTH, cfg[1])
                .apply();
        loadConfig();
        // 通知服务可能还挂在旧地址上 ⇒ 重启一次（它启动后会读新配置）
        try { stopService(new Intent(this, NotifyService.class)); } catch (Exception e) {}
        startNotifyService();
        toast("已连接：" + HUB);
        startMain();
    }

    /** 启动常驻通知服务（Android 12+ 前台服务必须先由前台界面拉起） */
    void startNotifyService() {
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                startForegroundService(new Intent(this, NotifyService.class));
            } else {
                startService(new Intent(this, NotifyService.class));
            }
        } catch (Exception e) {
            Log.w(TAG, "通知服务启动失败: " + e.getMessage());
        }
    }

    /** 按当前配置打开主界面（WebView + 右上角「⚙ 配置」兜底） */
    void startMain() {
        if (HUB == null || HUB.isEmpty()) { showConfig(); return; }
        if (web != null) {
            try { web.destroy(); } catch (Exception e) {}
            web = null;
        }
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0d0d0d"));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        web.setWebViewClient(new HubWebViewClient(this));
        web.setWebChromeClient(new HubChromeClient(this));
        // ★ 2026-09-17：网页里的「📷 拍照 / 🖼 相册」按钮靠这个桥进来
        web.addJavascriptInterface(new DsNative(this), "DsNative");

        FrameLayout wrap = new FrameLayout(this);
        wrap.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // ⚙ 兜底：主页打不开（地址变了 / 服务没开）时右上角浮出来，点它改地址
        cfgPill = new TextView(this);
        cfgPill.setText("⚙ 配置");
        cfgPill.setTextColor(0xffeeeeee);
        cfgPill.setTextSize(12.5f);
        GradientDrawable pillBg = new GradientDrawable();
        pillBg.setColor(0xcc201f1a);
        pillBg.setCornerRadius(dp(14));
        pillBg.setStroke(dp(1), 0xff3a382f);
        cfgPill.setBackground(pillBg);
        cfgPill.setPadding(dp(12), dp(7), dp(12), dp(7));
        cfgPill.setOnClickListener(new ConfigClick(this));
        cfgPill.setVisibility(View.GONE);
        FrameLayout.LayoutParams plp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP | Gravity.END);
        plp.topMargin = dp(40);    // 让开状态栏（全屏铺满，内容压在状态栏下）
        plp.rightMargin = dp(12);
        wrap.addView(cfgPill, plp);

        setContentView(wrap);
        loadStartedAt = System.currentTimeMillis();
        lastErrorAt = 0;
        web.loadUrl(startUrl());

        // ⭐ 2026-09-23 op：后台预热「网页浮层」的 WebView（让第一次点也快）
        //   延后 800ms 执行（不抢启动主线程）；建好不销毁，浮层开时领养。
        WebActivity.preheat(getApplicationContext());
    }

    /** 首次进站地址：带口令 ⇒ /?t=xxx（服务端会种 180 天 Cookie），没口令 ⇒ 直接 / */
    String startUrl() {
        if (HUB == null || HUB.isEmpty()) return "about:blank";
        if (AUTH == null || AUTH.isEmpty()) return HOME;
        return HUB + "/?t=" + Uri.encode(AUTH);
    }

    /** 主页面加载失败 ⇒ 右上角浮出「⚙ 配置」 */
    void onLoadError() {
        lastErrorAt = System.currentTimeMillis();
        if (cfgPill != null) cfgPill.setVisibility(View.VISIBLE);
    }

    /** 页面加载完成：本次加载没出错才收起「⚙ 配置」 */
    void onPageDone() {
        if (cfgPill != null && lastErrorAt < loadStartedAt) cfgPill.setVisibility(View.GONE);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // ⭐ 2026-09-22 op：铺满整屏（内容压在状态栏下面）—— 见 setupEdgeToEdge 注释
        setupEdgeToEdge();

        // ⭐⭐ 2026-09-17：必须先【请求】通知权限，系统才会弹「dsj-open 想给你发送通知」。
        //   不请求 → 系统通知开关是空的，主人想开都没得开。
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(
                    new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
            }
        }

        // ⭐ 2026-10-05（阶段7 op）：**接收电脑推来的文件** —— Android 9 及以下要写外部存储，
        //   必须在这里申请（29+ 走 MediaStore，分区存储天然免权限）。
        if (Build.VERSION.SDK_INT < 29
                && checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(
                new String[]{android.Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORE);
        }

        // ★ 2026-10-05 开源版：先读运行期配置；没配过 ⇒ 进配置页，配好再走正常流程
        loadConfig();
        if (HUB.isEmpty()) {
            showConfig();
            return;
        }
        // ⭐ 前台时启动常驻 NotifyService（Android 12+ 只能在【前台】启动前台服务）
        startNotifyService();
        startMain();   // 里面会顺带预热「网页浮层」的 WebView
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // ★ 2026-10-05：老设备上的菜单键 = 重新配置入口（没有实体键的机器不影响）
        if (keyCode == KeyEvent.KEYCODE_MENU) {
            showConfig();
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                           int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_NOTIFY) {
            boolean granted = grantResults != null && grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            Log.i("DsMain", "通知权限请求结果: granted=" + granted);
        }
        // ⭐ 2026-10-05（阶段7）：存储权限结果（仅 API<29 用；拒绝时接收文件会失败并在通知里说明）
        if (requestCode == REQ_STORE) {
            boolean granted = grantResults != null && grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            Log.i(TAG, "存储权限请求结果: granted=" + granted);
        }
        // ⭐ 2026-09-30：定位权限结果 —— 给了就继续定位，拒了就回页面提示
        if (requestCode == REQ_LOC) {
            boolean granted = false;
            if (grantResults != null) {
                for (int g : grantResults) {
                    if (g == PackageManager.PERMISSION_GRANTED) { granted = true; break; }
                }
            }
            Log.i(TAG, "定位权限请求结果: granted=" + granted);
            if (granted) startLocating();
            else locCallbackError("定位权限被拒绝了（可在系统设置里开）");
        }
    }

    @Override
    protected void onDestroy() {
        stopLocating();   // ⭐ 2026-09-30：别留定位监听泄漏
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
