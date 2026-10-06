package io.github.hanzhengdev.phoneaccess;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 文件接收器 —— 2026-10-05（APK 阶段 7 op）
 *
 * 主人原话：「把 tail 和 adb 脚本也融合进去，这样，一个单独的 apk 就好不知道多少」
 * ⇒ 让 App 自己干"原来靠电脑端 adb 推文件"的活：
 *
 *   电脑 POST /api/push { text, file:{path,name,size} }
 *     ↓ App 的 SSE（NotifyService）收到带 file 的消息
 *     ↓ 本类排队下载  GET /api/file?path=…&raw=1（带 X-Auth）
 *     ↓ 按类型保存：
 *         图片/视频（jpg/png/gif/webp/mp4/mov…）→ 相册（DCIM/dsh-access-phone-remote）
 *         其他（pdf/docx/zip…）                → 下载（Download/dsh-access-phone-remote）
 *     ↓ 完成/失败都弹通知（失败必带原因 —— PITFALLS P66:别静默吞）
 *
 * 两条保存路（按系统版本）：
 *   · API 29+：MediaStore（分区存储，**不需要任何存储权限**）
 *   · API 24-28：传统路径 + WRITE_EXTERNAL_STORAGE 运行时权限（MainActivity 里申请）
 *
 * 打开：
 *   · 29+ 用 MediaStore 返回的 content:// URI
 *   · 24-28 用 FileProviderMini 的 content:// URI（绝不 file://，targetSdk 33 会崩）
 *
 * ⚠️ 本工程禁止匿名内部类（d8 在 JDK24 上会崩，见 PITFALLS P24）。
 *    本文件所有异步体一律具名静态类。
 */
public class FileReceiver {

    private static final String TAG = "DsFile";

    // 附件类型（决定存哪 + 相册还是下载）
    static final int KIND_IMAGE = 1;
    static final int KIND_VIDEO = 2;
    static final int KIND_OTHER = 3;

    private static final String OPEN_DIR = "dsh-access-phone-remote";
    private static final long MAX_BYTES = 100L * 1024 * 1024;   // 保险丝（服务端本身 ≤50MB）
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 60000;
    // 通知 id 区：NotifyService 用 1000~1000999（消息）⇒ 文件通知从 5000000 起，绝不相撞
    private static final int NOTI_BASE = 5000000;

    /** 接收队列（单线程顺序收，避免并发写乱；守护线程，服务死了就跟着完） */
    private static final ExecutorService EXEC =
            Executors.newSingleThreadExecutor(new RecvThreadFactory());
    /** 已收消息 id（同一条消息重复到达——重连补拉时——只收一次） */
    private static final Set<Long> SEEN = Collections.synchronizedSet(new HashSet<Long>());
    private static final AtomicInteger NOTI_SEQ = new AtomicInteger(0);

    /** 接收线程工厂（具名类） */
    static class RecvThreadFactory implements ThreadFactory {
        public Thread newThread(Runnable r) {
            Thread t = new Thread(r, "dsj-filerecv");
            t.setDaemon(true);
            return t;
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  入口（由 NotifyService 在 SSE 线程调用）
    // ════════════════════════════════════════════════════════════════
    /**
     * 消息带 `file` 字段 ⇒ 排队接收。幂等：同一条消息（同 id）只收一次。
     * ⚠️ 这里只入队，不做网络 IO —— 绝不能阻塞 SSE 循环。
     */
    static void maybeReceive(Context ctx, JSONObject msg) {
        try {
            if (msg == null || ctx == null) return;
            JSONObject f = msg.optJSONObject("file");
            if (f == null) return;
            String path = f.optString("path", "");
            if (path.isEmpty()) return;
            long id = msg.optLong("id", -1);
            if (id >= 0 && !markSeen(id)) return;   // 收过了
            String name = sanitizeName(f.optString("name", ""));
            long size = f.optLong("size", -1);
            Context app = ctx.getApplicationContext();
            if (app == null) app = ctx;
            EXEC.execute(new DownloadTask(app, id, path, name, size));
        } catch (Exception e) {
            Log.w(TAG, "附件入队失败: " + e.getMessage());
        }
    }

    /** 标记"这条消息收过了"；true=没收过（放行） */
    private static boolean markSeen(long id) {
        synchronized (SEEN) {
            Long key = Long.valueOf(id);
            if (SEEN.contains(key)) return false;
            if (SEEN.size() > 500) SEEN.clear();   // 防无限涨（清空后极端情况可能重收，可接受）
            SEEN.add(key);
            return true;
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  下载任务
    // ════════════════════════════════════════════════════════════════
    /** 单个附件的 下载 → 保存 → 通知（在单线程队列里顺序执行） */
    static class DownloadTask implements Runnable {
        private final Context ctx;
        private final long msgId;
        private final String path;
        private final String name;
        private final long sizeHint;

        DownloadTask(Context c, long id, String p, String n, long s) {
            ctx = c; msgId = id; path = p; name = n; sizeHint = s;
        }

        public void run() {
            int notiId = NOTI_BASE + NOTI_SEQ.incrementAndGet();
            long t0 = System.currentTimeMillis();
            String base = MainActivity.hubOf(ctx);
            String sizeTxt = sizeHint > 0 ? "（" + humanSize(sizeHint) + "）" : "";
            Log.i(TAG, "接收附件 id=" + msgId + " " + name + sizeTxt + " path=" + path);
            if (base.isEmpty()) {
                notifyFail(ctx, notiId, name, "App 还没配置服务地址（打开 App 填地址）");
                return;
            }
            // 先亮一条"正在接收"（下载很快时会被下面原地更新成"已保存"）
            try {
                postNotification(ctx, notiId, "正在接收：" + name + sizeTxt, null, true, false);
            } catch (Exception e) {
                // 通知发不出去不能挡下载（Android 13+ 万一通知权限被关）
                Log.w(TAG, "接收中通知失败: " + e.getMessage());
            }

            HttpURLConnection c = null;
            InputStream in = null;
            try {
                String url = base + "/api/file?path=" + URLEncoder.encode(path, "UTF-8") + "&raw=1";
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(CONNECT_TIMEOUT_MS);
                c.setReadTimeout(READ_TIMEOUT_MS);
                c.setRequestProperty("Accept", "application/octet-stream");
                c.setRequestProperty("X-Auth", MainActivity.authOf(ctx));   // 原生请求没有 WebView cookie

                int code = c.getResponseCode();
                if (code != 200) {
                    throw new IOException("服务端拒绝（HTTP " + code + "）" + serverError(c));
                }
                // ⭐ 防"老版服务端"：没有 raw 模式时会返回 JSON（不是文件）⇒ 绝不能把 JSON 存成文件。
                //   新服务端的 raw 响应必带 Content-Disposition（file.js raw 分支）。
                String cd = c.getHeaderField("Content-Disposition");
                if (cd == null || cd.isEmpty()) {
                    throw new IOException("服务端不支持文件下载（请把电脑端升级到最新版）");
                }
                long len = c.getContentLength();
                if (len > MAX_BYTES) throw new IOException("文件太大（" + humanSize(len) + "）");
                in = new BufferedInputStream(c.getInputStream(), 32 * 1024);

                String mime = mimeOf(name);
                int kind = kindOf(name);
                Saved saved;
                if (Build.VERSION.SDK_INT >= 29) {
                    saved = Store29.save(ctx, in, name, mime, kind);
                } else {
                    saved = saveLegacy(ctx, in, name, mime, kind);
                }
                Log.i(TAG, "已保存 " + saved.displayName + " → " + saved.uri
                        + "（" + (System.currentTimeMillis() - t0) + "ms）");
                notifyDone(ctx, notiId, saved);
            } catch (Exception e) {
                String reason = msgOf(e);
                Log.w(TAG, "接收失败 " + name + ": " + reason);
                notifyFail(ctx, notiId, name, reason);
            } finally {
                if (in != null) { try { in.close(); } catch (IOException ignore) {} }
                if (c != null) c.disconnect();
            }
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  保存 · API 29+（MediaStore，不需要存储权限）
    // ════════════════════════════════════════════════════════════════
    /**
     * ⚠️ 整块隔离在独立具名类：里面引用的 MediaStore.Downloads / RELATIVE_PATH /
     * IS_PENDING 都是 API 29 才有的符号。调用点被 `Build.VERSION.SDK_INT >= 29`
     * 包着，ART 到执行时才加载本类 ⇒ 低版本设备不会碰它。
     */
    static class Store29 {
        static Saved save(Context ctx, InputStream in, String name, String mime, int kind) throws Exception {
            ContentResolver cr = ctx.getContentResolver();
            boolean isMedia = (kind == KIND_IMAGE || kind == KIND_VIDEO);
            Uri collection;
            if (kind == KIND_IMAGE) {
                collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
            } else if (kind == KIND_VIDEO) {
                collection = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
            } else {
                collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
            }
            String rel = (isMedia ? Environment.DIRECTORY_DCIM : Environment.DIRECTORY_DOWNLOADS)
                    + "/" + OPEN_DIR;

            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, rel);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);   // 写完再置 0，防相册读到半截

            Uri uri = cr.insert(collection, v);
            if (uri == null) throw new IOException("系统媒体库拒收（insert 返回 null）");
            try {
                OutputStream os = cr.openOutputStream(uri);
                if (os == null) throw new IOException("打不开媒体库写入流");
                try {
                    copy(in, os);
                    os.flush();
                } finally {
                    try { os.close(); } catch (IOException ignore) {}
                }
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                cr.update(uri, done, null, null);
            } catch (Exception e) {
                // 半截坏文件不留相册
                try { cr.delete(uri, null, null); } catch (Exception ignore) {}
                throw new IOException("写入失败：" + msgOf(e));
            }
            return new Saved(uri, isMedia ? "已保存到相册" : "已保存到「下载」", name);
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  保存 · API 24-28（传统路径 + WRITE_EXTERNAL_STORAGE）
    // ════════════════════════════════════════════════════════════════
    static Saved saveLegacy(Context ctx, InputStream in, String name, String mime, int kind)
            throws Exception {
        if (ctx.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            throw new IOException("没有存储权限（打开 App 点「允许」后让电脑重发）");
        }
        boolean isMedia = (kind == KIND_IMAGE || kind == KIND_VIDEO);
        File dir = new File(Environment.getExternalStoragePublicDirectory(
                isMedia ? Environment.DIRECTORY_DCIM : Environment.DIRECTORY_DOWNLOADS), OPEN_DIR);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("建保存目录失败：" + dir);
        File out = uniqueFile(dir, name);
        try {
            OutputStream os = new FileOutputStream(out);
            try {
                copy(in, os);
                os.flush();
            } finally {
                try { os.close(); } catch (IOException ignore) {}
            }
        } catch (Exception e) {
            try { out.delete(); } catch (Exception ignore) {}
            throw new IOException(msgOf(e));
        }
        if (isMedia) {
            // 让相册收录（listener=null：一发即忘）
            try {
                MediaScannerConnection.scanFile(ctx,
                        new String[]{out.getAbsolutePath()}, new String[]{mime}, null);
            } catch (Exception ignore) {}
        }
        return new Saved(FileProviderMini.uriFor(out),
                isMedia ? "已保存到相册" : "已保存到「下载」", out.getName());
    }

    /** 同名文件自动加 -1/-2…（传统路径没有 MediaStore 的去重） */
    private static File uniqueFile(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 1000; i++) {
            f = new File(dir, base + "-" + i + ext);
            if (!f.exists()) return f;
        }
        return new File(dir, name + "-" + System.currentTimeMillis());
    }

    // ════════════════════════════════════════════════════════════════
    //  通知
    // ════════════════════════════════════════════════════════════════
    /** 完成通知：可点开文件（没有能打开它的应用时退化为"打开 App"并说明） */
    private static void notifyDone(Context ctx, int notiId, Saved saved) {
        if (ctx == null) return;
        PendingIntent pi = openPending(ctx, notiId, saved);
        String text;
        if (pi != null) {
            text = saved.where + "：" + saved.displayName + "（点开查看）";
        } else {
            text = saved.where + "：" + saved.displayName + "（手机上没有可打开它的应用）";
            pi = mainPending(ctx, notiId);
        }
        try {
            postNotification(ctx, notiId, text, pi, false, true);
        } catch (Exception e) {
            Log.w(TAG, "完成通知失败: " + e.getMessage());
        }
    }

    /** 失败通知：**必须带原因**（P66：失败静默 = 用户以为"没反应"） */
    private static void notifyFail(Context ctx, int notiId, String name, String reason) {
        if (ctx == null) return;
        String text = "接收失败：" + name + " —— " + ellipsize(reason, 60);
        try {
            postNotification(ctx, notiId, text, mainPending(ctx, notiId), false, true);
        } catch (Exception e) {
            Log.w(TAG, "失败通知发不出去: " + e.getMessage());
        }
    }

    /** 发/更新一条文件通知（普通渠道：进通知栏，不响不震） */
    private static void postNotification(Context ctx, int id, String text, PendingIntent pi,
                                         boolean ongoing, boolean autoCancel) {
        if (ctx == null) return;
        Notification.Builder b = (Build.VERSION.SDK_INT >= 26)
                ? new Notification.Builder(ctx, NotifyService.NORMAL_CH)   // 沿用服务的"普通"渠道
                : new Notification.Builder(ctx);
        b.setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("dsh-access-phone-remote · 文件")
                .setContentText(text)
                .setOnlyAlertOnce(true)
                .setOngoing(ongoing)
                .setAutoCancel(autoCancel)
                .setWhen(System.currentTimeMillis());
        if (pi != null) b.setContentIntent(pi);
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_DEFAULT);
        NotificationManager nm =
                (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(id, b.build());
    }

    /** 建"打开文件"的 PendingIntent；没有应用能打开时返回 null */
    private static PendingIntent openPending(Context ctx, int reqCode, Saved saved) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(saved.uri, mimeOf(saved.displayName));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (ctx.getPackageManager().resolveActivity(i, PackageManager.MATCH_DEFAULT_ONLY) == null) {
                return null;
            }
            return PendingIntent.getActivity(ctx, reqCode, i,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        } catch (Exception e) {
            Log.w(TAG, "建打开入口失败: " + e.getMessage());
            return null;
        }
    }

    /** 退路：点开 App 本体 */
    private static PendingIntent mainPending(Context ctx, int reqCode) {
        try {
            Intent i = new Intent(ctx, MainActivity.class);
            i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            return PendingIntent.getActivity(ctx, reqCode + 1, i,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        } catch (Exception e) {
            return null;
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  工具
    // ════════════════════════════════════════════════════════════════
    static class Saved {
        final Uri uri;
        final String where;         // "已保存到相册" / "已保存到「下载」"
        final String displayName;   // 实际落盘的名字（传统路径去重后可能带 -1）
        Saved(Uri u, String w, String n) { uri = u; where = w; displayName = n; }
    }

    /** 流式复制（32KB 块，绝不整读进内存） */
    static void copy(InputStream in, OutputStream os) throws IOException {
        byte[] buf = new byte[32 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
    }

    /** 文件名清理：防路径穿越 + Windows/Android 非法字符；空名兜底时间戳 */
    static String sanitizeName(String raw) {
        String s = raw == null ? "" : raw.trim();
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch < 32) continue;
            if (ch == '\\' || ch == '/' || ch == ':' || ch == '*' || ch == '?'
                    || ch == '"' || ch == '<' || ch == '>' || ch == '|') {
                sb.append('_');
            } else {
                sb.append(ch);
            }
        }
        String out = sb.toString().trim();
        if (out.length() > 120) out = out.substring(0, 120);
        if (out.isEmpty() || ".".equals(out) || "..".equals(out)) {
            out = "file-" + System.currentTimeMillis();
        }
        return out;
    }

    /** 按文件名后缀判 MIME（自己写 if 链，比 MimeTypeMap 可控） */
    static String mimeOf(String name) {
        String n = name == null ? "" : name.toLowerCase(Locale.US);
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".bmp")) return "image/bmp";
        if (n.endsWith(".mp4")) return "video/mp4";
        if (n.endsWith(".mov")) return "video/quicktime";
        if (n.endsWith(".3gp")) return "video/3gpp";
        if (n.endsWith(".mkv")) return "video/x-matroska";
        if (n.endsWith(".webm")) return "video/webm";
        if (n.endsWith(".avi")) return "video/x-msvideo";
        if (n.endsWith(".pdf")) return "application/pdf";
        if (n.endsWith(".zip")) return "application/zip";
        if (n.endsWith(".doc")) return "application/msword";
        if (n.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        if (n.endsWith(".xls")) return "application/vnd.ms-excel";
        if (n.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        if (n.endsWith(".ppt")) return "application/vnd.ms-powerpoint";
        if (n.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        if (n.endsWith(".txt")) return "text/plain";
        if (n.endsWith(".md")) return "text/markdown";
        if (n.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    /** 按后缀分类：图片 / 视频 / 其他 */
    static int kindOf(String name) {
        String n = name == null ? "" : name.toLowerCase(Locale.US);
        if (n.endsWith(".jpg") || n.endsWith(".jpeg") || n.endsWith(".png") || n.endsWith(".gif")
                || n.endsWith(".webp") || n.endsWith(".bmp")) return KIND_IMAGE;
        if (n.endsWith(".mp4") || n.endsWith(".mov") || n.endsWith(".3gp") || n.endsWith(".mkv")
                || n.endsWith(".webm") || n.endsWith(".avi")) return KIND_VIDEO;
        return KIND_OTHER;
    }

    static String humanSize(long n) {
        if (n < 1024) return n + " B";
        if (n < 1024 * 1024) return (n / 1024) + " KB";
        return String.format(Locale.US, "%.1f MB", n / 1048576.0);
    }

    static String ellipsize(String s, int max) {
        if (s == null) return "";
        if (s.length() <= max) return s;
        return s.substring(0, max) + "…";
    }

    static String msgOf(Throwable e) {
        if (e == null) return "未知错误";
        String m = e.getMessage();
        if (m == null || m.isEmpty()) m = e.getClass().getSimpleName();
        return m;
    }

    /** 尽力从错误响应里读服务端 error 文案（读不到给空串，绝不因此抛） */
    static String serverError(HttpURLConnection c) {
        try {
            InputStream es = c.getErrorStream();
            if (es == null) return "";
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[2048];
            int n;
            while ((n = es.read(buf)) > 0 && bo.size() < 8192) bo.write(buf, 0, n);
            es.close();
            String s = bo.toString("UTF-8").trim();
            try {
                JSONObject o = new JSONObject(s);
                String e = o.optString("error", "");
                if (!e.isEmpty()) return "：" + e;
            } catch (Exception ignore) {}
            if (s.isEmpty()) return "";
            return "：" + ellipsize(s, 120);
        } catch (Exception e) {
            return "";
        }
    }
}
