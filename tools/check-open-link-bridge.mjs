#!/usr/bin/env node
/**
 * 门禁：「外开桥」三侧接线必须逐字一致（2026-10-17，browser 工具"浏览器没启动时直接拉起"）。
 *
 * 【为什么需要它】这条链跨三个各自独立维护的文件，靠**同名约定**串起来：
 *   ① Host（`hostcore/app/main.js` 的 `/dshm-open-link`）写 `$DSH_HOME/open-link/<id>.req`
 *      —— 目录名 / 后缀 / 载荷形状 / 原子改名，全是对外契约；
 *   ② ArkTS 壳（`entry/src/main/ets/system/OpenLinkBridge.ets`）轮询同一个目录，写回
 *      `.done` / `.fail`，并真的调用 `openExternalUrl`；
 *   ③ 插件（`hostcore/plugins/dshm-tool-browser/lib/index.js`）在没有客户端时请求
 *      `/dshm-open-link`，然后轮询 `/dshm-browser/status` 等扩展回连。
 *
 * 本仓对这类跨侧字符串有**真实事故**背书的教训（`HostEvents.ets` 头注原文：
 * "两边各写一份数字 id 的后果是：改了一边、另一边不报错，只是**永远收不到通知**"）。
 * 所以这里把三侧的目录名 / 后缀 / 端点路径全部钉住 —— 静默不一致一律判红。
 *
 * 【对照臂（必修）】脚本自带 4 个内存变异：改壳层目录名 / 改 Host 的 `.done` 后缀 /
 * 摘掉 EntryAbility 的启动行 / 摘掉插件的 ensureClient 调用 —— 每一个都必须判红，
 * 否则这条门禁就是恒真摆设。
 */
import { readFileSync } from 'node:fs';

const HOST_FILE = 'hostcore/app/main.js';
const ENTRY_FILE = 'entry/src/main/ets/entryability/EntryAbility.ets';
const BRIDGE_FILE = 'entry/src/main/ets/system/OpenLinkBridge.ets';
const PLUGIN_FILE = 'hostcore/plugins/dshm-tool-browser/lib/index.js';
/* 2026-10-28 扩：网页侧那条链（垫片点击接管 + 原生 onLoadIntercept）也要钉住 ——
   "链接不跳浏览器"就是从这两处漏出来的。 */
const WEBAPP_FILE = 'entry/src/main/ets/pages/WebApp.ets';

/** 对一组源码文本跑全部判据；返回 {pass, fail, notes}。 */
function inspect(files) {
  const notes = [];
  let pass = 0;
  let fail = 0;
  const ok = (cond, msg) => {
    if (cond) { pass++; notes.push('  PASS  ' + msg); } else { fail++; notes.push('  FAIL  ' + msg); }
  };
  const host = files.host;
  const entry = files.entry;
  const bridge = files.bridge;
  const plugin = files.plugin;
  const webapp = files.webapp;
  /* 反引号用 fromCharCode 取，免得本判据自己把源码搅乱 */
  const TICK = String.fromCharCode(96);

  // ── ① Host 侧端点与文件契约 ──
  ok(host.includes("path: '/dshm-open-link'"), 'Host：注册了 /dshm-open-link 端点');
  ok(host.includes("const QUEUE_DIR_NAME = 'open-link';"), 'Host：队列目录名 = open-link（与壳层同值）');
  ok(host.includes('`${id}.req`') && host.includes('`${id}.done`') && host.includes('`${id}.fail`'),
    'Host：读写 .req / .done / .fail 三种后缀');
  ok(host.includes("`${id}.wreq`"), 'Host：请求先写 .wreq 临时名再改名（原子落位）');
  ok(host.includes('!/^https?:\\/\\//i.test(target)'), 'Host：只放行 http(s) 绝对地址');
  ok(host.includes("url.searchParams.get('bundle')") && host.includes('bundle 形态不合法'),
    'Host：接受并校验可选 bundle（目标浏览器）');
  ok(host.includes('{ bundle }'), 'Host：bundle 真的写进 .req 载荷');
  ok(host.includes("stage('BOOT_62C_OPEN_LINK'"), 'Host：端点注册有 BOOT_62C 阶段读数');
  ok(host.includes('registerOpenLinkEndpoint(ctx, browserBridge && browserBridge.armAutoClose);'),
    'Host：boot 链真的调了 registerOpenLinkEndpoint（并把 armAutoClose 交给它）');
  ok(host.includes('pyBridgeTokenOk(url)'), 'Host：端点走 host token 鉴权（与其它 /dshm-* 同源）');

  // ── ② ArkTS 壳层：同目录 / 同后缀 / 真调 openExternalUrl / 真被启动 ──
  ok(bridge.includes('const queueDir: string = `${filesDir}/dsh/home/open-link`;'),
    '壳层：队列目录 = <filesDir>/dsh/home/open-link（与 $DSH_HOME 同视图；判据打在代码行，不是头注）');
  ok(bridge.includes("n.endsWith('.req')") && bridge.includes("failed ? '.fail' : '.done'"),
    '壳层：消费 .req、写回 .done/.fail（后缀与 Host 同值）');
  ok(bridge.includes('openExternalUrl(req.url, abilityCtx)'),
    '壳层：真的调用 openExternalUrl（显式传 abilityCtx —— onCreate 语境下 getContext() 不可靠）');
  ok(bridge.includes('startBrowserBundle(req.bundle, req.url, abilityCtx)'),
    '壳层：带 bundle 时优先显式 startAbility 拉起目标浏览器');
  ok(bridge.includes("action: 'ohos.want.action.viewData'") && bridge.includes("entities: ['entity.system.browsable']"),
    '壳层：startAbility 的 Want 用 viewData + browsable（不钉 abilityName）');
  ok(bridge.includes('isOpenableUrl(url)'), '壳层：二次校验只放行 http(s)');
  ok(bridge.includes('reapStale(queueDir, names)') && bridge.includes("n.endsWith('.req') || n.endsWith('.wip')"),
    '壳层：陈旧回收**包含 .req**（半截请求堵死队列的语音桥实证）');
  ok(entry.includes("startOpenLinkBridge(this.context.filesDir, this.context);"),
    'EntryAbility：常驻启动外开桥（filesDir + 显式 context）');

  // ── ③ 插件侧：请求端点 + 等回连 ──
  ok(plugin.includes('/dshm-open-link?token='), '插件：请求 /dshm-open-link（带 token）');
  ok(plugin.includes("DSHM_BROWSER_BUNDLE || 'com.haitai.htbrowser'") && plugin.includes('&bundle=${encodeURIComponent(PREFERRED_BROWSER_BUNDLE)}'),
    '插件：请求带上优先浏览器 bundle（默认海泰，可 env 覆盖）');
  ok(plugin.includes('/dshm-browser/status'), '插件：轮询 /dshm-browser/status 等扩展回连');
  ok(plugin.includes('const ensured = await ensureClient(url);'),
    '插件：browser_navigate 在执行前真的走 ensureClient（浏览器没起就拉起）');

  /* ── G. 网页侧"链接外开"（2026-10-28 真机反馈"链接不会跳转浏览器"）───────
   * 两个漏点：垫片只认 target=_blank；Web 组件没有 onLoadIntercept（外部页会在
   * 应用自己的 WebView 里打开 —— 授权页更会按 204 空页把界面替掉）。 */
  {
    /* 锚在**声明**上：裸名字在注释里出现过多次（第 73 行「见 OPEN_LINK_SHIM_JS」），
       用裸名字会从注释切到**别的垫片**的终止符，把别人的反引号算进来（本轮踩到）。 */
    const decl = webapp.indexOf('const OPEN_LINK_SHIM_JS: string = ');
    /* 从**开定界符之后**切：否则第一个反引号就是模板自己的开引号（本轮踩到）。 */
    const openTick = decl >= 0 ? webapp.indexOf(TICK, decl) : -1;
    const shimEnd = openTick >= 0 ? webapp.indexOf('})();' + TICK, openTick) : -1;
    const shimBody = openTick >= 0 && shimEnd > openTick
      ? webapp.slice(openTick + 1, shimEnd) : '';
    ok(shimBody.length > 0, 'G0 能切出 OPEN_LINK 垫片体（切不出说明模板定界被改坏）');
    /* 这条是本轮的真实教训：我在垫片注释里写了反引号，编译期才会炸。 */
    ok(shimBody.indexOf(TICK) < 0,
      'G0 垫片体内无第二个反引号（会被当模板定界 ⇒ ArkTS 提前闭合，编译期才炸）');
  }
  ok(!webapp.includes("getAttribute('target') !== '_blank'"),
    'G1 垫片不再只认 target=_blank（普通 Markdown 链接也必须接管）');
  ok(webapp.includes('isSameOriginAsApp(href)') && webapp.includes('function isSameOriginAsApp('),
    'G2 垫片有同源判据（否则会把应用自身页面的导航也拦成外开）');
  ok(webapp.includes('private isExternalNavigation(url: string): boolean'),
    'G3 原生侧有"是不是外链"的纯判据函数');
  ok(webapp.includes('.onLoadIntercept((event: OnLoadInterceptEvent): boolean =>')
    && webapp.includes('event.data.getRequestUrl()'),
    'G4 Web 组件挂了 onLoadIntercept，并取真实请求 URL');
  /*
   * G8 必须区分主帧/子帧（2026-10-29 复审）：onLoadIntercept 对**所有导航**触发（含
   * iframe src）。不判 isMainFrame ⇒ 聊天内容里的外部 iframe 会在**无用户交互**时
   * 自动弹系统浏览器。子帧外链同样要拦（不许嵌进应用 WebView），但**不外开**。
   */
  ok(webapp.includes('event.data.isMainFrame()'),
    'G8 onLoadIntercept 判断了 isMainFrame（子帧导航不自动外开浏览器）');
  ok(webapp.includes('              return true;\n            } catch (e) {'),
    'G5 外链导航被拦下（返回 true ⇒ 不在应用内打开外部页）');
  ok(webapp.includes('openExternalUrl(target)'),
    'G6 拦下后真的交系统浏览器');
  /*
   * G7 主机名必须**精确**匹配，不许前缀（2026-10-29 审出来的真绕过）：
   * `startsWith('127.0.0.1')` 会把 `127.0.0.1.evil.com` / `localhost.attacker.net`
   * 判成"应用自身" ⇒ 外站被放行、在应用 WebView 里打开；`127.0.0.1@evil.com`
   * 里 @ 前是 userinfo，真主机是 evil.com。故判据必须是全等比较。
   */
  ok(!webapp.includes("host.startsWith('127.0.0.1')")
    && !webapp.includes("host.startsWith('localhost')"),
    'G7 主机名不许用 startsWith 前缀匹配（会被 127.0.0.1.evil.com 之类绕过）');
  ok(webapp.includes("host === '127.0.0.1'") && webapp.includes("host === 'localhost'"),
    'G7 主机名按全等匹配回环地址');
  ok(webapp.includes("authority.split('@').pop()"),
    'G7 先剥掉 userinfo 再判主机（127.0.0.1@evil.com 的真主机是 evil.com）');

  return { pass, fail, notes };
}

const files = {
  host: readFileSync(HOST_FILE, 'utf8'),
  entry: readFileSync(ENTRY_FILE, 'utf8'),
  bridge: readFileSync(BRIDGE_FILE, 'utf8'),
  plugin: readFileSync(PLUGIN_FILE, 'utf8'),
  webapp: readFileSync(WEBAPP_FILE, 'utf8'),
};

console.log('== 主体：外开桥三侧接线 ==');
const main = inspect(files);
for (const line of main.notes) console.log(line);
console.log(`  小计：${main.pass} passed / ${main.fail} failed`);

let failed = main.fail > 0;

// ── 对照臂：每个变异体必须判红 ───────────────────────────────────────────────
const arms = [
  {
    name: 'A：壳层队列目录改名（代码行 open-link → openlink2）',
    files: {
      ...files,
      bridge: files.bridge.replace(
        'const queueDir: string = `${filesDir}/dsh/home/open-link`;',
        'const queueDir: string = `${filesDir}/dsh/home/openlink2`;',
      ),
    },
  },
  {
    name: "B：Host 的回执后缀 .done 改成 .ok（壳层仍写 .done ⇒ 永远收不到）",
    files: { ...files, host: files.host.replace('`${id}.done`', '`${id}.ok`') },
  },
  {
    name: 'C：摘掉 EntryAbility 的 startOpenLinkBridge 启动行（桥永不轮询）',
    files: { ...files, entry: files.entry.replace('startOpenLinkBridge(this.context.filesDir, this.context);', '// removed') },
  },
  {
    name: 'D：摘掉插件的 ensureClient 调用（浏览器没起时不再拉起）',
    files: { ...files, plugin: files.plugin.replace('const ensured = await ensureClient(url);', '// removed') },
  },
  {
    name: "E：壳层的 startAbility action 改成 home（打不开目标 URL ⇒ 拉起的是首页/别的对象）",
    files: { ...files, bridge: files.bridge.replace("action: 'ohos.want.action.viewData'", "action: 'action.system.home'") },
  },
  {
    name: 'F：插件不再带 bundle（只拉系统默认浏览器 ⇒ 扩展不回连）',
    files: { ...files, plugin: files.plugin.replace('&bundle=${encodeURIComponent(PREFERRED_BROWSER_BUNDLE)}', '') },
  },
];

arms.push(
  {
    name: 'G：把"只认 target=_blank"的判据塞回来（正文链接又不跳浏览器了）',
    files: { ...files, webapp: files.webapp.replace('        if (isSameOriginAsApp(href)) { return; }',
      "        if (anchor.getAttribute('target') !== '_blank') { return; }") },
  },
  {
    name: 'H：摘掉 onLoadIntercept（外部页会加载进应用自己的 WebView）',
    files: { ...files, webapp: files.webapp.replace('.onLoadIntercept((event: OnLoadInterceptEvent)',
      '// removed onLoadIntercept(') },
  },
  {
    name: 'I：把"拦下外链"改成放行（返回 false ⇒ 又在应用内打开）',
    files: { ...files, webapp: files.webapp.replace(
      '              return true;\n            } catch (e) {',
      '              return false;\n            } catch (e) {') },
  },
  {
    name: 'L：去掉 isMainFrame 判断（外部 iframe 会无交互自动弹浏览器）',
    files: { ...files, webapp: files.webapp.replace('              if (!event.data.isMainFrame()) {\n                hilog.info(DOMAIN, TAG, \'拦下子帧外链导航（不外开）：%{public}s\', target);\n                return true;\n              }\n', '') },
  },
  {
    name: 'K：主机名退回前缀匹配（127.0.0.1.evil.com 会被当成应用自身放行）',
    files: { ...files, webapp: files.webapp
      .replace("host === '127.0.0.1'", "host.startsWith('127.0.0.1')")
      .replace("host === 'localhost'", "host.startsWith('localhost')") },
  },
  {
    name: 'J：垫片体内出现反引号（ArkTS 模板提前闭合，编译期才炸）',
    files: { ...files, webapp: files.webapp.replace('  function isSameOriginAsApp(url) {',
      '  function isSameOriginAsApp(url) { /* ' + String.fromCharCode(96) + 'x'
      + String.fromCharCode(96) + ' */') },
  },
);

for (const arm of arms) {
  const mutated = inspect(arm.files);
  const red = mutated.fail > 0;
  console.log(`\n== 对照臂 ${arm.name} ==`);
  console.log(`  变异体：${mutated.pass} passed / ${mutated.fail} failed（期望 failed > 0）`);
  if (!red) {
    console.log('  FAIL  变异体竟然全绿 => 该判据是恒真摆设，必须修');
    failed = true;
  } else {
    console.log('  PASS  变异体如期变红 => 判据有牙');
  }
}

console.log('\nRESULT: ' + (failed ? 'FAIL' : 'PASS')
  + ` —— 主体 ${main.pass}/${main.fail}，对照臂 ${arms.length} 组`);
process.exit(failed ? 1 : 0);
