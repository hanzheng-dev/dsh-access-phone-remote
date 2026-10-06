/*
 * EntryAbility —— 应用入口（对齐安卓 MainActivity 的 Activity 生命周期部分）。
 *
 * 做什么：
 *   1. 读运行期配置（Store.init）
 *   2. 沉浸式布局（对应安卓 setupEdgeToEdge）：内容铺到状态栏下面
 *   3. 加载主页面 pages/Index
 *   4. 申请通知授权（Notify.init）
 *   5. 已配置地址 ⇒ 启动长连接与长时任务（NotifyService.start，必须在前台调）
 *
 * 文档：
 *   · UIAbility：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/uiability-lifecycle
 *   · 沉浸式：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-apis-window-Window#setwindowlayoutfullscreen9
 */
import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { Store } from '../common/Store';
import { Notify } from '../common/Notify';
import { NotifyService } from '../service/NotifyService';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // 把应用上下文交给配置模块（相当于安卓拿 SharedPreferences）
    Store.init(this.context);
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    // 沉浸式：布局不避让状态栏（内容压在状态栏下面），等价安卓 LAYOUT_FULLSCREEN
    try {
      const win: window.Window = windowStage.getMainWindowSync();
      win.setWindowLayoutFullScreen(true).catch((err: BusinessError) => {
        console.warn('setWindowLayoutFullScreen 失败: ' + err.code + ' ' + err.message);
      });
    } catch (e) {
      // 拿不到主窗口不致命
    }

    windowStage.loadContent('pages/Index', (err: BusinessError) => {
      if (err.code) {
        console.error('loadContent 失败: ' + err.message);
        return;
      }
      // 申请通知授权（Android 13+ 也是先请求，系统才会弹）
      Notify.init(this.context);
    });
  }

  onForeground(): void {
    // 前台时确保长连接在跑（长时任务只能前台申请）。没配地址就先不启，配好后由 Setup 启。
    if (Store.getHub().length > 0) {
      NotifyService.start(this.context);
    }
  }

  onDestroy(): void {
    // 与安卓一致：应用销毁时可停掉连接（系统也会随进程回收）
    NotifyService.stop();
  }
}
