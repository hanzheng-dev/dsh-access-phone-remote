package com.hz.hub;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/** 开机自启：收到 BOOT_COMPLETED 就拉起 NotifyService（起不来只记日志，别崩） */
public class BootReceiver extends BroadcastReceiver {

    private static final String TAG = "DsBoot";

    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            Intent i = new Intent(context, NotifyService.class);
            if (Build.VERSION.SDK_INT >= 26) {
                context.startForegroundService(i);
            } else {
                context.startService(i);
            }
            Log.i(TAG, "boot: NotifyService 已拉起");
        } catch (Exception e) {
            Log.w(TAG, "boot: 启动失败 " + e.getMessage());
        }
    }
}