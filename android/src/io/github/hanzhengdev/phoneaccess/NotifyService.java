package io.github.hanzhengdev.phoneaccess;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * ds酱 前台服务 —— 常驻连 hub 的 SSE，收到 dsh 回话就弹系统通知。
 *
 * 2026-09-17 由 op 按调研方案（甲）实现：
 *   dataSync 前台服务 + 常驻 SSE + START_STICKY + BOOT_COMPLETED + AlarmManager 看门狗
 *   ⚠️ 本工程禁止匿名内部类（d8 会崩），全部具名/静态类。
 */
public class NotifyService extends Service {

    private static final String TAG = "DsNotify";
    // ⭐⭐ 2026-09-18 01:09 主人最终定调：「要有横幅弹出来震动」+「不许把正在看的 app 踢掉」。
    //   ⇒ 恢复 IMPORTANCE_HIGH（横幅 + 响 + 震），但**只保留"点了才跳"的 contentIntent**，
    //     并显式 setFullScreenIntent(null) —— 双保险，绝不让通知把前台 app 挤掉。
    //   ⚠️ Android 的渠道 importance **一旦创建就不可改**（旧 "chat"=HIGH、
    //      "chatquiet"=LOW 都改不动了），所以用**全新 id "chatv2"** 重建，
    //      再把旧的两个删掉，免得设置里出现三个同名渠道。
    // ⭐⭐ 2026-09-28 op：**提示体系（分级）** —— 主人要「不连着向日葵也能弹」。
    //   两级渠道（渠道 importance 一旦创建不可改 ⇒ 用全新 id 重建）：
    //     · dsalert（IMPORTANCE_HIGH）  = 重要：横幅 + 声音 + 震动（吃药/待办/紧急）
    //     · dsmsg  （IMPORTANCE_DEFAULT）= 普通：只进通知栏，无声无震（回话/完成）
    //     · 静默 = 不弹系统通知（工具播报/思考/自己发的）
    //   ⚠️ 旧渠道 chatv2 / chat / chatquiet 全部删掉，免得设置里三个同义渠道。
    private static final String ALERT_CH = "dsalert";
    static final String NORMAL_CH = "dsmsg";   // 包可见：FileReceiver 的文件通知也走这个渠道
    private static final String OLD_CHAT_CH = "chat";        // 旧 HIGH
    private static final String OLD_QUIET_CH = "chatquiet";  // 旧 LOW
    private static final String OLD_CHATV2_CH = "chatv2";    // 上一版 HIGH
    private static final String FGS_CH = "fgs";     // 常驻条通道（低调，认常驻通知开关）
    private static final int FGS_ID = 1;
    private static final int CHAT_ID = 100;          // 兜底 id（首条之前用）
    // 级别常量
    private static final int LV_SILENT = 0;   // 不弹
    private static final int LV_NORMAL = 1;   // 通知栏（无声无震）
    private static final int LV_ALERT = 2;    // 横幅+声+震
    // ⭐⭐ 2026-09-18 主人反馈：「有震动，但一直没横幅弹出」。
    //   真凶：通知固定用 id=100 + setOnlyAlertOnce(true)。MIUI 会把"同一个 key 的再次提醒"
    //   当成**更新**处理 —— 只在通知栏改字 + 震动，**不再弹 heads-up 横幅**。
    //   ⇒ 每条新消息换一个**唯一 id**（横幅每次都会来），流式追加仍用同一个 id 做静默更新。
    private volatile int curNotiId = CHAT_ID;        // 当前这条通知的 id
    private volatile int lastNotiId = -1;            // 上一条（新消息来了就取消，免得堆一屏）
    private volatile int curLevel = LV_NORMAL;       // 当前这条的级别（流式追加时沿用）
    // ⭐ 2026-10-05 开源版：SSE 地址 / 口令不再写死 —— 每次（重）连都从运行期配置现读
    //   （MainActivity 的 SharedPreferences "dsj"）；没配置就先等，配好 3 秒内自动连上。
    //   原生 SSE（HttpURLConnection）没有 WebView 的 Cookie，必须自带 X-Auth 头 ——
    //   否则收到登录页 HTML / 被拒（hub 日志「未授权访问 /api/events」刷屏）。
    // ⭐⭐ 2026-09-28 op：**断线补发**。病根：SSE 断线窗口有几分钟（进程被系统冻结/杀掉时
    //   连重连循环都跑不了），窗口里的向日葵全丢（实测 9/24 15:40、9/28 19:27 两条漏掉）。
    //   hub 没有补发机制 ⇒ 客户端每次(重)连成功，都自己拉一次 /api/inbox?since=上次提醒时间，
    //   把窗口里漏掉的向日葵补弹出来。用 SharedPreferences 记住"上次弹过的 ts/id"，防重复弹。
    private static final String INBOX_PATH = "/api/inbox";   // ⭐ 基址现读，见 catchUpMissed()
    private static final String PREFS = "dsnotify";
    private static final String K_TS = "lastSunTs";
    private static final String K_ID = "lastSunId";
    // 看门狗判僵死：连接活着但这么久没收到任何字节 ⇒ 踢掉强制重连（hub 心跳 15s，3 倍余量）
    private static final long STALE_MS = 75 * 1000;
    private static final long WATCHDOG_MS = 15L * 60 * 1000;
    // ⭐ 2026-10-05（阶段7）：断线窗口里补收附件的时限（更老的文件不重下）
    private static final long FILE_CATCHUP_MS = 5 * 60 * 1000;

    // ⭐ 2026-09-18 op 修「退出 app 后收不到通知」的真凶：
    //   原来是 setReadTimeout(0)（永不超时）。手机切后台/息屏后连接会变"半死"
    //   （对端 FIN/RST 都没到），readLine() 就**永远阻塞** —— 既不抛异常、也不重连，
    //   前台服务看着还在跑，其实早就聋了。hub 每 15 秒发一次心跳 ping
    //   （hub-server.js:821），所以 45 秒（= 3 次心跳）收不到任何字节即判死、断开重连。
    private static final int READ_TIMEOUT_MS = 45 * 1000;

    // ⭐⭐ 2026-09-29 op：**应用层心跳看门狗 + 最长连接寿命**（修「hub 一重启就收不到通知」）。
    //   实测病因（隔离实验 + 手机现场）：
    //     · 45s 读超时只对「连续 45s **零字节**」生效；而 hub 每 15s 发一次 ping ⇒ 字节一直在到
    //       ⇒ 读超时**永远不触发**（证明了"超时设了没生效"不是 bug，是判据不成立）。
    //     · 半死连接的真相：数据堆在手机 socket 的 Recv-Q 里**没人消费**（生产 3099 连接实测
    //       Recv-Q 62~783、另有 3~4 条 CLOSE-WAIT），但它对外仍 ESTABLISHED、ping 照收 ⇒
    //       "静默判死"整类方案（含读超时）都瞎。
    //   ⇒ 两条兜底：
    //     ① 心跳看门狗：距上次收到字节 > BEAT_STALE_MS ⇒ 主动 disconnect 重连（不靠读超时）。
    //     ② 最长寿命：连接活过 MAX_CONN_AGE_MS 就无条件重连一次 ⇒ 必然跑 catchUpMissed()
    //        补发，把窗口里漏掉的 alert 捞回来（即使网络层看起来一切正常）。
    private static final long BEAT_STALE_MS = 40 * 1000;    // ≈2.6 个 ping；< 读超时 ⇒ 先触发
    private static final long BEAT_TICK_MS = 5 * 1000;
    private static final long MAX_CONN_AGE_MS = 120 * 1000;

    private volatile boolean running = true;
    private Thread sseThread;
    private Thread beatThread;
    private volatile long lastDataAt = 0;   // 最后一次收到字节的时间（诊断+看门狗判僵死）
    private volatile long connStartedAt = 0; // 当前这条连接建立的时间（最长寿命用）
    private volatile HttpURLConnection activeConn = null;  // 当前这条 SSE 连接（看门狗要踢得着）
    private long curMsgId = -1;
    private final StringBuilder curText = new StringBuilder();
    // 上次"弹过"的向日葵（断线补发去重用；落盘，重启不丢）
    private long lastSunTs = 0;
    private long lastSunId = -1;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            lastSunTs = sp.getLong(K_TS, 0);
            lastSunId = sp.getLong(K_ID, -1);
        } catch (Exception e) {
            Log.w(TAG, "读补发游标失败: " + e.getMessage());
        }
    }

    private void saveCursor() {
        try {
            getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putLong(K_TS, lastSunTs).putLong(K_ID, lastSunId).apply();
        } catch (Exception e) {
            Log.w(TAG, "写补发游标失败: " + e.getMessage());
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification fgs = buildFgsNotification();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(FGS_ID, fgs, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(FGS_ID, fgs);
        }
        // ⭐ 2026-09-28：看门狗不再只"看线程活没活"——线程可能活活卡在 readLine 上
        //   （半死连接）。凡是"活着但很久没收到字节"，直接 disconnect 踢掉，逼它重连。
        if (sseThread != null && sseThread.isAlive() && lastDataAt > 0
                && System.currentTimeMillis() - lastDataAt > STALE_MS) {
            Log.w(TAG, "看门狗：连接僵死（" + (System.currentTimeMillis() - lastDataAt) + "ms 无数据），踢掉重连");
            kickConnection();
        }
        if (sseThread == null || !sseThread.isAlive()) {
            sseThread = new Thread(new SseRunner(this));
            sseThread.start();
        }
        // ⭐ 2026-09-29：心跳看门狗线程（幂等——活着就不重复起）
        if (beatThread == null || !beatThread.isAlive()) {
            beatThread = new Thread(new BeatRunner(this));
            beatThread.start();
        }
        scheduleWatchdog();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---------- 通知渠道 ----------
    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        // ⭐ 2026-09-18 01:09 主人要的：**横幅 + 震动都保留**（IMPORTANCE_HIGH）。
        //   不弹横幅的病根上一版已经查清：那不是"踢人"的原因 —— 横幅本来只盖在上面，
        //   真正会把人从 B 站拉走的是①通知带 fullscreenIntent ②手滑点到横幅 ③系统开关。
        //   所以这里保持 HIGH（横幅+声+震），同时用 setFullScreenIntent(null) 明确禁掉①。
        // 重要：横幅 + 声 + 震
        NotificationChannel alert = new NotificationChannel(ALERT_CH, "dsh-access-phone-remote · 重要",
                NotificationManager.IMPORTANCE_HIGH);
        alert.setDescription("吃药/待办/紧急 —— 弹横幅 + 声音 + 震动");
        alert.enableVibration(true);
        alert.enableLights(true);
        alert.setShowBadge(true);
        nm.createNotificationChannel(alert);
        // 普通：只进通知栏（无声无震，不打扰）
        NotificationChannel normal = new NotificationChannel(NORMAL_CH, "dsh-access-phone-remote · 普通",
                NotificationManager.IMPORTANCE_DEFAULT);
        normal.setDescription("回话/完成 —— 只进通知栏，不打扰");
        normal.setSound(null, null);
        normal.enableVibration(false);
        normal.enableLights(false);
        normal.setShowBadge(true);
        nm.createNotificationChannel(normal);
        // 旧渠道删掉（chat / chatquiet / chatv2 都别留）
        try { nm.deleteNotificationChannel(OLD_CHAT_CH); } catch (Exception e) {
            Log.w(TAG, "删旧渠道 chat 失败: " + e.getMessage());
        }
        try { nm.deleteNotificationChannel(OLD_QUIET_CH); } catch (Exception e) {
            Log.w(TAG, "删旧渠道 chatquiet 失败: " + e.getMessage());
        }
        try { nm.deleteNotificationChannel(OLD_CHATV2_CH); } catch (Exception e) {
            Log.w(TAG, "删旧渠道 chatv2 失败: " + e.getMessage());
        }
        NotificationChannel fgs = new NotificationChannel(FGS_CH, "服务运行",
                NotificationManager.IMPORTANCE_LOW);
        fgs.setDescription("保持后台连接");
        nm.createNotificationChannel(fgs);
    }

    // ---------- 通知 ----------
    private Notification.Builder newBuilder(String channelId) {
        if (Build.VERSION.SDK_INT >= 26) {
            return new Notification.Builder(this, channelId);
        }
        return new Notification.Builder(this);
    }

    private Notification buildFgsNotification() {
        Notification.Builder b = newBuilder(FGS_CH)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("dsh-access-phone-remote")
                .setContentText("服务运行中，消息实时推送")
                .setOngoing(true);
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_LOW);
        return b.build();
    }

    private void notifyChat(String text, boolean fresh) { notifyChat(text, fresh, curLevel); }

    /** 截断到 max 个 char，**不切断代理对**（emoji 是 2 个 char，切一半会变问号/方块） */
    private static String ellipsize(String s, int max) {
        if (s == null) return "";
        if (s.length() <= max) return s;
        int end = max;
        // 第 end 位（不含）正好落在低位代理 ⇒ 说明前一位是高代理，回退一格保住整个 emoji
        if (Character.isHighSurrogate(s.charAt(end - 1))) end--;
        return s.substring(0, end) + "…";
    }

    /** 按级别选渠道：alert=横幅+响+震；normal=通知栏（无声无震） */
    private void notifyChat(String text, boolean fresh, int lv) {
        if (text == null || text.isEmpty()) text = "（空消息）";
        text = ellipsize(text, 200);
        boolean alert = (lv == LV_ALERT);
        int notiId = curNotiId;
        Intent tap = new Intent(this, MainActivity.class);
        // NEW_TASK + SINGLE_TOP = 只把这一个 ds酱 实例带到前台，**不动别的 app 的任务栈**
        tap.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        // ⭐ 独立 requestCode（原来是 0，和看门狗的 getService(0) 同号 —— 类型虽不同，
        //   但留着这个隐患没意义，换成 100）。
        PendingIntent pi = PendingIntent.getActivity(this, 100, tap,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = newBuilder(alert ? ALERT_CH : NORMAL_CH)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(alert ? "dsh-access-phone-remote · 重要" : "dsh-access-phone-remote")
                .setContentText(text)
                .setContentIntent(pi)               // 只"点了才跳"——绝不主动抢前台
                // ⭐⭐ 显式清空 fullscreenIntent：它是"来电"那种直接全屏拉起 Activity 的
                //   字段，唯一能把人从当前 app 踢走的合法路径。本代码从未设过，设 null 双保险。
                .setFullScreenIntent(null, false)
                .setAutoCancel(true)
                .setWhen(System.currentTimeMillis());
        if (alert) {
            b.setTicker(text);                  // 部分 ROM 用它决定 heads-up 文案
            // MIUI 的 MiuiHeadsUpPolicy 还会看通知自身的 priority（dump 里 pri=0 ⇒ 不弹横幅）
            b.setPriority(Notification.PRIORITY_MAX);
        } else {
            b.setPriority(Notification.PRIORITY_DEFAULT);
        }
        // ⭐⭐ 真凶：**新消息绝不能带 ONLY_ALERT_ONCE** —— 带上它 + 复用同一个通知 id 时，
        //   MIUI 会把每一条都当"上一条的更新"，只改字 + 震动，**不再弹 heads-up 横幅**。
        //   所以 fresh（新消息）不设；只有流式追加（append）才带，免得每来一个字又震一次。
        if (!fresh) b.setOnlyAlertOnce(true);
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        try {
            // 新消息：先把上一条取消（不同 id），免得通知栏越堆越多
            if (fresh && lastNotiId != -1 && lastNotiId != notiId) {
                nm.cancel(lastNotiId);
            }
            nm.notify(notiId, b.build());
        } catch (Exception e) {
            Log.w(TAG, "notify failed: " + e.getMessage());
        }
    }

    // ---------- SSE 事件 ----------
    private void onSseEvent(JSONObject o) {
        String type = o.optString("type");
        if ("new".equals(type)) {
            JSONObject msg = o.optJSONObject("msg");
            if (msg == null) return;
            // ⭐⭐ 2026-10-05（APK 阶段 7 op）：**带附件的消息 ⇒ 自动接收存相册/下载**。
            //   与提示级别无关（file 消息可能被判 silent 不弹通知，但文件必须收）。
            //   只入队、不阻塞（下载在 FileReceiver 的单线程队列里跑）。
            FileReceiver.maybeReceive(this, msg);
            // ⭐⭐⭐ 2026-09-28 op：**提示体系** —— 按 level 分级弹，不再只认向日葵。
            //   level 字段（hub /api/push 透传）：alert / normal / silent；没有字段时向后兼容
            //   （向日葵含图 ⇒ alert；回话类 chat/text ⇒ normal；工具/思考/自己发的 ⇒ silent）。
            int lv = levelOf(msg);
            Log.i(TAG, "SSE new kind=" + msg.optString("kind")
                    + " img=" + msg.optString("image", "") + " level=" + msg.optString("level", "-")
                    + " → " + lvName(lv) + " id=" + msg.optLong("id", -1));
            if (lv != LV_SILENT) {
                long nid = msg.optLong("id", -1);
                // alert 幂等：补发/重连时不重复弹同一条（用 lastSunId 作游标）
                if (lv == LV_ALERT && nid == lastSunId) {
                    // 已弹过，跳过
                } else {
                    notifyNew(msg, lv);
                }
            }
        } else if ("append".equals(type)) {
            long id = o.optLong("id", -1);
            if (id == curMsgId) {
                curText.append(o.optString("text", ""));
                notifyChat(curText.toString(), false, curLevel);
            }
        } else if ("end".equals(type)) {
            if (o.optLong("id", -1) == curMsgId) curMsgId = -1;
        }
    }

    /** 是不是"op 完成任务"的向日葵（kind=chat、不是手机发的、图是 ccd-done.gif） */
    private static boolean isSunflower(JSONObject msg) {
        if (msg == null) return false;
        if (!"chat".equals(msg.optString("kind"))) return false;
        if ("phone".equals(msg.optString("from"))) return false;
        return "/shots/ccd-done.gif".equals(msg.optString("image", ""));
    }

    private static String lvName(int lv) {
        return lv == LV_ALERT ? "ALERT" : (lv == LV_NORMAL ? "NORMAL" : "SILENT");
    }

    /**
     * ⭐⭐ 提示体系的核心：决定一条消息该不该弹、弹哪一档。
     *   ① 显式 level 字段优先（alert / normal / silent，含别名）
     *   ② 没字段 ⇒ 向后兼容老行为：
     *      · 向日葵（op 干完了）⇒ ALERT
     *      · 工具调用 / 思考 ⇒ SILENT（不打扰）
     *      · 手机自己发的 ⇒ SILENT（别弹给自己）
     *      · 普通回话 chat/text/announce ⇒ NORMAL（进通知栏，不打扰）
     *      · 其它 ⇒ SILENT
     */
    private static int levelOf(JSONObject msg) {
        if (msg == null) return LV_SILENT;
        String lv = msg.optString("level", "").trim().toLowerCase();
        if ("alert".equals(lv) || "important".equals(lv) || "high".equals(lv)) return LV_ALERT;
        if ("normal".equals(lv) || "default".equals(lv) || "info".equals(lv)) return LV_NORMAL;
        if ("silent".equals(lv) || "quiet".equals(lv) || "low".equals(lv) || "off".equals(lv)) return LV_SILENT;
        // ---- 无 level：向后兼容 ----
        if (isSunflower(msg)) return LV_ALERT;
        // 带按钮/选项卡的消息 = 要主人「回应」的 ⇒ 当重要弹（吃药/打卡/待办都走这条）
        if (msg.optJSONArray("buttons") != null || msg.optJSONObject("options") != null) return LV_ALERT;
        String kind = msg.optString("kind", "");
        if ("tool".equals(kind) || "reasoning".equals(kind)) return LV_SILENT;
        if ("phone".equals(msg.optString("from", ""))) return LV_SILENT;
        if ("chat".equals(kind) || "text".equals(kind) || "announce".equals(kind)) return LV_NORMAL;
        return LV_SILENT;
    }

    /** 弹一条消息通知，并把"补发游标"推到这条（仅 alert，ts+id 都记，防重启重复弹） */
    private void notifyNew(JSONObject msg, int lv) {
        long id = msg.optLong("id", -1);
        // ⭐⭐ 每条新消息换**唯一通知 id**：MIUI 只对"新 key"弹横幅，
        //   同一个 id 再发只会被当成"更新"（只改字 + 震动，不弹横幅）。
        lastNotiId = curNotiId;
        curNotiId = 1000 + (int) (Math.abs(id) % 1000000L);
        curMsgId = id;
        curLevel = lv;
        curText.setLength(0);
        curText.append(msg.optString("text", ""));
        notifyChat(curText.toString(), true, lv);   // fresh=true ⇒ 横幅/进栏
        if (lv == LV_ALERT) {
            lastSunId = id;
            lastSunTs = msg.optLong("ts", System.currentTimeMillis());
            saveCursor();
        }
    }

    /** 踢掉当前 SSE 连接（disconnect 会让阻塞中的 readLine 立刻抛异常 ⇒ 走重连） */
    private void kickConnection() {
        try {
            HttpURLConnection c = activeConn;
            if (c != null) c.disconnect();
        } catch (Exception e) {
            Log.w(TAG, "踢连接失败: " + e.getMessage());
        }
    }

    // ---------- 应用层心跳看门狗（2026-09-29）----------
    /** 距上次收到字节超过 BEAT_STALE_MS，或连接活过 MAX_CONN_AGE_MS ⇒ 主动断开重连。
     *  两条判据都**先复位 lastDataAt**，避免踢完立刻又判死（重复踢）。 */
    void beatLoop() {
        while (running) {
            try { Thread.sleep(BEAT_TICK_MS); } catch (InterruptedException ie) { break; }
            if (activeConn == null || lastDataAt <= 0) continue;
            long now = System.currentTimeMillis();
            long idle = now - lastDataAt;
            long age = connStartedAt > 0 ? (now - connStartedAt) : 0;
            if (idle > BEAT_STALE_MS) {
                Log.w(TAG, "心跳判死：" + idle + "ms 无数据（hub ping 15s）⇒ 主动断开重连");
                lastDataAt = now;              // 防重复踢
                kickConnection();
            } else if (age > MAX_CONN_AGE_MS) {
                Log.i(TAG, "连接寿命 " + age + "ms 到期（" + MAX_CONN_AGE_MS
                        + "ms）⇒ 主动重连并补发");
                connStartedAt = now;           // 防重复踢
                kickConnection();
            }
        }
    }

    /** ⭐ 断线补发：拉一次 /api/inbox?since=游标，把窗口里漏掉的向日葵补弹出来 */
    private void catchUpMissed() {
        try {
            String base = MainActivity.hubOf(this);
            if (base.isEmpty()) return;   // ★ 开源版：还没配置地址
            if (lastSunTs <= 0) {
                // 首次运行：立刻建基线，免得把历史上一堆旧向日葵全弹出来
                lastSunTs = System.currentTimeMillis();
                saveCursor();
                return;
            }
            HttpURLConnection c = (HttpURLConnection)
                    new URL(base + INBOX_PATH + "?since=" + lastSunTs).openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(15000);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("X-Auth", MainActivity.authOf(this));
            StringBuilder sb = new StringBuilder();
            try {
                BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
                r.close();
            } finally {
                c.disconnect();
            }
            JSONObject o = new JSONObject(sb.toString());
            JSONArray arr = o.optJSONArray("messages");
            if (arr == null) return;
            JSONObject newest = null;
            long newestTs = -1;
            long nowMs = System.currentTimeMillis();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject m = arr.optJSONObject(i);
                if (m == null) continue;
                // ⭐ 2026-10-05（阶段7 op）：断线窗口里漏掉的**附件**也补收。
                //   只收 5 分钟内的（太老的不重下）；FileReceiver 内部按消息 id 幂等。
                if (m.optJSONObject("file") != null) {
                    long fts = m.optLong("ts", 0);
                    if (fts > 0 && nowMs - fts <= FILE_CATCHUP_MS) {
                        FileReceiver.maybeReceive(this, m);
                    }
                }
                if (levelOf(m) != LV_ALERT) continue;
                long ts = m.optLong("ts", 0);
                if (ts <= lastSunTs) continue;
                if (m.optLong("id", -1) == lastSunId) continue;
                if (ts > newestTs) { newestTs = ts; newest = m; }
            }
            if (newest != null) {
                Log.i(TAG, "断线补发：漏掉的重要通知 id=" + newest.optLong("id", -1)
                        + " 迟 " + (System.currentTimeMillis() - newestTs) + "ms");
                notifyNew(newest, LV_ALERT);
            } else {
                Log.i(TAG, "断线补发：没有漏掉的重要通知（游标 " + lastSunTs + "）");
            }
        } catch (Exception e) {
            Log.w(TAG, "断线补发失败: " + e.getMessage());
        }
    }

    // ---------- SSE 循环（指数退避重连） ----------
    void runSseLoop() {
        int backoff = 2000;
        while (running) {
            // ★ 开源版：地址现读；没配就先歇着（配好后 3 秒内自动连上）
            String base = MainActivity.hubOf(this);
            if (base.isEmpty()) {
                Log.i(TAG, "还没配置服务地址，3 秒后再看…");
                try { Thread.sleep(3000); } catch (InterruptedException ie) { break; }
                continue;
            }
            HttpURLConnection c = null;
            // ⭐ 2026-09-18：r 提到 try 外面 —— 原来只在 try 里 new，从没关过，
            //   对端 FIN 之后本地 socket 一直挂 CLOSE_WAIT（实测手机上攒了 3 条）。
            //   现在 finally 里先 close 流、再 disconnect，连接才算真正释放。
            BufferedReader r = null;
            long t0 = System.currentTimeMillis();
            try {
                Log.i(TAG, "SSE 连接 " + base + "/api/events …");
                URL u = new URL(base + "/api/events");
                c = (HttpURLConnection) u.openConnection();
                c.setConnectTimeout(10000);
                // ⚠️ 这里原来是 0（永不超时）—— 那正是「切后台就收不到」的病根：
                //    连接半死时 readLine() 永远不返回，既不 catch 也不重连。
                c.setReadTimeout(READ_TIMEOUT_MS);
                c.setRequestProperty("Accept", "text/event-stream");
                c.setRequestProperty("Connection", "keep-alive");
                c.setRequestProperty("X-Auth", MainActivity.authOf(this));   // 口令鉴权（开源版现读）
                r = new BufferedReader(
                        new InputStreamReader(c.getInputStream(), "UTF-8"));
                activeConn = c;
                backoff = 2000;
                lastDataAt = System.currentTimeMillis();
                connStartedAt = lastDataAt;
                Log.i(TAG, "SSE 已连接（读超时 " + READ_TIMEOUT_MS + "ms）");
                // ⭐ 2026-09-28：每次(重)连成功都补一次 —— 断线窗口里漏掉的重要通知不会丢
                catchUpMissed();
                String line;
                while (running && (line = r.readLine()) != null) {
                    lastDataAt = System.currentTimeMillis();
                    if (line.startsWith("data:")) {
                        String payload = line.substring(5).trim();
                        if (!payload.isEmpty()) {
                            try {
                                onSseEvent(new JSONObject(payload));
                            } catch (Exception e) {
                                Log.w(TAG, "json err: " + e.getMessage());
                            }
                        }
                    }
                }
                Log.w(TAG, "SSE 流结束（对端关闭）");
            } catch (IOException e) {
                long ref = lastDataAt > 0 ? lastDataAt : t0;
                Log.w(TAG, "SSE 断开：" + e.getClass().getSimpleName() + " " + e.getMessage()
                        + "（距上次收数据 " + (System.currentTimeMillis() - ref) + "ms）");
            } finally {
                // 先关流（否则 socket 悬在 CLOSE_WAIT），再 disconnect
                if (r != null) {
                    try { r.close(); } catch (IOException ignore) {}
                }
                if (c != null) c.disconnect();
                if (activeConn == c) activeConn = null;
            }
            if (!running) break;
            Log.i(TAG, "SSE " + backoff + "ms 后重连");
            try { Thread.sleep(backoff); } catch (InterruptedException ie) { break; }
            if (backoff < 30000) backoff *= 2;
        }
    }

    // ---------- AlarmManager 15 分钟看门狗 ----------
    private void scheduleWatchdog() {
        try {
            AlarmManager am = (AlarmManager) getSystemService(ALARM_SERVICE);
            Intent i = new Intent(this, NotifyService.class);
            PendingIntent pi = PendingIntent.getService(this, 0, i,
                    PendingIntent.FLAG_IMMUTABLE);
            am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    SystemClock.elapsedRealtime() + WATCHDOG_MS, pi);
        } catch (Exception e) {
            Log.w(TAG, "watchdog err: " + e.getMessage());
        }
    }

    /** 具名 Runnable —— 不能用匿名类 */
    static class SseRunner implements Runnable {
        private final NotifyService svc;
        SseRunner(NotifyService s) { svc = s; }
        public void run() { svc.runSseLoop(); }
    }

    static class BeatRunner implements Runnable {
        private final NotifyService svc;
        BeatRunner(NotifyService s) { svc = s; }
        public void run() { svc.beatLoop(); }
    }
}