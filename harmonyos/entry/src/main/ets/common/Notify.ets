/*
 * Notify —— 系统通知（对齐安卓 NotifyService 的分级提示体系）。
 *
 * 安卓用 NotificationChannel 分两档：dsalert(HIGH，横幅+声+震) / dsmsg(DEFAULT，只进通知栏)。
 * 鸿蒙没有「自建渠道名」，用的是系统预置的通知渠道类型 SlotType：
 *   · SOCIAL_COMMUNICATION = 重要（横幅/声音/震动）
 *   · SERVICE_INFORMATION  = 普通（只进通知栏）
 * 文档：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-notificationManager
 *
 * ⚠️ 待验证：NotificationRequest 的 `content.normal` 结构、`notificationSlotType` 字段名，
 *     以及 SOCIAL_COMMUNICATION 是否真会弹横幅+震动（可能与系统设置/权限有关）。
 *     本机没有 SDK，未编译、未运行验证。
 */
import { notificationManager } from '@kit.NotificationKit';
import { wantAgent, WantAgent } from '@kit.AbilityKit';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';

const BUNDLE_NAME: string = 'io.github.hanzhengdev.phoneaccess';
const ABILITY_NAME: string = 'EntryAbility';

export class Notify {
  private static ready: boolean = false;

  /** 启动时调用一次：申请通知授权 + 建两个渠道。 */
  static async init(context: common.UIAbilityContext): Promise<void> {
    try {
      // 让系统弹「是否允许通知」；用户拒绝也不抛，最多收不到弹窗。
      await notificationManager.requestEnableNotification(context);
    } catch (e) {
      // 已授权/用户关闭等都会走到这里，忽略即可
    }
    try {
      await notificationManager.addSlot(notificationManager.SlotType.SOCIAL_COMMUNICATION);
      await notificationManager.addSlot(notificationManager.SlotType.SERVICE_INFORMATION);
      Notify.ready = true;
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      console.error('Notify.addSlot 失败: ' + err.code + ' ' + err.message);
    }
  }

  /** 构造「点通知回到 App」的 WantAgent。 */
  static async makeOpenAgent(): Promise<WantAgent | undefined> {
    try {
      const info: wantAgent.WantAgentInfo = {
        wants: [
          {
            bundleName: BUNDLE_NAME,
            abilityName: ABILITY_NAME
          }
        ],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: 0,
        actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
      };
      return await wantAgent.getWantAgent(info);
    } catch (e) {
      return undefined;
    }
  }

  /**
   * 发一条通知。
   * @param id    通知 id（alert 用每条消息唯一 id，才能反复弹横幅；与安卓同思路）
   * @param alert true=重要（横幅+声+震）；false=普通（只进通知栏）
   */
  static async publish(id: number, title: string, text: string, alert: boolean): Promise<void> {
    if (!Notify.ready) {
      return;
    }
    const agent: WantAgent | undefined = await Notify.makeOpenAgent();
    const request: notificationManager.NotificationRequest = {
      id: id,
      notificationSlotType: alert
        ? notificationManager.SlotType.SOCIAL_COMMUNICATION
        : notificationManager.SlotType.SERVICE_INFORMATION,
      content: {
        notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
        normal: {
          title: title,
          text: text
        }
      },
      tapDismissed: true
    };
    if (agent !== undefined) {
      request.wantAgent = agent;
    }
    try {
      await notificationManager.publish(request);
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      console.error('Notify.publish 失败: ' + err.code + ' ' + err.message);
    }
  }

  /** 取消指定通知（流式更新时先撤旧条，与安卓 lastNotiId 思路一致）。 */
  static async cancel(id: number): Promise<void> {
    try {
      await notificationManager.cancel(id);
    } catch (e) {
      // 忽略
    }
  }
}
