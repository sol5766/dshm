/**
 * 判据类纯函数的用例（hostruntime 的核心版本决策 + appstate 的核心/诊断契约）。
 *
 * 【为什么优先测这些】它们全都是**判据**：什么情况下敢把一个核心版本设为当前、
 * 什么情况下必须回滚、哪些目录永远不能删、"未知"该不该算"可安装"、
 * 本地核心模式下该显示哪几项诊断。这些判断一旦写错，症状是"应用看起来正常但做了错事"
 * ——比崩溃更难发现。而它们都是纯函数，不需要设备就能钉死。
 */

import { describe, expect, it } from '@ohos/hypium';
import {
  ActivationAction,
  CoreHealth,
  CoreState,
  emptyState,
  evictionCandidates,
  isSafeVersion,
  parseArchiveName,
  parseState,
  serializeState,
  topDirOf,
  buildHostArgv,
  buildHostEnv,
  isWellFormedEnvPair,
  decideActivation,
  decideRollback,
  compareVersions,
  newestVersion
} from 'hostruntime';
import {
  CorePhase,
  DiagMode,
  PluginNative,
  classifyPlugin,
  corePhaseOfHostState,
  diagModeOf,
  filterDiagEntries,
  pluginNativeOf,
  sessionEmptyCopy
} from 'appstate';
import type { DiagEntry, PluginRow } from 'appstate';

function entry(name: string): DiagEntry {
  return { name: name, passed: true, detail: '', advice: '' };
}

export default function coreDecisionTest() {
  describe('CoreDecision', () => {

    // ── 激活事务：只有健康检查通过才敢切当前版本 ────────────────────────
    it('refuses_activation_when_health_not_pass', 0, () => {
      const s: CoreState = emptyState();
      const d = decideActivation(s, '1.0.0', CoreHealth.UNKNOWN, '未检查');
      expect(d.action).assertEqual(ActivationAction.REFUSE);
      // 关键不变式：拒绝时**不许改动状态**（尤其不能把 current 写成候选）
      expect(d.next.current).assertEqual('');
    });

    it('refuses_activation_on_empty_candidate', 0, () => {
      const s: CoreState = { current: '1.0.0', previous: '', history: ['1.0.0'] };
      const d = decideActivation(s, '', CoreHealth.PASS, '');
      expect(d.action).assertEqual(ActivationAction.REFUSE);
      expect(d.next.current).assertEqual('1.0.0');
    });

    it('activates_and_keeps_previous', 0, () => {
      const s: CoreState = { current: '1.0.0', previous: '', history: ['1.0.0'] };
      const d = decideActivation(s, '1.1.0', CoreHealth.PASS, '');
      expect(d.action).assertEqual(ActivationAction.ACTIVATE);
      expect(d.next.current).assertEqual('1.1.0');
      // previous 必须成为回滚目标
      expect(d.next.previous).assertEqual('1.0.0');
      expect(d.next.history[0]).assertEqual('1.1.0');
    });

    it('activation_is_idempotent_for_current', 0, () => {
      const s: CoreState = { current: '1.1.0', previous: '1.0.0', history: ['1.1.0', '1.0.0'] };
      const d = decideActivation(s, '1.1.0', CoreHealth.PASS, '');
      expect(d.action).assertEqual(ActivationAction.ACTIVATE);
      // 幂等：previous 不能被自己顶掉
      expect(d.next.previous).assertEqual('1.0.0');
    });

    // ── 回滚 ────────────────────────────────────────────────────────────
    it('refuses_rollback_without_previous', 0, () => {
      const s: CoreState = { current: '1.0.0', previous: '', history: ['1.0.0'] };
      expect(decideRollback(s, ['1.0.0']).action).assertEqual(ActivationAction.REFUSE);
    });

    it('refuses_rollback_when_previous_dir_missing', 0, () => {
      const s: CoreState = { current: '1.1.0', previous: '1.0.0', history: ['1.1.0', '1.0.0'] };
      // 上一版目录已被删 ⇒ 绝不能把 current 指向一个不存在的版本
      const d = decideRollback(s, ['1.1.0']);
      expect(d.action).assertEqual(ActivationAction.REFUSE);
      expect(d.next.current).assertEqual('1.1.0');
    });

    it('rolls_back_and_swaps_previous', 0, () => {
      const s: CoreState = { current: '1.1.0', previous: '1.0.0', history: ['1.1.0', '1.0.0'] };
      const d = decideRollback(s, ['1.1.0', '1.0.0']);
      expect(d.action).assertEqual(ActivationAction.ROLLBACK);
      expect(d.next.current).assertEqual('1.0.0');
      expect(d.next.previous).assertEqual('1.1.0');
    });

    // ── 清理：当前版与上一版永远不能删 ──────────────────────────────────
    it('never_evicts_current_or_previous', 0, () => {
      const s: CoreState = { current: '1.1.0', previous: '1.0.0', history: ['1.1.0', '1.0.0', '0.9.0'] };
      const doomed = evictionCandidates(s, ['1.1.0', '1.0.0', '0.9.0'], 0);
      expect(doomed.includes('1.1.0')).assertFalse();
      expect(doomed.includes('1.0.0')).assertFalse();
      expect(doomed.includes('0.9.0')).assertTrue();
    });

    // ── 状态序列化：坏文件不能让应用起不来 ──────────────────────────────
    it('tolerates_broken_state_json', 0, () => {
      const s = parseState('{ this is not json');
      expect(s.current).assertEqual('');
      expect(s.history.length).assertEqual(0);
    });

    it('round_trips_state', 0, () => {
      const s: CoreState = { current: '2.0.0', previous: '1.0.0', history: ['2.0.0', '1.0.0'] };
      const back = parseState(serializeState(s));
      expect(back.current).assertEqual('2.0.0');
      expect(back.previous).assertEqual('1.0.0');
    });

    // ── 版本号会变成目录名：路径穿越必须显式拒绝 ────────────────────────
    it('rejects_unsafe_version_names', 0, () => {
      expect(isSafeVersion('../../etc')).assertFalse();
      expect(isSafeVersion('a/b')).assertFalse();
      expect(isSafeVersion('')).assertFalse();
      expect(isSafeVersion('1.0.0')).assertTrue();
      expect(isSafeVersion('0.1.5-rc.2')).assertTrue();
    });

    it('parses_container_name', 0, () => {
      const v = parseArchiveName('dsh-core-0.1.5-rc.2-openharmony-arm64.zip');
      expect(v).assertEqual('0.1.5-rc.2');
      // 不是本项目容器名 ⇒ 空串（不猜）
      expect(parseArchiveName('something-else.zip')).assertEqual('');
      expect(topDirOf('1.2.3')).assertEqual('dsh-core-1.2.3');
    });

    // ── 阶段映射：未知值必须保守落到"未接线" ────────────────────────────
    it('maps_unknown_host_state_conservatively', 0, () => {
      expect(corePhaseOfHostState('ready')).assertEqual(CorePhase.READY);
      expect(corePhaseOfHostState('idle')).assertEqual(CorePhase.IDLE);
      // 拼错/新增的值绝不能谎称就绪
      expect(corePhaseOfHostState('rdy')).assertEqual(CorePhase.UNWIRED);
    });

    // ── 插件三态：未知不等于可安装 ──────────────────────────────────────
    it('unknown_plugin_kind_is_not_installable', 0, () => {
      const unknown = classifyPlugin('p', '1.0.0', PluginNative.UNKNOWN);
      expect(unknown.installable).assertFalse();
      expect(unknown.badge).assertEqual('待确认');
      const pure = classifyPlugin('p', '1.0.0', PluginNative.PURE_JS);
      expect(pure.installable).assertTrue();
      const native = classifyPlugin('p', '1.0.0', PluginNative.NATIVE);
      expect(native.installable).assertFalse();
      expect(native.badge).assertEqual('需发版');
    });

    // ── 核心树清单取值 → appstate 枚举：两侧字符串故意不同名 ─────────────
    it('manifest_kind_maps_to_plugin_native', 0, () => {
      expect(pluginNativeOf('PURE_JS')).assertEqual(PluginNative.PURE_JS);
      expect(pluginNativeOf('NATIVE')).assertEqual(PluginNative.NATIVE);

      // 关键：清单里的 'PURE_JS' 与枚举取值 'pure-js' 不是同一个字符串。
      // 直接把清单取值当枚举用，会在**任何一侧改名时静默变成 UNKNOWN**（而不是编译报错），
      // 于是所有插件都被渲染成"待确认"——所以映射必须显式存在并在这里钉住。
      expect(pluginNativeOf('pure-js') === PluginNative.PURE_JS).assertFalse();
      expect(pluginNativeOf('native') === PluginNative.NATIVE).assertFalse();
      expect(pluginNativeOf('pure-js')).assertEqual(PluginNative.UNKNOWN);

      // 未知/拼错/空一律 UNKNOWN，不得谎称可安装
      expect(pluginNativeOf('')).assertEqual(PluginNative.UNKNOWN);
      expect(pluginNativeOf('PUREJS')).assertEqual(PluginNative.UNKNOWN);
    });

    // ── 清单行 → 界面行：id 与禁用态必须原样带到界面 ─────────────────────
    it('plugin_row_keeps_id_and_disabled', 0, () => {
      const row: PluginRow = classifyPlugin('@deepseek-ai/dsh-sandbox', '', PluginNative.NATIVE,
        'sandbox', true);
      expect(row.id).assertEqual('sandbox');
      expect(row.disabled).assertTrue();
      expect(row.installable).assertFalse();
      // id 缺省时不得编造：空就是空
      expect(classifyPlugin('p', '', PluginNative.PURE_JS).id).assertEqual('');
      expect(classifyPlugin('p', '', PluginNative.PURE_JS).disabled).assertFalse();
    });

    // ── Host 启动契约：argv 与 env（两端接口，写错不会报错，只会指向错的目录）──
    it('host_argv_pins_jitless_before_script', 0, () => {
      const entry: string = '/data/app/resources/resfile/host/main.js';
      const argv: string[] = buildHostArgv(entry);
      // --jitless 是"不申请 ALLOW_WRITABLE_CODE_MEMORY"的前提，不允许被漏掉
      expect(argv.includes('--jitless')).assertTrue();
      // 且必须排在脚本路径**之前**：Node 把第一个非选项参数当脚本，
      // 顺序反了就会去执行一个叫 "--jitless" 的东西
      expect(argv[0]).assertEqual('--jitless');
      expect(argv[argv.length - 1]).assertEqual(entry);
    });

    it('host_env_pairs_are_complete_and_wellformed', 0, () => {
      const env: string[] = buildHostEnv('/cores/1', '/home', '/sandbox', 3120, 'ondevice');
      // 这几项是 main.js 的实际入口契约；DSHM_HOME 缺失时它会直接 reportConfigError
      expect(env.includes('DSHM_CORE_DIR=/cores/1')).assertTrue();
      expect(env.includes('DSHM_HOME=/home')).assertTrue();
      expect(env.includes('DSHM_SANDBOX_HOME=/sandbox')).assertTrue();
      expect(env.includes('DSHM_PORT=3120')).assertTrue();
      expect(env.includes('DSHM_PROFILE=ondevice')).assertTrue();
      for (let i = 0; i < env.length; i++) {
        expect(isWellFormedEnvPair(env[i])).assertTrue();
      }
      // 判据本身：缺 "=" 或键为空一律不合法 —— 引导层据此跳过**并计数**，
      // 不允许静默忽略（被忽略的 DSHM_HOME 会让 Host 悄悄用上默认目录）
      expect(isWellFormedEnvPair('DSHM_HOME')).assertFalse();
      expect(isWellFormedEnvPair('=/x')).assertFalse();
      expect(isWellFormedEnvPair('')).assertFalse();
      expect(isWellFormedEnvPair('A=')).assertTrue();
    });

    // ── 诊断模式分流 ────────────────────────────────────────────────────
    it('diag_mode_filters_remote_only_entries', 0, () => {
      const all: DiagEntry[] = [entry('端点'), entry('TLS'), entry('认证'), entry('协议'), entry('Host')];

      // 本地核心：TLS 与认证不适用（回环 + --skip-auth）
      const local = filterDiagEntries(DiagMode.LOCAL_CORE, all);
      expect(local.length).assertEqual(3);
      for (let i = 0; i < local.length; i++) {
        expect(local[i].name === 'TLS' || local[i].name === '认证').assertFalse();
      }

      // 远程：五项全在
      expect(filterDiagEntries(DiagMode.REMOTE_HOST, all).length).assertEqual(5);
      // 未接线：没有可诊断的对象
      expect(filterDiagEntries(DiagMode.UNWIRED, all).length).assertEqual(0);
    });

    it('diag_mode_derivation', 0, () => {
      expect(diagModeOf(true, true)).assertEqual(DiagMode.LOCAL_CORE);
      expect(diagModeOf(false, true)).assertEqual(DiagMode.REMOTE_HOST);
      expect(diagModeOf(false, false)).assertEqual(DiagMode.UNWIRED);
    });

    // ── 空态文案按阶段分档：不同阶段必须给不同下一步 ────────────────────
    it('empty_copy_differs_per_phase', 0, () => {
      const unwired = sessionEmptyCopy(CorePhase.UNWIRED).title;
      const empty = sessionEmptyCopy(CorePhase.EMPTY).title;
      const failed = sessionEmptyCopy(CorePhase.FAILED).title;
      expect(unwired === empty).assertFalse();
      expect(empty === failed).assertFalse();
      // 每一档都要给出"下一步"，而不是只说"没有会话"
      expect(sessionEmptyCopy(CorePhase.UNWIRED).hint.length > 0).assertTrue();
    });

    /*
     * ── 版本比较与"该启动哪棵树"（2026-09-25 真机实证）─────────────────────
     *
     * 【为什么这几条必须钉死】真机上出现"装了 rc.2 却仍跑 rc.1"：根因是
     * `DshHost.start()` 在 `state.current` 为空时取 `installed[0]`，而
     * `listInstalled()` 返回的是**目录枚举顺序（未定义）**。修复引入
     * `newestVersion()` + `compareVersions()`，它是"启动哪棵树"的**唯一判据**
     * ⇒ 必须可单测地钉死，否则同类事故会再来一次。
     *
     * 用例覆盖的都是**会出错的地方**：纯字典序会把 `rc.10` 排在 `rc.2` 前、
     * 把 `0.1.10` 排在 `0.1.7` 前；而"预发布 < 同号正式版"（semver）也容易写反。
     */
    it('version_order_handles_prerelease_and_multidigit', 0, () => {
      // 主版本数值比较（不是字典序）
      expect(compareVersions('0.1.10', '0.1.7') > 0).assertTrue();
      expect(compareVersions('1.0.0', '0.9.9') > 0).assertTrue();
      // 预发布序号也是数值比较：rc.10 > rc.2（字典序会搞反）
      expect(compareVersions('0.1.7-rc.10', '0.1.7-rc.2') > 0).assertTrue();
      // 阶段顺序 alpha < beta < rc
      expect(compareVersions('0.1.7-beta.1', '0.1.7-alpha.9') > 0).assertTrue();
      expect(compareVersions('0.1.7-rc.1', '0.1.7-beta.9') > 0).assertTrue();
      // 同号正式版 > 预发布版（semver：0.1.7 > 0.1.7-rc.1）
      expect(compareVersions('0.1.7', '0.1.7-rc.1') > 0).assertTrue();
      expect(compareVersions('0.1.7-rc.1', '0.1.7') < 0).assertTrue();
      // 相等（自反，保证排序稳定）
      expect(compareVersions('0.1.7-rc.1', '0.1.7-rc.1')).assertEqual(0);
    });

    it('newest_version_picks_rc2_over_rc1_regardless_of_order', 0, () => {
      // 真机现场：两棵树并存，顺序由目录枚举决定 ⇒ 两种顺序都必须选 rc.2
      expect(newestVersion(['0.1.7-rc.1', '0.1.7-rc.2'])).assertEqual('0.1.7-rc.2');
      expect(newestVersion(['0.1.7-rc.2', '0.1.7-rc.1'])).assertEqual('0.1.7-rc.2');
      // 混入更老的核心线也不影响
      expect(newestVersion(['0.1.5-rc.3', '0.1.7-rc.1', '0.1.7-rc.2'])).assertEqual('0.1.7-rc.2');
      // 同号正式版胜过预发布
      expect(newestVersion(['0.1.7-rc.1', '0.1.7'])).assertEqual('0.1.7');
      // 单元素与空集的边界
      expect(newestVersion(['0.1.7-rc.1'])).assertEqual('0.1.7-rc.1');
      expect(newestVersion([])).assertEqual('');
    });
  });
}
