/*
 * Index —— 全屏 Web 壳（移植安卓 MainActivity 的 WebView 部分）。
 *
 * 页面 UI 全在电脑端（改 UI 不用重装 App）。原生能力通过 javaScriptProxy 注入的
 * window.DsNative 暴露给网页（方法名与安卓完全一致，见 bridge/DsNative.ets）。
 *
 * 对应安卓：
 *   · startMain()        全屏 WebView，加载 startUrl（带 ?t= 口令）
 *   · HubWebViewClient   onPageFinished 注入 EDGE_JS；onReceivedError 浮出「⚙ 配置」
 *   · HubChromeClient    onShowFileChooser（<input type=file>）
 *   · addJavascriptInterface(new DsNative(this), "DsNative")
 *
 * 文档：
 *   · Web 组件：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-basic-components-web
 *   · 属性：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-basic-components-web-attributes
 *   · 事件：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-basic-components-web-events
 *   · javaScriptProxy 指南：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/web-in-page-app-function-invoking
 */
import { webview } from '@kit.ArkWeb';
// 说明：MixedMode 是 Web 组件自带的全局枚举，无需 import（官方示例同）。
import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { picker } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { Store } from '../common/Store';
import { DsNative } from '../bridge/DsNative';
import { NativeCtx } from '../bridge/NativeCtx';

/*
 * 状态栏图标自动同步脚本（原文照搬安卓 MainActivity.EDGE_JS）。
 * 全屏后状态栏压在页面上，靠它读页面顶部颜色 → window.DsNative.setBarIcons(浅/深)。
 * 每秒一次兜住 SPA 切页（没有事件可听）。
 */
const EDGE_JS: string =
  "(function(){if(window.__dsBarSync)return;window.__dsBarSync=1;" +
  "var last=null;" +
  "function lum(c){var m=/rgba?\\(([^)]+)\\)/.exec(c||'');if(!m)return -1;" +
  "var p=m[1].split(',');var a=p.length>3?parseFloat(p[3]):1;if(a<0.5)return -1;" +
  "return 0.299*parseFloat(p[0])+0.587*parseFloat(p[1])+0.114*parseFloat(p[2]);}" +
  "function sample(){try{var x=Math.round(window.innerWidth/2);var ys=[4,10,18];" +
  "for(var i=0;i<ys.length;i++){var el=document.elementFromPoint(x,ys[i]);" +
  "while(el){var L=lum(getComputedStyle(el).backgroundColor);if(L>=0)return L>140;" +
  "el=el.parentElement||null;}}}catch(e){}" +
  "return !document.documentElement.classList.contains('dark');}" +
  "function tick(){var light=sample();if(light!==last){last=light;" +
  "try{window.DsNative.setBarIcons(light);}catch(e){}}}" +
  "tick();setInterval(tick,800);" +
  "try{new MutationObserver(tick).observe(document.documentElement," +
  "{attributes:true,attributeFilter:['class']});}catch(e){}})();";

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private dsNative: DsNative = new DsNative();
  @State private startUrl: string = 'about:blank';
  @State private showPill: boolean = false;
  private loadStartedAt: number = 0;
  private lastErrorAt: number = 0;

  aboutToAppear(): void {
    // 登记给 JS 桥用
    NativeCtx.controller = this.controller;
    try {
      NativeCtx.context = getContext(this) as common.UIAbilityContext;
    } catch (e) {
      NativeCtx.context = null;
    }
    // 没配地址 ⇒ 先跳配置页（对应安卓 HUB.isEmpty() → showConfig）
    if (Store.getHub().length === 0) {
      router.replaceUrl({ url: 'pages/Setup' });
      return;
    }
    this.startUrl = Store.getStartUrl();
    this.loadStartedAt = Date.now();
    this.lastErrorAt = 0;
  }

  private injectEdgeJs(): void {
    try {
      this.controller.runJavaScript(EDGE_JS);
    } catch (e) {
      // 注入失败不致命
    }
  }

  build() {
    Stack({ alignContent: Alignment.TopEnd }) {
      Web({ src: this.startUrl, controller: this.controller })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .fileAccess(true)
        .zoomAccess(false)
        .mixedMode(MixedMode.All)
        // 对应安卓 addJavascriptInterface(new DsNative(this), "DsNative")
        .javaScriptProxy({
          object: this.dsNative,
          name: 'DsNative',
          methodList: ['takePhoto', 'pickPhoto', 'openWeb', 'setBarIcons',
            'getLocation', 'openGeo', 'openNav', 'reconfigure'],
          controller: this.controller
        })
        // 对应安卓 onPageFinished：注入状态栏同步脚本 + 收起「⚙ 配置」
        .onPageEnd((event) => {
          this.injectEdgeJs();
          if (this.showPill && this.lastErrorAt < this.loadStartedAt) {
            this.showPill = false;
          }
        })
        // 对应安卓 onReceivedError：主页面加载失败 ⇒ 浮出「⚙ 配置」
        .onErrorReceive((event) => {
          if (event.request.isMainFrame()) {
            this.lastErrorAt = Date.now();
            this.showPill = true;
          }
        })
        // 对应安卓 onShowFileChooser：<input type=file> 的系统文件选择
        .onShowFileSelector((event) => {
          const documentPicker: picker.DocumentViewPicker = new picker.DocumentViewPicker();
          documentPicker.select().then((uris: string[]) => {
            event.result.handleFileList(uris);
          }).catch((err: BusinessError) => {
            event.result.handleFileList([]);
          });
          return true;
        })
        // 对应安卓 WebActivity 的 target=_blank 处理：在同一个 Web 里加载新窗口的 URL
        .multiWindowAccess(true)
        .onWindowNew((event) => {
          if (event.targetUrl.length > 0) {
            try {
              this.controller.loadUrl(event.targetUrl);
            } catch (e) {
              // 忽略
            }
          }
          // 不新建窗口 ⇒ setWebController(null)，否则 render 进程阻塞
          // ⚠️ 待验证：setWebController 形参是否允许 null（文档说"设置成 null"，但签名可能标 null 不可入）
          event.handler.setWebController(null);
        })
        .width('100%')
        .height('100%')

      if (this.showPill) {
        Button('⚙ 配置')
          .fontSize(12.5)
          .fontColor('#EEEEEE')
          .backgroundColor('#CC201F1A')
          .borderRadius(14)
          .borderWidth(1)
          .borderColor('#3A382F')
          .padding({ left: 12, right: 12, top: 7, bottom: 7 })
          .margin({ top: 40, right: 12 })
          .onClick(() => {
            router.pushUrl({ url: 'pages/Setup' });
          })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#0D0D0D')
  }
}
