/*
 * FileReceiver —— 接收电脑推来的文件（移植安卓 FileReceiver.java）。
 *
 * 流程（与安卓一致）：
 *   hub 推一条带 file:{path,name,size} 的消息
 *     ⇒ 本类 GET <base>/api/file?path=…&raw=1（带 X-Auth）
 *     ⇒ 存到应用沙箱目录
 *     ⇒ 弹「已保存」通知；失败也弹通知并写明原因（P66：失败绝不静默）
 *
 * ⚠️ 与安卓的差异（重要）：
 *   安卓能直接写进「相册（DCIM）/下载（Download）」公有目录，点通知能唤起系统应用打开文件。
 *   鸿蒙三方应用不申请媒体库写权限、也不能随便写公共目录 ⇒ 本实现先落到**应用沙箱**，
 *   通知点击目前只能回到 App 本体（不是打开文件）。若要真正存相册，需要另做
 *   photoAccessHelper 写媒体库 + 动态申请权限，或走「另存为」选择器 —— 本次未做（见 PORTING.md）。
 *
 * 文档：
 *   · HTTP：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-http
 *   · 文件：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-file-fs
 */
import { http } from '@kit.NetworkKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { Store } from './Store';
import { Notify } from './Notify';

interface FileMeta {
  path: string;
  name?: string;
  size?: number;
}

interface RecvMsg {
  id?: number;
  ts?: number;
  file?: FileMeta;
}

const MAX_BYTES: number = 100 * 1024 * 1024;
const NOTI_BASE: number = 5000000;

export class FileReceiver {
  private static seen: Set<number> = new Set<number>();
  private static notiSeq: number = 0;
  private static chain: Promise<void> = Promise.resolve();

  /** 入口：消息带 file 字段 ⇒ 排队接收（幂等，同一条消息只收一次）。 */
  static maybeReceive(context: common.Context, msg: object): void {
    const m: RecvMsg = msg as RecvMsg;
    const f: FileMeta | undefined = m.file;
    if (f === undefined) {
      return;
    }
    if (f.path.length === 0) {
      return;
    }
    const id: number = m.id !== undefined ? m.id : -1;
    if (id >= 0 && !FileReceiver.markSeen(id)) {
      return;
    }
    const name: string = FileReceiver.sanitizeName(f.name !== undefined ? f.name : '');
    const size: number = f.size !== undefined ? f.size : -1;
    // 串行执行，避免并发写乱（对齐安卓单线程队列）
    FileReceiver.chain = FileReceiver.chain.then(() => {
      return FileReceiver.download(context, f.path, name, size);
    });
  }

  private static markSeen(id: number): boolean {
    if (FileReceiver.seen.has(id)) {
      return false;
    }
    if (FileReceiver.seen.size > 500) {
      FileReceiver.seen.clear();
    }
    FileReceiver.seen.add(id);
    return true;
  }

  private static async download(context: common.Context, remotePath: string,
                                name: string, sizeHint: number): Promise<void> {
    const base: string = Store.getHub();
    const notiId: number = NOTI_BASE + (++FileReceiver.notiSeq);
    if (base.length === 0) {
      await Notify.publish(notiId, 'dsh-access-phone-remote · 文件',
        '接收失败：' + name + ' —— App 还没配置服务地址', false);
      return;
    }
    const url: string = base + '/api/file?path=' + encodeURIComponent(remotePath) + '&raw=1';
    const req: http.HttpRequest = http.createHttp();
    try {
      const resp: http.HttpResponse = await req.request(url, {
        method: http.RequestMethod.GET,
        header: {
          'Accept': 'application/octet-stream',
          'X-Auth': Store.getAuth()
        },
        connectTimeout: 15000,
        readTimeout: 60000,
        expectDataType: http.HttpDataType.ARRAY_BUFFER,
        maxLimit: MAX_BYTES
      });
      if (resp.responseCode !== 200) {
        await Notify.publish(notiId, 'dsh-access-phone-remote · 文件',
          '接收失败：' + name + ' —— 服务端拒绝（HTTP ' + resp.responseCode + '）', false);
        return;
      }
      // ⚠️ 老版服务端没有 raw 模式会返回 JSON ⇒ 安卓靠 Content-Disposition 判别；
      //    鸿蒙这边 resp.header 里取，取不到就按字节存（可能在老服务端上存成 JSON）。
      const data: ArrayBuffer = resp.result as ArrayBuffer;
      const dir: string = context.filesDir + '/dsh-access-phone-remote';
      try {
        fs.mkdirSync(dir);
      } catch (e) {
        // 目录已存在会抛，忽略
      }
      const outPath: string = dir + '/' + name;
      const file = fs.openSync(outPath, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      try {
        fs.writeSync(file.fd, data);
      } finally {
        fs.closeSync(file);
      }
      await Notify.publish(notiId, 'dsh-access-phone-remote · 文件',
        '已保存到应用目录：' + name, false);
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      await Notify.publish(notiId, 'dsh-access-phone-remote · 文件',
        '接收失败：' + name + ' —— ' + err.message, false);
    } finally {
      req.destroy();
    }
  }

  /** 文件名清理：防路径穿越 + 非法字符；空名兜底时间戳（对齐安卓 sanitizeName）。 */
  private static sanitizeName(raw: string): string {
    let s: string = raw !== null && raw !== undefined ? raw.trim() : '';
    let out: string = '';
    for (let i = 0; i < s.length; i++) {
      const ch: string = s.charAt(i);
      const code: number = s.charCodeAt(i);
      if (code < 32) {
        continue;
      }
      if (ch === '\\' || ch === '/' || ch === ':' || ch === '*' || ch === '?'
        || ch === '"' || ch === '<' || ch === '>' || ch === '|') {
        out += '_';
      } else {
        out += ch;
      }
    }
    out = out.trim();
    if (out.length > 120) {
      out = out.substring(0, 120);
    }
    if (out.length === 0 || out === '.' || out === '..') {
      out = 'file-' + Date.now().toString();
    }
    return out;
  }
}
