/*
 * NativeOps —— DsNative 各方法的具体实现（拆出来，让 DsNative 保持"只有方法"）。
 *
 * 对应安卓 MainActivity.java 的：
 *   startCamera / startPicker / startWebLayer / applyBarIcons / requestLocation /
 *   startGeo / startNav / showConfig / sendToHub / uploadBytes / pushImage / wgs84ToGcj02
 *
 * 文档：
 *   · 相机选择器：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-cameraPicker
 *   · 图库选择器：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-photoAccessHelper
 *   · 文件与 URI：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-file-fs
 *   · 定位：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-geoLocationManager
 *   · 窗口（状态栏）：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-apis-window-Window
 *   · HTTP：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-http
 */
import { common, Want, abilityAccessCtrl, Permissions } from '@kit.AbilityKit';
import { promptAction, window, router } from '@kit.ArkUI';
import { cameraPicker, camera } from '@kit.CameraKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { fileIo as fs, fileUri } from '@kit.CoreFileKit';
import { geoLocationManager } from '@kit.LocationKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { Store } from '../common/Store';
import { uploadBytes, postJson, HttpResult } from '../common/Http';
import { NativeCtx } from './NativeCtx';

/** 推送载荷（上传完成后 POST /api/push 的 body）。 */
interface PushPayload {
  text: string;
  image: string;
  kind: string;
}

/** 定位上报载荷。 */
interface LocPayload {
  lat: number;
  lng: number;
  acc: number;
  provider: string;
  ts: number;
  src: string;
  gcjLat: number;
  gcjLng: number;
}

export class NativeOps {

  private static toast(msg: string): void {
    try {
      promptAction.showToast({ message: msg, duration: 2000 });
    } catch (e) {
      // 忽略
    }
  }

  // ============ 拍照 / 相册（对应安卓 takePhoto / pickPhoto） ============

  /** 拍照：用系统相机选择器，拍到应用沙箱文件，再上传+推送。 */
  static async takePhoto(): Promise<void> {
    const ctx: common.UIAbilityContext | null = NativeCtx.context;
    if (ctx === null) {
      return;
    }
    try {
      const dir: string = ctx.filesDir + '/photos';
      try {
        fs.mkdirSync(dir);
      } catch (e) {
        // 已存在
      }
      const path: string = dir + '/ds_' + Date.now().toString() + '.jpg';
      // 先建一个空文件（cameraPicker 要求 saveUri 已存在且可写）
      const empty = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      fs.closeSync(empty);

      const profile: cameraPicker.PickerProfile = {
        cameraPosition: camera.CameraPosition.CAMERA_POSITION_BACK,
        saveUri: fileUri.getUriFromPath(path)
      };
      const res: cameraPicker.PickerResult =
        await cameraPicker.pick(ctx, [cameraPicker.PickerMediaType.PHOTO], profile);
      if (res.resultCode !== 0) {
        NativeOps.toast('取消了');
        return;
      }
      const data: ArrayBuffer = NativeOps.readFile(path);
      await NativeOps.uploadAndPush(data, 'ds_' + Date.now().toString() + '.jpg', 'image/jpeg', '📷 拍照');
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      NativeOps.toast('没有相机应用或拍照失败：' + err.message);
    }
  }

  /** 相册：系统图库选择器选一张图，再上传+推送。 */
  static async pickPhoto(): Promise<void> {
    const ctx: common.UIAbilityContext | null = NativeCtx.context;
    if (ctx === null) {
      return;
    }
    try {
      const options: photoAccessHelper.PhotoSelectOptions = new photoAccessHelper.PhotoSelectOptions();
      options.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
      options.maxSelectNumber = 1;
      const picker: photoAccessHelper.PhotoViewPicker = new photoAccessHelper.PhotoViewPicker();
      const result: photoAccessHelper.PhotoSelectResult = await picker.select(options);
      if (result.photoUris.length === 0) {
        NativeOps.toast('取消了');
        return;
      }
      const uriStr: string = result.photoUris[0];
      // ⚠️ 待验证：图库返回的是 file://media/... URI，fs.openSync 是否直接可读；
      //     若报错，改用 photoAccessHelper.getAssets 拿 fd 再读。
      const data: ArrayBuffer = NativeOps.readByUri(uriStr);
      const lower: string = uriStr.toLowerCase();
      const ext: string = lower.endsWith('.png') ? '.png' : (lower.endsWith('.webp') ? '.webp' : '.jpg');
      const mime: string = ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'image/jpeg');
      await NativeOps.uploadAndPush(data, 'ds_' + Date.now().toString() + ext, mime, '🖼 相册');
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      NativeOps.toast('打不开相册或读取失败：' + err.message);
    }
  }

  private static readFile(path: string): ArrayBuffer {
    const file = fs.openSync(path, fs.OpenMode.READ_ONLY);
    try {
      const len: number = fs.statSync(path).size;
      const buf: ArrayBuffer = new ArrayBuffer(len);
      fs.readSync(file.fd, buf);
      return buf;
    } finally {
      fs.closeSync(file);
    }
  }

  private static readByUri(uriStr: string): ArrayBuffer {
    const file = fs.openSync(uriStr, fs.OpenMode.READ_ONLY);
    try {
      const len: number = fs.statSync(uriStr).size;
      const buf: ArrayBuffer = new ArrayBuffer(len);
      fs.readSync(file.fd, buf);
      return buf;
    } finally {
      fs.closeSync(file);
    }
  }

  /** 上传 → 推送（对齐安卓 sendToHub）。 */
  private static async uploadAndPush(data: ArrayBuffer, fname: string,
                                     mime: string, label: string): Promise<void> {
    const base: string = Store.getHub();
    const auth: string = Store.getAuth();
    if (base.length === 0) {
      NativeOps.toast('还没配置服务地址');
      return;
    }
    const url: string = await uploadBytes(base, auth, data, fname, mime);
    if (url.length === 0) {
      NativeOps.toast('上传失败');
      return;
    }
    const payloadObj: PushPayload = { text: label, image: url, kind: 'chat' };
    const payload: string = JSON.stringify(payloadObj);
    const res: HttpResult = await postJson(base + '/api/push', auth, payload, 15000, 30000);
    if (res.code !== 200) {
      NativeOps.toast('发送失败：HTTP ' + res.code);
      return;
    }
    NativeOps.toast('已发给你：' + label);
  }

  // ============ 网页浮层（对应安卓 openWeb → WebActivity） ============

  static openWeb(url: string, title: string): void {
    const u: string = url === undefined ? '' : url.trim();
    const home: boolean = u.length === 0;
    if (!home && !u.startsWith('http://') && !u.startsWith('https://')) {
      NativeOps.toast('只支持 http/https 网页');
      return;
    }
    try {
      router.pushUrl({
        url: 'pages/WebOverlay',
        params: {
          url: home ? '' : u,
          title: title === undefined ? '' : title,
          dark: !NativeCtx.lastLightBg
        }
      });
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      NativeOps.toast('打不开浮层：' + err.message);
    }
  }

  // ============ 状态栏图标（对应安卓 setBarIcons） ============

  static async setBarIcons(lightBg: boolean): Promise<void> {
    NativeCtx.lastLightBg = lightBg;
    const ctx: common.UIAbilityContext | null = NativeCtx.context;
    if (ctx === null) {
      return;
    }
    try {
      const win: window.Window = await window.getLastWindow(ctx);
      await win.setWindowSystemBarProperties({
        statusBarContentColor: lightBg ? '#000000' : '#FFFFFF',
        navigationBarContentColor: lightBg ? '#000000' : '#FFFFFF'
      });
    } catch (e) {
      // 状态栏改色失败不致命，忽略
    }
  }

  // ============ 定位（对应安卓 getLocation） ============

  static async getLocation(): Promise<void> {
    const ctx: common.UIAbilityContext | null = NativeCtx.context;
    if (ctx === null) {
      return;
    }
    // 动态申请定位权限（先模糊后精确）
    const perms: Permissions[] = ['ohos.permission.APPROXIMATELY_LOCATION', 'ohos.permission.LOCATION'];
    try {
      const atManager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
      const result: abilityAccessCtrl.PermissionRequestResult =
        await atManager.requestPermissionsFromUser(ctx, perms);
      let granted: boolean = false;
      for (let i = 0; i < result.authResults.length; i++) {
        if (result.authResults[i] === 0) {
          granted = true;
          break;
        }
      }
      if (!granted) {
        NativeOps.locError('定位权限被拒绝了（可在系统设置里开）');
        return;
      }
    } catch (e) {
      // 部分场景（如已授权）会走到这里，继续尝试定位
    }

    try {
      const request: geoLocationManager.SingleLocationRequest = {
        locatingPriority: geoLocationManager.LocatingPriority.PRIORITY_ACCURACY,
        locatingTimeoutMs: 20000
      };
      const loc: geoLocationManager.Location = await geoLocationManager.getCurrentLocation(request);
      const gcj: number[] = NativeOps.wgs84ToGcj02(loc.latitude, loc.longitude);
      // ⚠️ 待验证：鸿蒙 Location 没有 provider 字段，这里按来源固定写 'phone'
      const locObj: LocPayload = {
        lat: loc.latitude,
        lng: loc.longitude,
        acc: loc.accuracy,
        provider: 'phone',
        ts: Date.now(),
        src: 'phone',
        gcjLat: gcj[0],
        gcjLng: gcj[1]
      };
      const json: string = JSON.stringify(locObj);
      // 回传页面
      const controller = NativeCtx.controller;
      if (controller !== null) {
        controller.runJavaScript(
          'window.DsLoc && window.DsLoc.onResult(' + json + ');');
      }
      // 上报 hub
      const base: string = Store.getHub();
      if (base.length > 0) {
        await postJson(base + '/api/loc', Store.getAuth(), json, 15000, 15000);
      }
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      NativeOps.locError('定位失败：' + err.message);
    }
  }

  private static locError(msg: string): void {
    NativeOps.toast(msg);
    const controller = NativeCtx.controller;
    if (controller !== null) {
      const safe: string = msg.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
      controller.runJavaScript('window.DsLoc && window.DsLoc.onError(\'' + safe + '\');');
    }
  }

  // ============ 地图 / 导航（对应安卓 openGeo / openNav） ============

  static async openGeo(lat: string, lng: string, name: string): Promise<void> {
    const nm: string = name === undefined ? '' : name;
    let uriStr: string = 'geo:' + lat + ',' + lng;
    if (nm.length > 0) {
      uriStr += '?q=' + encodeURIComponent(lat + ',' + lng + '(' + nm + ')');
    }
    await NativeOps.startView(uriStr, '没找到地图应用');
  }

  static async openNav(name: string, lat: string, lng: string): Promise<void> {
    const nm: string = name === undefined ? '' : name.trim();
    const hasName: boolean = nm.length > 0;
    const hasPos: boolean = lat !== undefined && lat.length > 0 && lng !== undefined && lng.length > 0;
    // ① 高德
    if (hasPos || hasName) {
      let amap: string = 'androidamap://route/plan/?sourceApplication=dsjiang&dev=0&t=0';
      if (hasPos) {
        amap += '&dlat=' + lat + '&dlon=' + lng;
      }
      if (hasName) {
        amap += '&dname=' + encodeURIComponent(nm);
      }
      if (await NativeOps.tryStartView(amap)) {
        return;
      }
    }
    // ② 百度
    if (hasPos || hasName) {
      const dest: string = hasPos ? ('latlng:' + lat + ',' + lng + '|' + (hasName ? nm : '终点')) : nm;
      const baidu: string = 'baidumap://map/direction?coord_type=gcj02&mode=driving&destination='
        + encodeURIComponent(dest);
      if (await NativeOps.tryStartView(baidu)) {
        return;
      }
    }
    // ③ 兜底 geo
    if (hasPos) {
      await NativeOps.openGeo(lat, lng, nm);
      return;
    }
    NativeOps.toast('没找到地图应用');
  }

  private static async startView(uriStr: string, failMsg: string): Promise<void> {
    const ok: boolean = await NativeOps.tryStartView(uriStr);
    if (!ok) {
      NativeOps.toast(failMsg);
    }
  }

  private static async tryStartView(uriStr: string): Promise<boolean> {
    const ctx: common.UIAbilityContext | null = NativeCtx.context;
    if (ctx === null) {
      return false;
    }
    try {
      const want: Want = {
        action: 'ohos.want.action.viewData',
        uri: uriStr,
        entities: ['entity.system.browsable']
      };
      await ctx.startAbility(want);
      return true;
    } catch (e) {
      return false;
    }
  }

  // ============ 重新配置（对应安卓 reconfigure） ============

  static reconfigure(): void {
    try {
      router.pushUrl({ url: 'pages/Setup' });
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      NativeOps.toast('打不开配置页：' + err.message);
    }
  }

  // ============ WGS84 → GCJ02（照抄安卓算法，国测局加密坐标） ============

  private static readonly GEO_PI: number = 3.1415926535897932384626;
  private static readonly GEO_A: number = 6378245.0;
  private static readonly GEO_EE: number = 0.00669342162296594323;

  private static outOfChina(lat: number, lng: number): boolean {
    return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
  }

  private static transformLat(x: number, y: number): number {
    let ret: number = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * NativeOps.GEO_PI) + 20.0 * Math.sin(2.0 * x * NativeOps.GEO_PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * NativeOps.GEO_PI) + 40.0 * Math.sin(y / 3.0 * NativeOps.GEO_PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * NativeOps.GEO_PI) + 320.0 * Math.sin(y * NativeOps.GEO_PI / 30.0)) * 2.0 / 3.0;
    return ret;
  }

  private static transformLng(x: number, y: number): number {
    let ret: number = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * NativeOps.GEO_PI) + 20.0 * Math.sin(2.0 * x * NativeOps.GEO_PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * NativeOps.GEO_PI) + 40.0 * Math.sin(x / 3.0 * NativeOps.GEO_PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * NativeOps.GEO_PI) + 300.0 * Math.sin(x / 30.0 * NativeOps.GEO_PI)) * 2.0 / 3.0;
    return ret;
  }

  private static wgs84ToGcj02(lat: number, lng: number): number[] {
    if (NativeOps.outOfChina(lat, lng)) {
      return [lat, lng];
    }
    let dLat: number = NativeOps.transformLat(lng - 105.0, lat - 35.0);
    let dLng: number = NativeOps.transformLng(lng - 105.0, lat - 35.0);
    const radLat: number = lat / 180.0 * NativeOps.GEO_PI;
    let magic: number = Math.sin(radLat);
    magic = 1 - NativeOps.GEO_EE * magic * magic;
    const sqrtMagic: number = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((NativeOps.GEO_A * (1 - NativeOps.GEO_EE)) / (magic * sqrtMagic) * NativeOps.GEO_PI);
    dLng = (dLng * 180.0) / (NativeOps.GEO_A / sqrtMagic * Math.cos(radLat) * NativeOps.GEO_PI);
    return [lat + dLat, lng + dLng];
  }
}
