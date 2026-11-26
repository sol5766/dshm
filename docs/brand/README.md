# DSHM 品牌资源

| 文件 | 用途 | 尺寸 |
|---|---|---|
| `app-icon-512.png` | README 顶部展示图；由 `AppScope` 的分层图标（`background` + `foreground`）合成，与安装后的桌面图标同图 | 512 |
| `dshm-icon-1024.svg` | 应用图标的矢量描摹版（背景 / 前景两组渐变），缩放与排版用 | 1024 |

`app-icon-512.png` 的重放方式（源件随仓库走，不依赖 `third_party/`）：

```bash
python3 -c "from PIL import Image as I;bg=I.open('AppScope/resources/base/media/background.png').convert('RGBA');fg=I.open('AppScope/resources/base/media/foreground.png').convert('RGBA');I.alpha_composite(bg,fg).convert('RGB').resize((512,512),I.LANCZOS).save('docs/brand/app-icon-512.png',optimize=True)"
```

换图标时先改 `AppScope/`（并同步 `entry/`、`phone/`），再跑这一行刷新 README 展示图。

## 应用图标本体

图标直接写在 HarmonyOS 资源目录，不在这里：

| 路径 | 说明 |
|---|---|
| `AppScope/resources/base/media/{background,foreground}.png` | 分层图标的两层（系统自己加遮罩） |
| `entry/src/main/resources/base/media/{background,foreground}.png` | 必须与 `AppScope` **逐字节一致**，否则不同入口显示不同图标 |
| `phone/src/main/resources/...` 同上一整组 | 手机 HAP 是**另一套资源目录**，同样要求逐字节一致 |
| `entry/src/main/resources/base/media/startIcon.png` | 启动窗口图标（512，透明底） |
| `entry/src/main/resources/base/media/logo_dark.png` | 启动页大标识（512，透明底，与 `startIcon` 同图） |
| `entry|phone/src/main/resources/rawfile/common/dshm_agent_icon.png` | A2A 智能体图标（512 透明底） |
| `entry/src/main/resources/rawfile/{tray_white,tray_black}.png` | 系统托盘（状态栏）图标，72px **单色剪影**（白 / 黑） |

**托盘必须是单色剪影**：`statusBarManager.StatusBarIcon` 要求同一图案给两份（white / black），
由系统按状态栏明暗二选一，因此不能是彩色图。

三端资源的一致性与应用名在各处的正确性，由 `node tools/check-brand-surface.mjs` 强制
（它用 `BRAND_NAME` 断言品牌垫片确实显示了产品名，并把已弃用品牌名列为禁用词）。
