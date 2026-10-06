/*
 * WebOverlay —— 内置网页浮层（移植安卓 WebActivity）。
 *
 * 用途：消息里的网页卡片点开后弹一个小窗口，或主页「控制」里的 🌐 按钮。
 *   · 高度 = 75% 屏高（安卓 2026-09-22 主人定的比例）
 *   · 标题栏跟主题同色 + 圆角 + 淡淡的遮罩（点遮罩收起）
 *   · Cookie 持久：鸿蒙 Web 组件默认把 cookie 写应用数据目录，登录一次后认得
 *     （与电脑浏览器不共享，和安卓一样的隔离行为）
 *
 * 文档：
 *   · Web 组件：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-basic-components-web
 *   · Cookie：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-apis-webview-WebCookieManager
 */
import { webview } from '@kit.ArkWeb';
// 说明：MixedMode 是 Web 组件自带的全局枚举，无需 import（官方示例同）。
import { router } from '@kit.ArkUI';

interface OverlayParams {
  url?: string;
  title?: string;
  dark?: boolean;
}

// 浮层默认首页（照抄安卓 WebActivity.HOME_HTML：搜索框 + 两个快捷入口）
const HOME_HTML: string =
  "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'>" +
  "<meta name='viewport' content='width=device-width,initial-scale=1,viewport-fit=cover'>" +
  "<title>搜索</title><style>" +
  "*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}" +
  "html,body{margin:0;padding:0;min-height:100%;background:#fff}" +
  "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;" +
  "color:#202020;padding:26px 22px}" +
  "form{display:flex;align-items:center;gap:10px;border:1px solid #e0e0e0;border-radius:22px;" +
  "background:#fff;padding:0 6px 0 18px;height:48px;margin:0 0 20px}" +
  "input{flex:1;min-width:0;height:100%;border:0;outline:0;background:transparent;" +
  "font-size:16px;color:#202020;font-family:inherit}" +
  "button.q{flex:none;width:38px;height:38px;border:0;border-radius:50%;background:transparent;color:#5a5a5a}" +
  ".stitle{font-size:13px;color:#9a9a9a;margin:0 0 12px}" +
  "a.card{display:flex;align-items:center;gap:14px;text-decoration:none;color:inherit;" +
  "border:1px solid #e6e6e6;border-radius:16px;background:#fafafa;padding:20px 18px;margin:0 0 16px}" +
  ".t{display:block;font-size:16.5px;font-weight:600;margin-bottom:3px}" +
  ".s{display:block;font-size:12.5px;color:#9a9a9a}" +
  "</style></head><body>" +
  "<form id='f' autocomplete='off'><input id='q' type='search' placeholder='搜索'>" +
  "<button class='q' type='submit'>搜索</button></form>" +
  "<p class='stitle'>快捷入口</p>" +
  "<a class='card' href='https://gcli.ggchan.dev'><span class='t'>GG 公益站</span><span class='s'>gcli.ggchan.dev</span></a>" +
  "<a class='card' href='https://platform.deepseek.com/usage'><span class='t'>DeepSeek 用量</span><span class='s'>platform.deepseek.com/usage</span></a>" +
  "<script>(function(){var f=document.getElementById('f'),q=document.getElementById('q');" +
  "f.addEventListener('submit',function(e){e.preventDefault();var v=(q.value||'').trim();if(!v)return;" +
  "location.href='https://cn.bing.com/search?q='+encodeURIComponent(v);});})();</script>" +
  "</body></html>";

@Entry
@Component
struct WebOverlay {
  private controller: webview.WebviewController = new webview.WebviewController();
  private pageUrl: string = '';
  @State private titleText: string = '浏览器';
  @State private dark: boolean = false;
  private loaded: boolean = false;

  aboutToAppear(): void {
    const p: OverlayParams | undefined = router.getParams() as OverlayParams | undefined;
    if (p !== undefined) {
      if (p.url !== undefined) {
        this.pageUrl = p.url;
      }
      if (p.title !== undefined && p.title.length > 0) {
        this.titleText = p.title;
      }
      if (p.dark !== undefined) {
        this.dark = p.dark;
      }
    }
    if (this.titleText.length === 0) {
      this.titleText = this.pageUrl.length > 0 ? '网页' : '浏览器';
    }
    // Cookie：默认持久；显式打开接收（含第三方，对齐安卓）
    try {
      webview.WebCookieManager.putAcceptCookieEnabled(true);
      webview.WebCookieManager.putAcceptThirdPartyCookieEnabled(true);
    } catch (e) {
      // 忽略
    }
  }

  private loadOnce(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      if (this.pageUrl.length > 0) {
        this.controller.loadUrl(this.pageUrl);
      } else {
        this.controller.loadData(HOME_HTML, 'text/html', 'utf-8', 'https://home.dsjiang.local/');
      }
    } catch (e) {
      // 忽略
    }
  }

  private doBack(): void {
    try {
      if (this.controller.accessBackward()) {
        this.controller.backward();
        return;
      }
    } catch (e) {
      // 忽略
    }
    router.back();
  }

  private close(): void {
    router.back();
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
      // 遮罩：点它收起（很淡，能看见下面的页面）
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(this.dark ? '#3D000000' : '#1F000000')
        .onClick(() => {
          this.close();
        })

      Column() {
        // 标题栏
        Row() {
          Text('◀')
            .fontSize(16)
            .fontColor(this.dark ? '#C9C9C9' : '#6B6B6B')
            .padding({ left: 14, right: 14, top: 4, bottom: 4 })
            .onClick(() => {
              this.doBack();
            })
          Text(this.titleText)
            .fontSize(14.5)
            .fontColor(this.dark ? '#F0F0F0' : '#141414')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
          Text('✕')
            .fontSize(17)
            .fontColor(this.dark ? '#C9C9C9' : '#6B6B6B')
            .padding({ left: 14, right: 14, top: 4, bottom: 4 })
            .onClick(() => {
              this.close();
            })
        }
        .width('100%')
        .padding({ left: 6, right: 6, top: 9, bottom: 9 })
        .backgroundColor(this.dark ? '#1E1E1E' : '#FFFFFF')

        Divider().color(this.dark ? '#33FFFFFF' : '#22000000').strokeWidth(1)

        Web({ src: '', controller: this.controller })
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .fileAccess(true)
          .zoomAccess(true)
          .mixedMode(MixedMode.All)
          .multiWindowAccess(false)
          .onControllerAttached(() => {
            this.loadOnce();
          })
          .onTitleReceive((event) => {
            if (event.title.trim().length > 0) {
              this.titleText = event.title.trim();
            }
          })
          .width('100%')
          .layoutWeight(1)
      }
      .width('100%')
      .height('75%')
      .margin({ left: 12, right: 12 })
      .backgroundColor(this.dark ? '#1E1E1E' : '#FFFFFF')
      .borderRadius(16)
      .clip(true)
      .borderWidth(1)
      .borderColor(this.dark ? '#33FFFFFF' : '#22000000')
    }
    .width('100%')
    .height('100%')
  }
}
