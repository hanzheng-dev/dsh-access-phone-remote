package com.hz.hub;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileNotFoundException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 极简 FileProvider（自写，零依赖）—— 2026-10-05（APK 阶段 7 op）
 *
 * 为什么需要它：
 *   Android 9 及以下（API < 29）没有分区存储，FileReceiver 收来的文件写在传统路径
 *   （DCIM/dsj-open、Download/dsj-open）。通知里"点开文件"如果直接用 file:// 发
 *   ACTION_VIEW，本工程 targetSdk 33 ⇒ 触发 FileUriExposedException（API 24+ 对
 *   file:// 外泄的硬检查）——我们 App 自己会崩。
 *
 *   官方解法是 support 库的 FileProvider，但本工程**不引入任何依赖**（手工构建链），
 *   它的核心本来就只是一个几十行的 ContentProvider ⇒ 自己写一个。
 *
 * 用法：
 *   FileProviderMini.uriFor(file) → content://com.hz.hub.files/open?p=<绝对路径>
 *   随 Intent 带 FLAG_GRANT_READ_URI_PERMISSION 发给系统应用（看图 / 打开方式）。
 *
 * 安全：
 *   · manifest 里 exported=false、grantUriPermissions=true —— 只有本 App 或拿到
 *     临时授权的应用能访问
 *   · openFile 只放行 DCIM/dsj-open 与 Download/dsj-open 两棵树（canonical 前缀
 *     判断，防 ../ 穿越）
 *   · 只读（写一律拒）
 *
 * ⚠️ 本工程禁止匿名内部类（d8 在 JDK24 上会崩，见 PITFALLS P24）
 */
public class FileProviderMini extends ContentProvider {

    static final String AUTHORITY = "com.hz.hub.files";

    /** 保存根目录（与 FileReceiver 的保存位置保持一致：DCIM/dsj-open、Download/dsj-open） */
    static List<File> allowedRoots() {
        List<File> out = new ArrayList<File>();
        File dcim = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DCIM);
        File down = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (dcim != null) out.add(new File(dcim, "dsj-open"));
        if (down != null) out.add(new File(down, "dsj-open"));
        return out;
    }

    /** 文件在不在两个允许根下面（canonical 判断；取不到 canonical 就当不在） */
    static boolean underAllowedRoots(File f) {
        try {
            String p = f.getCanonicalPath();
            List<File> roots = allowedRoots();
            for (int i = 0; i < roots.size(); i++) {
                String r = roots.get(i).getCanonicalPath();
                if (p.equals(r) || p.startsWith(r + File.separator)) return true;
            }
        } catch (Exception e) {
            // 拿不到 canonical（IO/符号链接问题）⇒ 拒绝
        }
        return false;
    }

    /** 给某个已保存文件构造可分享的 content:// URI */
    static Uri uriFor(File f) {
        return new Uri.Builder()
                .scheme("content")
                .authority(AUTHORITY)
                .appendPath("open")
                .appendQueryParameter("p", f.getAbsolutePath())
                .build();
    }

    /** uri → 校验过的文件（不在允许目录返回 null） */
    private File fileOf(Uri uri) {
        if (uri == null) return null;
        String p = uri.getQueryParameter("p");
        if (p == null || p.isEmpty()) return null;
        File f = new File(p);
        if (!underAllowedRoots(f)) return null;
        return f;
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public String getType(Uri uri) {
        File f = fileOf(uri);
        if (f == null) return "application/octet-stream";
        String n = f.getName().toLowerCase(Locale.US);
        int dot = n.lastIndexOf('.');
        if (dot > 0 && dot < n.length() - 1) {
            String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(n.substring(dot + 1));
            if (m != null && !m.isEmpty()) return m;
        }
        return "application/octet-stream";
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (mode != null && mode.indexOf('w') >= 0) throw new FileNotFoundException("只读");
        File f = fileOf(uri);
        if (f == null) throw new FileNotFoundException("不在允许的目录");
        if (!f.isFile()) throw new FileNotFoundException("不是文件");
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        File f = fileOf(uri);
        if (f == null) return null;
        String[] cols = (projection != null && projection.length > 0)
                ? projection
                : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor c = new MatrixCursor(cols);
        MatrixCursor.RowBuilder row = c.newRow();
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) {
                row.add(f.getName());
            } else if (OpenableColumns.SIZE.equals(cols[i])) {
                row.add(Long.valueOf(f.length()));
            } else {
                row.add(null);
            }
        }
        return c;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("只读 provider");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("只读 provider");
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("只读 provider");
    }
}
