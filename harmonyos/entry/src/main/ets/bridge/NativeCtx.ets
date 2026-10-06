/*
 * NativeCtx —— JS 桥要用到的「全局引用」集中放这里。
 *
 * 为什么要单独一个类：注入给网页的 javaScriptProxy 对象**只能有方法、不应有属性**，
 * 所以 DsNative 里不放字段，需要的东西都从这里取。
 * DsNative 在主 Web 壳（pages/Index）里创建，那时把 controller 与 ability 上下文登记进来。
 */
import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';

export class NativeCtx {
  /** 主 Web 壳的控制器（runJavaScript / 回传定位结果用）。 */
  static controller: webview.WebviewController | null = null;
  /** 应用 UIAbility 上下文（startAbility / 相机 / 相册 / 定位 / 文件用）。 */
  static context: common.UIAbilityContext | null = null;
  /** 页面顶部当前是不是浅色（由网页 setBarIcons 报上来，给「网页浮层」选皮肤）。 */
  static lastLightBg: boolean = true;
}
