/*
 * Store —— 运行期配置（服务地址 + 口令）的本地存储。
 *
 * 对应安卓：MainActivity.java 的 SharedPreferences("dsj") / hubOf() / authOf() / parseConfig()。
 *   · HUB  = 服务基址，如 http://192.168.1.100:3099（不带尾斜杠）
 *   · AUTH = 口令（原生请求走 X-Auth 头；WebView 靠 /?t= 首次访问种 Cookie）
 *
 * 用的是 @ohos.data.preferences（键值存储），等价于安卓 SharedPreferences。
 * 文档：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-data-preferences
 */
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';

const PREF_NAME: string = 'dsj';
const K_HUB: string = 'hub';
const K_AUTH: string = 'auth';

export class Store {
  private static pref: preferences.Preferences | null = null;
  private static hub: string = '';
  private static auth: string = '';
  private static appContext: common.Context | null = null;

  /** 在 EntryAbility.onCreate 里调一次，把应用上下文交给本模块。 */
  static init(context: common.Context): void {
    Store.appContext = context;
    try {
      Store.pref = preferences.getPreferencesSync(context, { name: PREF_NAME });
      Store.hub = Store.pref.getSync(K_HUB, '') as string;
      Store.auth = Store.pref.getSync(K_AUTH, '') as string;
    } catch (e) {
      // 读不到就当没配过
      Store.pref = null;
      Store.hub = '';
      Store.auth = '';
    }
  }

  /** 服务基址（没配返回空串）。 */
  static getHub(): string {
    return Store.hub;
  }

  /** 口令（没配返回空串 ⇒ 服务端没开口令时照常可用）。 */
  static getAuth(): string {
    return Store.auth;
  }

  /** 首次进站地址：带口令 ⇒ /?t=xxx（服务端会种 180 天 Cookie），没口令 ⇒ 直接 /。 */
  static getStartUrl(): string {
    if (Store.hub.length === 0) {
      return 'about:blank';
    }
    if (Store.auth.length === 0) {
      return Store.hub + '/';
    }
    return Store.hub + '/?t=' + encodeURIComponent(Store.auth);
  }

  /** 写入配置（同步写内存 + 异步落盘）。 */
  static save(hub: string, auth: string): void {
    Store.hub = hub;
    Store.auth = auth;
    if (Store.pref !== null) {
      Store.pref.putSync(K_HUB, hub);
      Store.pref.putSync(K_AUTH, auth);
      Store.pref.flush();
    }
  }

  /**
   * 解析用户粘贴的「完整地址」⇒ [HUB, AUTH]；格式不对返回 null。
   * 容错（与安卓 parseConfig 对齐）：
   *   · 没带 ?t=            ⇒ AUTH 留空
   *   · 带 #锚点 / 其它参数 ⇒ 只取 t
   *   · 末尾多余的 /        ⇒ 规范化（HUB 不带尾斜杠）
   *   · 没写协议头          ⇒ 自动补 http://
   * 说明：这里用纯字符串解析，不依赖 @ohos.uri 的查询参数接口（避免 API 细节猜错）。
   */
  static parseConfig(raw: string): string[] | null {
    if (raw === undefined || raw.length === 0) {
      return null;
    }
    let s: string = raw.trim().replace(/\n/g, '').replace(/\r/g, '').replace(/\s/g, '');
    if (s.length === 0) {
      return null;
    }
    if (!s.startsWith('http://') && !s.startsWith('https://')) {
      s = 'http://' + s;
    }
    // 拆 scheme
    let scheme: string = '';
    let rest: string = s;
    const schemeIdx: number = s.indexOf('://');
    if (schemeIdx < 0) {
      return null;
    }
    scheme = s.substring(0, schemeIdx).toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      return null;
    }
    rest = s.substring(schemeIdx + 3);
    // 去掉 # 之后
    const hashIdx: number = rest.indexOf('#');
    if (hashIdx >= 0) {
      rest = rest.substring(0, hashIdx);
    }
    // 分离 authority 与 path/query
    let slashIdx: number = rest.indexOf('/');
    let queryIdx: number = rest.indexOf('?');
    let cut: number = rest.length;
    if (slashIdx >= 0 && slashIdx < cut) {
      cut = slashIdx;
    }
    if (queryIdx >= 0 && queryIdx < cut) {
      cut = queryIdx;
    }
    const authority: string = rest.substring(0, cut);
    const tail: string = rest.substring(cut);
    if (authority.length === 0) {
      return null;
    }
    // 去掉 authority 里的用户名/密码（安卓的 getHost 也会忽略，这里保守拒绝带 @ 的）
    if (authority.indexOf('@') >= 0) {
      return null;
    }
    // host[:port]
    const colonIdx: number = authority.lastIndexOf(':');
    let host: string = authority;
    let portStr: string = '';
    if (colonIdx > 0) {
      host = authority.substring(0, colonIdx);
      portStr = authority.substring(colonIdx + 1);
    }
    if (host.length === 0) {
      return null;
    }
    if (portStr.length > 0) {
      const p: number = Number(portStr);
      if (isNaN(p) || p <= 0 || p > 65535) {
        return null;
      }
    }
    // 取 ?t= 参数
    let auth: string = '';
    const qIdx: number = tail.indexOf('?');
    if (qIdx >= 0) {
      const qs: string = tail.substring(qIdx + 1);
      const parts: string[] = qs.split('&');
      for (let i = 0; i < parts.length; i++) {
        const seg: string = parts[i];
        if (seg.startsWith('t=')) {
          auth = decodeURIComponent(seg.substring(2));
          break;
        }
      }
    }
    const hub: string = scheme + '://' + host + (portStr.length > 0 ? ':' + portStr : '');
    return [hub, auth];
  }
}
