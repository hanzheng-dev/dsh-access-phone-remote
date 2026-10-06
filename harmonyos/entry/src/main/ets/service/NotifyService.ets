/*
 * NotifyService —— 常驻 SSE 长连接 + 系统通知（移植安卓 NotifyService.java）。
 *
 * ⚠️⚠️ 与安卓最大的不同（必须知道）：
 *   安卓用「前台 Service（foregroundServiceType=dataSync）」保活。
 *   鸿蒙的 ServiceExtensionAbility（type: "service"）**只对系统应用开放**，三方应用用不了。
 *   三方应用的等价物是「长时任务」Background Tasks Kit：
 *     backgroundTaskManager.startBackgroundRunning(context, BackgroundMode.DATA_TRANSFER, wantAgent)
 *   它会让通知栏出现一条与长时任务绑定的通知，进程退后台不被挂起。
 *   文档：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/continuous-task
 *
 *   ⚠️ 待验证：DATA_TRANSFER 任务要求「进度长时间（>10 分钟）不更新会被取消」——
 *     对「一直挂着收消息」这种用法是否会被系统判为不合规，我没法在本机验证。
 *     若长连接被系统掐，备选方案是接华为 Push Kit（云推送），但那要服务端改造，本次不做。
 *
 * SSE 协议（读自 hub 的 src/routes/push.js）：
 *   data: {"type":"hello"/"ping", ...}
 *   data: {"type":"new","msg":{...}}
 *   data: {"type":"append","id":N,"text":"..."}
 *   data: {"type":"end","id":N}
 * 服务端每 15 秒发一次 ping（心跳）。
 *
 * 心跳看门狗（照抄安卓 2026-09-29 的教训）：
 *   · 距上次收到字节 > 40s ⇒ 主动 destroy 连接重连（半死连接不会自己报错）
 *   · 连接活过 120s ⇒ 无条件重连一次，顺带补发（catchUpMissed）
 *
 * HTTP 流式接口：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-http
 */
import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { WantAgent, common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { preferences } from '@kit.ArkData';
import { Store } from '../common/Store';
import { Notify } from '../common/Notify';
import { FileReceiver } from '../common/FileReceiver';
import { getText, HttpResult } from '../common/Http';

// 级别
const LV_SILENT: number = 0;
const LV_NORMAL: number = 1;
const LV_ALERT: number = 2;

// 看门狗参数（对齐安卓）
const BEAT_STALE_MS: number = 40 * 1000;
const BEAT_TICK_MS: number = 5 * 1000;
const MAX_CONN_AGE_MS: number = 120 * 1000;
const FILE_CATCHUP_MS: number = 5 * 60 * 1000;
const PREFS: string = 'dsnotify';
const K_TS: string = 'lastSunTs';
const K_ID: string = 'lastSunId';

interface FileRef {
  path: string;
  name?: string;
  size?: number;
}

interface PushMsg {
  id?: number;
  ts?: number;
  kind?: string;
  from?: string;
  image?: string;
  text?: string;
  level?: string;
  buttons?: object;
  options?: object;
  file?: FileRef;
}

/** SSE 一条事件：{type:'new'|'append'|'end'|'hello'|'ping', ...} */
interface SseEvent {
  type?: string;
  id?: number;
  text?: string;
  msg?: PushMsg;
}

/** GET /api/inbox 的响应。 */
interface InboxResp {
  messages?: PushMsg[];
}

export class NotifyService {
  private static inst: NotifyService | null = null;

  private context: common.UIAbilityContext | null = null;
  private running: boolean = false;
  private sseReq: http.HttpRequest | null = null;
  private beatTimer: number = -1;
  private lastDataAt: number = 0;
  private connStartedAt: number = 0;
  private backoff: number = 2000;

  private buf: string = '';
  private dataLines: string[] = [];

  private curMsgId: number = -1;
  private curText: string = '';
  private curNotiId: number = 100;
  private lastNotiId: number = -1;
  private curLevel: number = LV_NORMAL;

  private pref: preferences.Preferences | null = null;
  private lastSunTs: number = 0;
  private lastSunId: number = -1;

  /** 由 EntryAbility 在【前台】调用（长时任务必须在前台申请）。 */
  static async start(context: common.UIAbilityContext): Promise<void> {
    if (NotifyService.inst !== null && NotifyService.inst.running) {
      return;
    }
    const svc: NotifyService = new NotifyService();
    NotifyService.inst = svc;
    await svc.begin(context);
  }

  static stop(): void {
    if (NotifyService.inst !== null) {
      NotifyService.inst.halt();
      NotifyService.inst = null;
    }
  }

  private async begin(context: common.UIAbilityContext): Promise<void> {
    this.context = context;
    try {
      this.pref = preferences.getPreferencesSync(context, { name: PREFS });
      this.lastSunTs = this.pref.getSync(K_TS, 0) as number;
      this.lastSunId = this.pref.getSync(K_ID, -1) as number;
    } catch (e) {
      this.pref = null;
    }

    // 申请长时任务（等价安卓 startForegroundService）
    try {
      const agent: WantAgent | undefined = await Notify.makeOpenAgent();
      if (agent !== undefined) {
        // ⚠️ 待验证：这里用单枚举重载 BackgroundMode.DATA_TRANSFER；
        //     新 SDK 还提供 startBackgroundRunning(context, Array<string>, wantAgent) 重载。
        await backgroundTaskManager.startBackgroundRunning(
          context, backgroundTaskManager.BackgroundMode.DATA_TRANSFER, agent);
      }
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      console.error('startBackgroundRunning 失败(继续跑，退后台可能被挂起): ' + err.code + ' ' + err.message);
    }

    // 用户删掉长时任务通知 ⇒ 系统取消任务 ⇒ 我们停掉长连接（对齐安卓"用户删除通知即停"）
    try {
      backgroundTaskManager.on('continuousTaskCancel', (info: backgroundTaskManager.ContinuousTaskCancelInfo) => {
        console.info('长时任务被取消 reason=' + info.reason);
        this.halt();
      });
    } catch (e) {
      // 旧版本不支持该事件，忽略
    }

    this.running = true;
    this.beatTimer = setInterval(() => {
      this.beatTick();
    }, BEAT_TICK_MS);

    // SSE 主循环（async 递归重连）
    this.loop();
  }

  private halt(): void {
    this.running = false;
    if (this.beatTimer >= 0) {
      clearInterval(this.beatTimer);
      this.beatTimer = -1;
    }
    if (this.sseReq !== null) {
      try {
        this.sseReq.destroy();
      } catch (e) {
        // 忽略
      }
      this.sseReq = null;
    }
    try {
      backgroundTaskManager.off('continuousTaskCancel');
    } catch (e) {
      // 忽略
    }
    if (this.context !== null) {
      try {
        backgroundTaskManager.stopBackgroundRunning(this.context);
      } catch (e) {
        // 忽略
      }
    }
  }

  private beatTick(): void {
    if (!this.running || this.sseReq === null || this.lastDataAt <= 0) {
      return;
    }
    const now: number = Date.now();
    const idle: number = now - this.lastDataAt;
    const age: number = this.connStartedAt > 0 ? (now - this.connStartedAt) : 0;
    if (idle > BEAT_STALE_MS) {
      console.warn('心跳判死：' + idle + 'ms 无数据 ⇒ 主动断开重连');
      this.lastDataAt = now;   // 防重复踢
      this.kickConnection();
    } else if (age > MAX_CONN_AGE_MS) {
      this.connStartedAt = now;   // 防重复踢
      this.kickConnection();
    }
  }

  private kickConnection(): void {
    const req: http.HttpRequest | null = this.sseReq;
    if (req !== null) {
      try {
        req.destroy();
      } catch (e) {
        // 忽略
      }
    }
  }

  /** SSE 主循环：断线后指数退避重连。 */
  private async loop(): Promise<void> {
    while (this.running) {
      const base: string = Store.getHub();
      if (base.length === 0) {
        await this.sleep(3000);   // 还没配置地址，歇会儿再看
        continue;
      }
      const connectedOk: boolean = await this.connectOnce(base);
      if (!this.running) {
        break;
      }
      await this.sleep(this.backoff);
      if (this.backoff < 30000) {
        this.backoff = this.backoff * 2;
      }
      if (connectedOk) {
        this.backoff = 2000;
      }
    }
  }

  /** 建一条 SSE 连接并读到结束/出错。返回是否曾经成功连上。 */
  private async connectOnce(base: string): Promise<boolean> {
    const req: http.HttpRequest = http.createHttp();
    this.sseReq = req;
    this.buf = '';
    this.dataLines = [];
    const decoder: util.TextDecoder = util.TextDecoder.create('utf-8');
    let connected: boolean = false;

    req.on('headersReceive', (header: Object) => {
      connected = true;
      this.backoff = 2000;
      this.lastDataAt = Date.now();
      this.connStartedAt = this.lastDataAt;
      console.info('SSE 已连接');
      // 每次(重)连成功都补一次断线窗口（对齐安卓）
      this.catchUpMissed();
    });

    req.on('dataReceive', (data: ArrayBuffer) => {
      this.lastDataAt = Date.now();
      try {
        // decodeToString（API 12+，非废弃）代替旧的 decodeWithStream
        const chunk: string = decoder.decodeToString(new Uint8Array(data), { stream: true });
        this.feed(chunk);
      } catch (e) {
        // 解码异常不致命，下一块继续
      }
    });

    req.on('dataEnd', () => {
      console.info('SSE 流结束（对端关闭）');
    });

    try {
      await req.requestInStream(base + '/api/events', {
        method: http.RequestMethod.GET,
        header: {
          'Accept': 'text/event-stream',
          'Connection': 'keep-alive',
          'X-Auth': Store.getAuth()
        },
        connectTimeout: 10000,
        // 0 = 不设读超时；半死连接由心跳看门狗处理（对齐安卓教训）
        readTimeout: 0,
        expectDataType: http.HttpDataType.ARRAY_BUFFER
      });
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      console.warn('SSE 断开: ' + err.code + ' ' + err.message);
    } finally {
      try {
        req.destroy();
      } catch (e) {
        // 忽略
      }
      if (this.sseReq === req) {
        this.sseReq = null;
      }
    }
    return connected;
  }

  /** 逐行喂 SSE 文本，遇到空行组成一条 data 事件后回调 onSseEvent。 */
  private feed(chunk: string): void {
    this.buf += chunk;
    let idx: number = this.buf.indexOf('\n');
    while (idx >= 0) {
      let line: string = this.buf.substring(0, idx);
      if (line.endsWith('\r')) {
        line = line.substring(0, line.length - 1);
      }
      this.buf = this.buf.substring(idx + 1);
      if (line.length === 0) {
        if (this.dataLines.length > 0) {
          const payload: string = this.dataLines.join('\n');
          this.dataLines = [];
          try {
            const ev: SseEvent = JSON.parse(payload) as SseEvent;
            this.onSseEvent(ev);
          } catch (e) {
            // 非 JSON（retry 等）忽略
          }
        }
      } else if (line.startsWith('data:')) {
        let v: string = line.substring(5);
        if (v.startsWith(' ')) {
          v = v.substring(1);
        }
        this.dataLines.push(v);
      }
      idx = this.buf.indexOf('\n');
    }
  }

  private onSseEvent(ev: SseEvent): void {
    const type: string = ev.type !== undefined ? ev.type : '';
    if (type === 'new') {
      const msg: PushMsg | undefined = ev.msg;
      if (msg === undefined) {
        return;
      }
      if (this.context !== null) {
        FileReceiver.maybeReceive(this.context, msg);
      }
      const lv: number = NotifyService.levelOf(msg);
      if (lv !== LV_SILENT) {
        const nid: number = msg.id !== undefined ? msg.id : -1;
        if (lv === LV_ALERT && nid === this.lastSunId) {
          // 已弹过，跳过（补发/重连幂等）
        } else {
          this.notifyNew(msg, lv);
        }
      }
    } else if (type === 'append') {
      const id: number = ev.id !== undefined ? ev.id : -1;
      if (id === this.curMsgId) {
        const t: string = ev.text !== undefined ? ev.text : '';
        this.curText += t;
        Notify.publish(this.curNotiId, NotifyService.titleOf(this.curLevel),
          NotifyService.ellipsize(this.curText, 200), false);
      }
    } else if (type === 'end') {
      const id: number = ev.id !== undefined ? ev.id : -1;
      if (id === this.curMsgId) {
        this.curMsgId = -1;
      }
    }
  }

  private static titleOf(lv: number): string {
    return lv === LV_ALERT ? 'dsh-access-phone-remote · 重要' : 'dsh-access-phone-remote';
  }

  /** 截断到 max 个字符，且不切断 emoji 的代理对（对齐安卓 ellipsize）。 */
  private static ellipsize(s: string, max: number): string {
    if (s.length <= max) {
      return s;
    }
    let end: number = max;
    const code: number = s.charCodeAt(end - 1);
    if (code >= 0xD800 && code <= 0xDBFF) {
      end--;
    }
    return s.substring(0, end) + '…';
  }

  /** 判断「op 完成任务」的向日葵（对齐安卓 isSunflower）。 */
  private static isSunflower(msg: PushMsg): boolean {
    if (msg === undefined) {
      return false;
    }
    if (msg.kind !== 'chat') {
      return false;
    }
    if (msg.from === 'phone') {
      return false;
    }
    return msg.image === '/shots/ccd-done.gif';
  }

  /** 决定一条消息弹不弹、弹哪档（对齐安卓 levelOf）。 */
  private static levelOf(msg: PushMsg): number {
    const lv: string = msg.level !== undefined ? msg.level.trim().toLowerCase() : '';
    if (lv === 'alert' || lv === 'important' || lv === 'high') {
      return LV_ALERT;
    }
    if (lv === 'normal' || lv === 'default' || lv === 'info') {
      return LV_NORMAL;
    }
    if (lv === 'silent' || lv === 'quiet' || lv === 'low' || lv === 'off') {
      return LV_SILENT;
    }
    // 无 level：向后兼容
    if (NotifyService.isSunflower(msg)) {
      return LV_ALERT;
    }
    if (msg.buttons !== undefined) {
      return LV_ALERT;
    }
    if (msg.options !== undefined) {
      return LV_ALERT;
    }
    const kind: string = msg.kind !== undefined ? msg.kind : '';
    if (kind === 'tool' || kind === 'reasoning') {
      return LV_SILENT;
    }
    if (msg.from === 'phone') {
      return LV_SILENT;
    }
    if (kind === 'chat' || kind === 'text' || kind === 'announce') {
      return LV_NORMAL;
    }
    return LV_SILENT;
  }

  private notifyNew(msg: PushMsg, lv: number): void {
    const id: number = msg.id !== undefined ? msg.id : Date.now();
    this.lastNotiId = this.curNotiId;
    // 每条新消息换唯一通知 id：更新同 id 不会重弹横幅（同安卓 MIUI 教训）
    this.curNotiId = 1000 + Math.abs(id) % 1000000;
    this.curMsgId = id;
    this.curLevel = lv;
    this.curText = msg.text !== undefined ? msg.text : '';
    if (this.lastNotiId !== -1 && this.lastNotiId !== this.curNotiId) {
      Notify.cancel(this.lastNotiId);
    }
    Notify.publish(this.curNotiId, NotifyService.titleOf(lv),
      NotifyService.ellipsize(this.curText.length > 0 ? this.curText : '（空消息）', 200),
      lv === LV_ALERT);
    if (lv === LV_ALERT) {
      this.lastSunId = id;
      this.lastSunTs = msg.ts !== undefined ? msg.ts : Date.now();
      this.saveCursor();
    }
  }

  private saveCursor(): void {
    if (this.pref !== null) {
      this.pref.putSync(K_TS, this.lastSunTs);
      this.pref.putSync(K_ID, this.lastSunId);
      this.pref.flush();
    }
  }

  /** 断线补发：拉一次 /api/inbox?since=游标，把窗口里漏掉的重要通知补弹出来。 */
  private async catchUpMissed(): Promise<void> {
    const base: string = Store.getHub();
    if (base.length === 0) {
      return;
    }
    if (this.lastSunTs <= 0) {
      this.lastSunTs = Date.now();
      this.saveCursor();
      return;
    }
    try {
      const res: HttpResult = await getText(base + '/api/inbox?since=' + this.lastSunTs, Store.getAuth(), 10000, 15000);
      if (res.code !== 200) {
        return;
      }
      const root: InboxResp = JSON.parse(res.body) as InboxResp;
      const arr: PushMsg[] | undefined = root.messages;
      if (arr === undefined) {
        return;
      }
      let newest: PushMsg | null = null;
      let newestTs: number = -1;
      const nowMs: number = Date.now();
      for (let i = 0; i < arr.length; i++) {
        const m: PushMsg = arr[i];
        if (m.file !== undefined) {
          const fts: number = m.ts !== undefined ? m.ts : 0;
          if (fts > 0 && nowMs - fts <= FILE_CATCHUP_MS && this.context !== null) {
            FileReceiver.maybeReceive(this.context, m);
          }
        }
        if (NotifyService.levelOf(m) !== LV_ALERT) {
          continue;
        }
        const ts: number = m.ts !== undefined ? m.ts : 0;
        if (ts <= this.lastSunTs) {
          continue;
        }
        const mid: number = m.id !== undefined ? m.id : -1;
        if (mid === this.lastSunId) {
          continue;
        }
        if (ts > newestTs) {
          newestTs = ts;
          newest = m;
        }
      }
      if (newest !== null) {
        this.notifyNew(newest, LV_ALERT);
      }
    } catch (e) {
      console.warn('断线补发失败');
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void) => {
      setTimeout(() => {
        resolve();
      }, ms);
    });
  }
}
