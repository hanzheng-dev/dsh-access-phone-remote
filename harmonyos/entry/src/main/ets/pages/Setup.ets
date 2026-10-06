/*
 * Setup —— 首次配置页（移植安卓 MainActivity 的配置视图 + submitConfig）。
 *
 * 主人把电脑上的访问地址整条粘进来即可，例如：
 *   http://192.168.1.100:3099/?t=xxxxxxxx
 * 会自动拆成 HUB（协议+主机+端口）与 AUTH（?t= 口令）。
 *
 * 入口（与安卓一致，三个）：
 *   ① 首次启动没配置 ⇒ 自动进这里
 *   ② 主页加载失败，右上角「⚙ 配置」
 *   ③ 网页里 window.DsNative.reconfigure()
 *
 * 文档：
 *   · TextInput：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/ts-basic-components-textinput
 */
import { common } from '@kit.AbilityKit';
import { promptAction, router } from '@kit.ArkUI';
import { Store } from '../common/Store';
import { NotifyService } from '../service/NotifyService';

@Entry
@Component
struct Setup {
  @State private url: string = '';

  aboutToAppear(): void {
    if (Store.getHub().length > 0) {
      this.url = Store.getAuth().length > 0
        ? Store.getHub() + '/?t=' + Store.getAuth()
        : Store.getHub() + '/';
    }
  }

  private connect(): void {
    const cfg: string[] | null = Store.parseConfig(this.url);
    if (cfg === null) {
      promptAction.showToast({ message: '地址格式不对，示例：http://192.168.1.100:3099/?t=xxxx' });
      return;
    }
    const hub: string = cfg[0];
    const auth: string = cfg[1];
    const lower: string = hub.toLowerCase();
    if (lower.indexOf('://127.0.0.1') >= 0 || lower.indexOf('://localhost') >= 0
      || lower.indexOf('://[::1]') >= 0) {
      promptAction.showToast({
        message: '127.0.0.1 是电脑自己，手机连不上——请填局域网的 192.168.x.x 或 Tailscale 的 100.x.x.x'
      });
      return;
    }
    Store.save(hub, auth);
    // 通知服务可能还挂在旧地址上 ⇒ 重启一次（对齐安卓 stopService + startNotifyService）
    NotifyService.stop();
    try {
      const ctx: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
      NotifyService.start(ctx);
    } catch (e) {
      // 忽略
    }
    promptAction.showToast({ message: '已连接：' + hub });
    router.replaceUrl({ url: 'pages/Index' });
  }

  build() {
    Scroll() {
      Column() {
        Text('dsh-access-phone-remote')
          .fontSize(26)
          .fontColor('#EEEEEE')
          .margin({ top: 48 })
        Text('第一次使用，请填电脑地址')
          .fontSize(14)
          .fontColor('#9A9A9A')
          .margin({ top: 8 })

        TextInput({ text: this.url, placeholder: '粘贴完整地址' })
          .type(InputType.Normal)
          .textAlign(TextAlign.Start)
          .fontSize(15)
          .fontColor('#EEEEEE')
          .placeholderColor('#6B675C')
          .backgroundColor('#201F1A')
          .borderRadius(10)
          .borderWidth(1)
          .borderColor('#3A382F')
          .height(48)
          .margin({ top: 28 })
          .onChange((v: string) => {
            this.url = v;
          })

        Text('形如 http://192.168.1.100:3099/?t=xxxxx')
          .fontSize(12)
          .fontColor('#6B675C')
          .width('100%')
          .margin({ top: 6 })

        Text('在电脑上启动服务后：口令看启动日志（或项目根目录 .hub-token），'
          + '电脑 IP 用 ipconfig 查（局域网 192.168.x.x）；在外面用就填 Tailscale 的 100.x.x.x。\n'
          + '把这两样拼成上面那种地址，整条复制粘贴过来即可。')
          .fontSize(13)
          .fontColor('#9A9A9A')
          .width('100%')
          .margin({ top: 14 })

        Button('连  接')
          .fontSize(16)
          .fontColor('#2A2419')
          .backgroundColor('#FFC98A')
          .borderRadius(10)
          .height(46)
          .width('100%')
          .margin({ top: 26 })
          .onClick(() => {
            this.connect();
          })

        // 已配置过时，给一个「返回」入口（首次进入没有可返回的页面）
        if (Store.getHub().length > 0) {
          Button('返  回')
            .fontSize(14)
            .fontColor('#EEEEEE')
            .backgroundColor('#201F1A')
            .borderRadius(10)
            .height(42)
            .width('100%')
            .margin({ top: 12 })
            .onClick(() => {
              router.back();
            })
        }
      }
      .width('100%')
      .padding({ left: 24, right: 24, bottom: 24 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#14130F')
  }
}
