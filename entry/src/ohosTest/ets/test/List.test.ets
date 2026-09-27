/**
 * List.test.ets —— ohosTest 用例总入口。
 */

import connectionTest from './Connection.test';
import trajectoryProjectionTest from './Trajectory.test';
import settingsProjectionTest from './Settings.test';
import muxProbeTest from './MuxProbe.test';
import liveWireTest from './LiveWire.test';
import onDeviceProbeTest from './OnDeviceProbe.test';
import coreDecisionTest from './CoreDecision.test';

export default function testsuite() {
  connectionTest();
  trajectoryProjectionTest();
  settingsProjectionTest();
  muxProbeTest();
  liveWireTest();
  // 设备侧架构探针（P5）：沙箱符号链接能力 + 同进程回环可达性。见 OnDeviceProbe.test.ets
  onDeviceProbeTest();
  // 判据类纯函数（核心版本激活/回滚/清理、插件三态、诊断分流、空态分档）
  coreDecisionTest();
}
