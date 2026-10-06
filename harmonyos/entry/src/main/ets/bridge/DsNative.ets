/*
 * DsNative —— 注入给网页的 JavaScript 对象（对齐安卓 MainActivity.DsNative）。
 *
 * ⚠️⚠️ 方法名 / 参数必须与安卓完全一致，否则 public/index.html 里的
 *   `window.DsNative.xxx(...)` 会**静默失效**。安卓侧定义见 MainActivity.java 的 DsNative 内部类：
 *     takePhoto()
 *     pickPhoto()
 *     openWeb(url: string, title: string)
 *     setBarIcons(lightBg: boolean)
 *     getLocation()
 *     openGeo(lat: string, lng: string, name: string)
 *     openNav(name: string, lat: string, lng: string)
 *     reconfigure()
 *
 * 前端调用处的证据（public/index.html）：
 *   :1677 window.DsNative.openWeb(url, title)
 *   :1689 window.DsNative.openWeb('', DEFAULT_TITLE)
 *   :2954 / :3020 window.DsNative.takePhoto()
 *   :3010 / :3022 window.DsNative.pickPhoto()
 *   :3394 window.DsNative.getLocation()  → 结果回调 window.DsLoc.onResult/onError
 *   :3437 window.DsNative.openGeo(lat, lng, '当前位置')
 *   :3644 window.DsNative.openNav(name, lat, lng)
 *   页面侧状态栏同步脚本（安卓 EDGE_JS）会调 window.DsNative.setBarIcons(light)
 *   重新配置：window.DsNative.reconfigure()
 *
 * 注册方式：见 pages/Index.ets 的 .javaScriptProxy({...})。
 * 文档：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/web-in-page-app-function-invoking
 */
import { NativeOps } from './NativeOps';

export class DsNative {
  takePhoto(): void {
    NativeOps.takePhoto();
  }

  pickPhoto(): void {
    NativeOps.pickPhoto();
  }

  openWeb(url: string, title: string): void {
    NativeOps.openWeb(url, title);
  }

  setBarIcons(lightBg: boolean): void {
    NativeOps.setBarIcons(lightBg);
  }

  getLocation(): void {
    NativeOps.getLocation();
  }

  openGeo(lat: string, lng: string, name: string): void {
    NativeOps.openGeo(lat, lng, name);
  }

  openNav(name: string, lat: string, lng: string): void {
    NativeOps.openNav(name, lat, lng);
  }

  reconfigure(): void {
    NativeOps.reconfigure();
  }
}
