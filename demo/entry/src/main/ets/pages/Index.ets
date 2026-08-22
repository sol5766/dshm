import { hilog } from '@kit.PerformanceAnalysisKit';
import { common, Want } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { usbManager } from '@kit.BasicServicesKit';

import testNapi from 'libentry.so';
import { PtyTestOptions, PtyTestResult, PtyStepResult, FullSystemState, ContinuousTestOptions, ContinuousCounts, PtmxAttrResult, BatchOpenOptions, HoldOpenOptions } from 'libentry.so';

const DOMAIN = 0x0000;
const TAG = 'PTY_DIAG_UI';

// ── Test mode enum ────────────────────────────────────────────────
enum TestMode {
  IDLE = '空闲',
  NORMAL = '普通PTY测试',
  CRASH = '失败时触发Crash',
  CONTINUOUS = '连续测试',
  SHELL_CONTROL = '无PTY Shell对照测试',
  SYSTEM_STATE = '刷新系统状态'
}

// ── Log entry ─────────────────────────────────────────────────────
class LogEntry {
  timestamp: string = '';
  message: string = '';
  level: string = 'INFO';

  constructor(msg: string, level: string = 'INFO') {
    let now = new Date();
    this.timestamp = now.toISOString().replace('T', ' ').substring(0, 23);
    this.message = msg;
    this.level = level;
  }

  toString(): string {
    return `[${this.timestamp}] [${this.level}] ${this.message}`;
  }
}

// ── Main page ─────────────────────────────────────────────────────
@Entry
@Component
struct Index {
  // ── State ───────────────────────────────────────────────────────
  @State currentMode: string = TestMode.IDLE;
  @State lastResult: string = '尚未执行测试';
  @State pid: number = 0;
  @State uid: number = 0;
  @State gid: number = 0;
  @State currentTime: string = '';
  @State successCount: number = 0;
  @State failureCount: number = 0;
  @State lastErrno: number = 0;
  @State lastFailedStep: string = 'NONE';
  @State logEntries: LogEntry[] = [];
  @State continuousTaskId: number = -1;
  @State isRunning: boolean = false;
  @State continuousInterval: number = 1000; // ms
  @State readyForNextTest: boolean = true;
  @State lastTestDuration: string = '';
  @State masterFd: number = -1;
  @State slaveFd: number = -1;
  @State slavePath: string = '';
  @State reportPath: string = '';
  // Batch/hold test params
  @State batchCount: number = 100;
  @State batchInterval: number = 10;
  @State batchCloseBetween: boolean = true;
  @State batchParallel: boolean = false;
  @State holdSeconds: number = 30;

  private scroller: Scroller = new Scroller();
  private logIndex: number = 0;
  private logDir: string = '';

  // ── Lifecycle ───────────────────────────────────────────────────
  aboutToAppear(): void {
    this.refreshSystemState();
    this.updateTime();

    // Initialize log directory
    try {
      let context = getContext(this) as common.UIAbilityContext;
      this.logDir = context.filesDir;
      testNapi.initLogDir(this.logDir);
      this.addLog('INFO', `日志目录: ${this.logDir}`);
    } catch (e) {
      this.addLog('WARN', `初始化日志失败: ${JSON.stringify(e)}`);
      this.logDir = '/data/storage/el2/base/haps/entry/files';
      testNapi.initLogDir(this.logDir);
    }

    // Copy rawfile ELFs to private dir for exec test
    this.copyElfFromRawfile('hello-unsigned');
    this.copyElfFromRawfile('hello-signed');
    this.copyElfFromRawfile('imported-unsigned');
    this.copyElfFromRawfile('toybox');
    this.copyElfFromRawfile('imported-signed');
    this.copyElfFromRawfile('toybox-unsigned');
    this.copyElfFromRawfile('toybox-signed');
    this.copyElfFromRawfile('raw_usb');
    this.copyElfFromRawfile('hapipc_test');
    this.copyElfFromRawfile('usb_client');
    this.copyElfFromRawfile('usb_proxy');
    this.copyElfFromRawfile('socket_client-unsigned');
    this.copyElfFromRawfile('socket_client-signed');
  }

  // Copy a rawfile to app private files dir for exec
  async copyElfFromRawfile(name: string): Promise<void> {
    try {
      let context = getContext(this) as common.UIAbilityContext;
      let mgr = context.resourceManager;
      let rawData: Uint8Array = await mgr.getRawFileContent(name);
      if (rawData && rawData.length > 0) {
        let path = `${this.logDir}/${name}`;
        let file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
        fs.writeSync(file.fd, rawData.buffer);
        fs.fsyncSync(file.fd);  // ensure written before exec
        fs.closeSync(file);
        // Verify
        let stat = fs.statSync(path);
        this.addLog('INFO', `ELF ${name}: ${stat.size} bytes -> ${path}`);
      } else {
        this.addLog('WARN', `ELF ${name}: empty or not found in rawfile`);
      }
    } catch (e) {
      this.addLog('WARN', `ELF ${name} failed: ${JSON.stringify(e)}`);
    }
  }

  aboutToDisappear(): void {
    if (this.continuousTaskId >= 0) {
      testNapi.stopContinuousTest(this.continuousTaskId);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────
  addLog(level: string, msg: string): void {
    let entry = new LogEntry(msg, level);
    this.logEntries.push(entry);
    this.logIndex++;
    // Limit log entries to 2000 for UI performance
    if (this.logEntries.length > 2000) {
      this.logEntries.splice(0, this.logEntries.length - 2000);
    }
    // Auto-scroll
    this.scroller.scrollEdge(Edge.Bottom);

    // Also send to HiLog
    if (level === 'ERROR') {
      hilog.error(DOMAIN, TAG, '%{public}s', msg);
    } else if (level === 'WARN') {
      hilog.warn(DOMAIN, TAG, '%{public}s', msg);
    } else {
      hilog.info(DOMAIN, TAG, '%{public}s', msg);
    }
  }

  updateTime(): void {
    let now = new Date();
    this.currentTime = now.toISOString().replace('T', ' ').substring(0, 23);
  }

  refreshSystemState(): void {
    try {
      let state: FullSystemState = testNapi.collectSystemState();
      this.pid = state.pid;
      this.uid = state.uid;
      this.gid = state.gid;
      this.updateTime();
      this.addLog('INFO', `系统状态刷新: PID=${state.pid} UID=${state.uid} GID=${state.gid} FD=${state.fdCount}`);
    } catch (e) {
      this.addLog('ERROR', `刷新系统状态失败: ${JSON.stringify(e)}`);
    }
  }

  // ── Format test result for display ──────────────────────────────
  formatResult(result: PtyTestResult): string {
    if (result.success) {
      return `✓ 成功 — masterFd=${result.masterFd} slaveFd=${result.slaveFd} slavePath=${result.slavePath} 耗时=${result.durationUs}μs`;
    } else {
      return `✗ 失败 — 步骤=${result.failedStep} errno=${result.errno} (${result.errnoMessage}) masterFd=${result.masterFd} slaveFd=${result.slaveFd}`;
    }
  }

  processResult(result: PtyTestResult): void {
    this.lastResult = "TCP relay :9999";
    this.lastErrno = result.errno;
    this.lastFailedStep = result.failedStep;
    this.masterFd = result.masterFd;
    this.slaveFd = result.slaveFd;
    this.slavePath = result.slavePath;
    this.reportPath = result.reportPath;
    this.lastTestDuration = `${result.durationUs} μs`;

    if (result.success) {
      this.successCount++;
      this.addLog('INFO', `测试成功 ID=${result.testId}: masterFd=${result.masterFd} slaveFd=${result.slaveFd} path=${result.slavePath}`);
    } else {
      this.failureCount++;
      this.addLog('ERROR', `测试失败 ID=${result.testId}: 步骤=${result.failedStep} errno=${result.errno} msg=${result.errnoMessage}`);
    }

    // Log steps summary
    for (let step of result.steps) {
      let level = step.success ? 'INFO' : 'ERROR';
      this.addLog(level, `  ${step.success ? '✓' : '✗'} ${step.step}: ret=${step.result} errno=${step.errno} ${step.details} (${step.durationUs}μs)`);
    }

    // Update counts for continuous test results
    if (result.counts) {
      this.successCount = result.counts.successCount;
      this.failureCount = result.counts.failureCount;
    }

    this.refreshSystemState();
    this.readyForNextTest = true;
    this.isRunning = false;
  }

  // ── Test actions ────────────────────────────────────────────────
  async runNormalTest(): Promise<void> {
    if (!this.readyForNextTest) return;
    this.readyForNextTest = false;
    this.isRunning = true;
    this.currentMode = TestMode.NORMAL;
    this.addLog('INFO', '========== 开始普通 PTY 测试 ==========');

    let options: PtyTestOptions = {
      crashOnFailure: false,
      performReadWriteTest: true,
      collectMountInfo: true,
      collectSelinuxInfo: true,
      fsyncOnEveryStep: false
    };

    try {
      let result: PtyTestResult = await testNapi.runPtyTest(options);
      this.processResult(result);
    } catch (e) {
      this.addLog('ERROR', `PTY测试异常: ${JSON.stringify(e)}`);
      this.readyForNextTest = true;
      this.isRunning = false;
    }
  }

  async runCrashTest(): Promise<void> {
    if (!this.readyForNextTest) return;
    this.readyForNextTest = false;
    this.isRunning = true;
    this.currentMode = TestMode.CRASH;
    this.addLog('WARN', '========== 开始 Crash 模式 PTY 测试 (失败时将触发 abort) ==========');

    let options: PtyTestOptions = {
      crashOnFailure: true,
      performReadWriteTest: true,
      collectMountInfo: true,
      collectSelinuxInfo: true,
      fsyncOnEveryStep: true
    };

    try {
      let result: PtyTestResult = await testNapi.runPtyTest(options);
      // If we reach here, the test succeeded
      this.processResult(result);
      this.addLog('INFO', 'PTY测试成功 — 未触发Crash');
    } catch (e) {
      this.addLog('ERROR', `PTY测试异常 (应用可能即将崩溃): ${JSON.stringify(e)}`);
      this.readyForNextTest = true;
      this.isRunning = false;
    }
  }

  async runShellControlTest(): Promise<void> {
    if (!this.readyForNextTest) return;
    this.readyForNextTest = false;
    this.isRunning = true;
    this.currentMode = TestMode.SHELL_CONTROL;
    this.addLog('INFO', '========== 开始无PTY Shell对照测试 ==========');

    try {
      let result: PtyTestResult = await testNapi.runShellControlTest();
      this.processResult(result);
    } catch (e) {
      this.addLog('ERROR', `Shell对照测试异常: ${JSON.stringify(e)}`);
      this.readyForNextTest = true;
      this.isRunning = false;
    }
  }

  async runForkptyTest(): Promise<void> {
    if (!this.readyForNextTest) return;
    this.readyForNextTest = false;
    this.isRunning = true;
    this.currentMode = 'forkpty测试';
    this.addLog('INFO', '========== 开始 forkpty 测试 ==========');

    let options: PtyTestOptions = {
      crashOnFailure: false,
      performReadWriteTest: true,
      collectMountInfo: true,
      collectSelinuxInfo: true,
      fsyncOnEveryStep: false
    };

    try {
      let result: PtyTestResult = await testNapi.runForkptyTest(options);
      this.processResult(result);
    } catch (e) {
      this.addLog('ERROR', `forkpty测试异常: ${JSON.stringify(e)}`);
      this.readyForNextTest = true;
      this.isRunning = false;
    }
  }

  async runRecoveryTest(): Promise<void> {
    if (!this.readyForNextTest) return;
    this.readyForNextTest = false;
    this.isRunning = true;
    this.currentMode = '恢复测试(子进程forkpty)';
    this.addLog('INFO', '========== 开始恢复测试: 父进程失败后,子进程能否恢复PTY? ==========');

    try {
      let result: PtyTestResult = await testNapi.runRecoveryTest();
      this.processResult(result);
    } catch (e) {
      this.addLog('ERROR', `恢复测试异常: ${JSON.stringify(e)}`);
      this.readyForNextTest = true;
      this.isRunning = false;
    }
  }

  // ── PTMX Attribute Check ─────────────────────────────────────
  checkPtmxAttributes(): void {
    this.currentMode = 'PTMX属性检查';
    this.refreshSystemState();

    let attr: PtmxAttrResult = testNapi.checkPtmxAttributes();
    this.addLog('INFO', '========== /dev/ptmx 属性检查 ==========');
    this.addLog('INFO', `access: R=${attr.accessR} W=${attr.accessW} X=${attr.accessX} exists=${attr.pathExists}`);
    this.addLog('INFO', `stat: ret=${attr.statRet} errno=${attr.statErrno} | ${attr.statDetail}`);
    this.addLog('INFO', `lstat: ret=${attr.lstatRet} errno=${attr.lstatErrno} | ${attr.lstatDetail}`);
    this.addLog('INFO', `readlink: ${attr.readlinkResult}`);
    this.addLog('INFO', `test open: ret=${attr.openRet} errno=${attr.openErrno}`);
    this.addLog('INFO', `SELinux: ${attr.selinuxContext}  FD count: ${attr.fdCount}`);
    if (attr.mountInfoDevPts.length > 0) {
      this.addLog('INFO', `mountinfo devpts:\n${attr.mountInfoDevPts}`);
    }
    if (attr.mountInfoDev.length > 0) {
      this.addLog('INFO', `mountinfo /dev:\n${attr.mountInfoDev}`);
    }
    this.lastResult = "TCP relay :9999";
    this.lastErrno = attr.openErrno;
  }

  // ── Batch Open Test ──────────────────────────────────────────
  async runBatchOpenTest(): Promise<void> {
    if (!this.readyForNextTest) return;
    this.readyForNextTest = false;
    this.isRunning = true;
    this.currentMode = `批量打开(count=${this.batchCount} interval=${this.batchInterval}ms close=${this.batchCloseBetween} parallel=${this.batchParallel})`;
    this.addLog('INFO', `========== 批量打开测试: ${this.currentMode} ==========`);

    let options: BatchOpenOptions = {
      count: this.batchCount,
      intervalMs: this.batchInterval,
      closeBetween: this.batchCloseBetween,
      parallel: this.batchParallel
    };

    try {
      let result: PtyTestResult = await testNapi.runBatchOpenTest(options);
      this.addLog(result.success ? 'INFO' : 'ERROR', `批量打开结果: ${result.slavePath}`);
      this.lastResult = "TCP relay :9999";
      this.lastErrno = result.errno;
      if (result.success) {
        this.successCount++;
      } else {
        this.failureCount++;
      }
      this.readyForNextTest = true;
      this.isRunning = false;
    } catch (e) {
      this.addLog('ERROR', `批量打开异常: ${JSON.stringify(e)}`);
      this.readyForNextTest = true;
      this.isRunning = false;
    }
  }

  // ── Hold Open Test ───────────────────────────────────────────
  async runHoldOpenTest(): Promise<void> {
    if (!this.readyForNextTest) return;
    this.readyForNextTest = false;
    this.isRunning = true;
    this.currentMode = `保持打开(${this.holdSeconds === 0 ? '一直' : this.holdSeconds + 's'})`;
    this.addLog('INFO', `========== 保持打开测试: 打开/dev/ptmx并保持${this.holdSeconds === 0 ? '直到手动停止' : this.holdSeconds + '秒'} ==========`);

    let options: HoldOpenOptions = {
      holdSeconds: this.holdSeconds
    };

    try {
      let result: PtyTestResult = await testNapi.runHoldOpenTest(options);
      this.addLog(result.success ? 'INFO' : 'ERROR', `保持打开结果: ${result.slavePath}`);
      this.lastResult = "TCP relay :9999";
      this.lastErrno = result.errno;
      if (result.success) {
        this.successCount++;
      } else {
        this.failureCount++;
      }
      this.readyForNextTest = true;
      this.isRunning = false;
    } catch (e) {
      this.addLog('ERROR', `保持打开异常: ${JSON.stringify(e)}`);
      this.readyForNextTest = true;
      this.isRunning = false;
    }
  }

  // ── Toybox Direct ────────────────────────────────────────────
  runToyboxDirect(): void {
    this.currentMode = 'toybox直接运行';
    this.addLog('INFO', '========== toybox-unsigned 直接运行 (无参数) ==========');
    let result: string = testNapi.runToyboxDirect('unsigned');
    this.addLog('INFO', `toybox-unsigned:\n${result}`);
    this.lastResult = "TCP relay :9999";
  }

  runToyboxSigned(): void {
    this.currentMode = 'toybox签名运行';
    this.addLog('INFO', '========== toybox-signed 直接运行 (无参数) ==========');
    let result: string = testNapi.runToyboxDirect('signed');
    this.addLog('INFO', `toybox-signed:\n${result}`);
    this.lastResult = "TCP relay :9999";
  }

  runToyboxPtySh(): void {
    this.currentMode = 'toybox PTY sh';
    this.addLog('INFO', '========== forkpty + toybox sh ==========');
    let result: string = testNapi.runToyboxPtySh();
    this.addLog('INFO', `toybox pty sh: ${result}`);
    this.lastResult = "TCP relay :9999";
  }

  runAbstractSocketTest(): void {
    this.currentMode = '抽象Unix Socket';
    this.addLog('INFO', '========== 抽象Unix Socket 测试 ==========');
    let result: string = testNapi.runAbstractSocketTest();
    this.addLog('INFO', `Abstract:\n${result}`);
    this.lastResult = result.substring(0, 300);
  }

  runUnixPeerCredTest(): void {
    this.currentMode = 'SO_PEERCRED身份测试';
    this.addLog('INFO', '========== AF_UNIX SO_PEERCRED + /proc/<pid>/exe 测试 ==========');
    let result: string = testNapi.runUnixPeerCredTest();
    this.addLog('INFO', `PeerCred:\n${result}`);
    this.lastResult = result.substring(0, 300);
  }

  async runAbstractSocketServer(): Promise<void> {
    this.currentMode = '抽象Sock服务端';
    this.addLog('INFO', '========== 抽象Socket服务端: 监听@pty_diag_test 60s ==========');
    try {
      let result: string = await testNapi.runAbstractSocketServer();
      this.addLog('INFO', `Server: ${result}`);
      this.lastResult = result;
    } catch (e) {
      this.addLog('ERROR', `SockSrv异常: ${JSON.stringify(e)}`);
    }
  }

  async runFileSocketServer(): Promise<void> {
    this.currentMode = '文件Socket服务端';
    this.addLog('INFO', '========== 文件Socket: 监听可写用户挂载路径 60s ==========');
    try {
      let result: string = await testNapi.runFileSocketServer();
      this.addLog('INFO', `FileSock: ${result}`);
      this.lastResult = result;
    } catch (e) { this.addLog('ERROR', `FileSock: ${JSON.stringify(e)}`); }
  }

  runToyboxTest(): void {
    this.currentMode = 'toybox测试';
    this.addLog('INFO', '========== toybox ls -la /dev/ptmx ==========');
    let result: string = testNapi.runToyboxTest('ls -la /dev/ptmx');
    this.addLog('INFO', `toybox:\n${result}`);
    this.lastResult = "TCP relay :9999";
  }

  // ── Third-party command execution test ──────────────────────────
  runThirdPartyCommand(): void {
    this.currentMode = '第三方命令执行';
    this.addLog('INFO', '========== 执行 /storage/Users/currentUser/.harmonybrew/bin/brew --version ==========');
    try {
      let result: string = testNapi.runThirdPartyCommand();
      let succeeded = result.includes('timedOut=false') && result.includes('exitCode=0');
      this.addLog(succeeded ? 'INFO' : 'WARN', `第三方命令结果:\n${result}`);
      this.lastResult = result.substring(0, 300);
    } catch (e) {
      this.addLog('ERROR', `第三方命令异常: ${JSON.stringify(e)}`);
      this.lastResult = '第三方命令调用异常';
    }
  }

  runBmTest(): void {
    this.currentMode = 'BM工具执行';
    this.addLog('INFO', '========== 执行 /system/bin/bm dump -a ==========');
    try {
      let result: string = testNapi.runThirdPartyCommand('/system/bin/bm', 'dump', '-a');
      let canLaunch = result.includes('stat=0') &&
        result.includes('access(X_OK)=0') &&
        !result.includes('execve failed');
      this.addLog(canLaunch ? 'INFO' : 'WARN', `BM工具结果:\n${result}`);
      this.lastResult = result.substring(0, 300);
    } catch (e) {
      this.addLog('ERROR', `BM工具调用异常: ${JSON.stringify(e)}`);
      this.lastResult = 'BM工具调用异常';
    }
  }

  runSystemZshCommand(): void {
    this.currentMode = '系统 zsh 执行';
    this.addLog('INFO', '========== 执行 /usr/bin/zsh -c "echo ZSH_OK; id; pwd" ==========');
    try {
      let result: string = testNapi.runThirdPartyCommand('/usr/bin/zsh', '-c', 'echo ZSH_OK; id; pwd');
      let succeeded = result.includes('timedOut=false') && result.includes('exitCode=0');
      this.addLog(succeeded ? 'INFO' : 'WARN', `系统 zsh 结果:\n${result}`);
      this.lastResult = result.substring(0, 300);
    } catch (e) {
      this.addLog('ERROR', `系统 zsh 异常: ${JSON.stringify(e)}`);
      this.lastResult = '系统 zsh 调用异常';
    }
  }

  // ── IPC PING diagnostic ──────────────────────────────────────────
  ipcPingInfo(): void {
    this.addLog("INFO", "Starting ServiceExtAbility...");
    try {
      let ctx = getContext(this) as common.UIAbilityContext;
      let want: Want = { bundleName: "org.demo.myapplication", abilityName: "ServiceExtAbility" };
      ctx.startAppServiceExtensionAbility(want);
      this.addLog("INFO", "ServiceExtAbility started — now run: ./hapipc_test");
    } catch (e) {
      this.addLog("ERROR", "Failed: " + JSON.stringify(e));
    }
  }


  // ── USB fd relay ─────────────────────────────────────────────
  async startUsbRelayAction(): Promise<void> {
    this.addLog('INFO', '========== USB fd relay: enumerating devices ==========');
    testNapi.logToFile('========== USB fd relay: enumerating devices ==========');
    try {
      let devices: Array<usbManager.USBDevice> = usbManager.getDevices();
      this.addLog('INFO', `usbManager.getDevices: ${devices.length} devices`);
      testNapi.logToFile(`usbManager.getDevices: ${devices.length} devices`);
      if (devices.length === 0) {
        this.addLog('WARN', 'No USB devices found');
        testNapi.logToFile('No USB devices found');
        return;
      }
      for (let i = 0; i < devices.length && i < 4; i++) {
        let dev = devices[i];
        this.addLog('INFO', `  [${i}] name=${dev.name} VID:PID=${dev.vendorId.toString(16)}:${dev.productId.toString(16)}`);
        testNapi.logToFile(`  [${i}] name=${dev.name} VID:PID=${dev.vendorId.toString(16)}:${dev.productId.toString(16)}`);
      }
      let dev = devices[0];
      if (!usbManager.hasRight(dev.name)) {
        this.addLog('INFO', `requesting right for ${dev.name}...`);
        testNapi.logToFile(`requesting right for ${dev.name}...`);
        let granted = await usbManager.requestRight(dev.name);
        this.addLog('INFO', `requestRight: ${granted}`);
        testNapi.logToFile(`requestRight: ${granted}`);
        if (!granted) { this.addLog('ERROR', 'USB permission denied'); testNapi.logToFile('USB permission denied'); return; }
      }
      let pipe: usbManager.USBDevicePipe = usbManager.connectDevice(dev);
      let fd: number = usbManager.getFileDescriptor(pipe);
      this.addLog('INFO', `USB device opened: fd=${fd}`);
      testNapi.logToFile(`USB device opened: fd=${fd}`);
      let ok = testNapi.startUsbProxy(fd);
      this.addLog('INFO', `TCP relay started: ${ok} — ./usb_client`);
      testNapi.logToFile("TCP relay listening on 127.0.0.1:9999");
      this.lastResult = "TCP relay :9999";
    } catch (e) {
      this.addLog('ERROR', `USB relay failed: ${JSON.stringify(e)}`);
      testNapi.logToFile(`USB relay failed: ${JSON.stringify(e)}`);
    }
  }

  // ── raw_usb inherit-permission test ──────────────────────────
  async runRawUsbTest(): Promise<void> {
    if (!this.readyForNextTest) return;
    this.readyForNextTest = false;
    this.isRunning = true;
    this.currentMode = 'raw_usb继承权限测试';
    this.addLog('INFO', '========== raw_usb (INHERIT_PARENT_PERMISSION) ==========');
    try {
      let result: string = testNapi.runRawUsbTest();
      let lines = result.split('\n');
      for (let line of lines) {
        if (line.trim().length > 0) {
          this.addLog(line.includes('EACCES') || line.includes('denied') ? 'WARN' :
                      line.includes('VID:PID') ? 'IMPORTANT' : 'INFO', line);
        }
      }
      this.isRunning = false;
      this.readyForNextTest = true;
    } catch (e) {
      this.addLog('ERROR', `raw_usb异常: ${JSON.stringify(e)}`);
      this.isRunning = false;
      this.readyForNextTest = true;
    }
  }

  // ── USB DDK permission test ─────────────────────────────────────
  async runUsbDdkTest(): Promise<void> {
    if (!this.readyForNextTest) return;
    this.readyForNextTest = false;
    this.isRunning = true;
    this.currentMode = 'USB DDK权限测试';
    this.addLog('INFO', '========== USB DDK 权限测试 (验证 ohos.permission.ACCESS_DDK_USB) ==========');

    try {
      let result: string = testNapi.runUsbDdkTest();
      let lines = result.split('\n');
      for (let line of lines) {
        if (line.trim().length > 0) {
          this.addLog(line.includes('FAILED') || line.includes('NO_PERM') ? 'WARN' :
                      line.includes('ADB') || line.includes('DETECTED') ? 'IMPORTANT' : 'INFO', line);
        }
      }
      this.lastResult = "TCP relay :9999";
      this.isRunning = false;
      this.readyForNextTest = true;
    } catch (e) {
      this.addLog('ERROR', `USB DDK测试异常: ${JSON.stringify(e)}`);
      this.isRunning = false;
      this.readyForNextTest = true;
    }
  }

  async runElfTest(): Promise<void> {
    if (!this.readyForNextTest) return;
    this.readyForNextTest = false;
    this.isRunning = true;
    this.currentMode = '独立ELF执行测试';
    this.addLog('INFO', '========== 独立ELF执行测试 (4组: rawfile/import × signed/unsigned) ==========');

    try {
      let result: PtyTestResult = await testNapi.runAllElfTests();
      this.addLog(result.success ? 'INFO' : 'ERROR', `ELF测试: ${result.slavePath}`);
      this.lastResult = "TCP relay :9999";
      this.isRunning = false;
      this.readyForNextTest = true;
    } catch (e) {
      this.addLog('ERROR', `ELF测试异常: ${JSON.stringify(e)}`);
      this.isRunning = false;
      this.readyForNextTest = true;
    }
  }

  startContinuousTest(): void {
    if (this.continuousTaskId >= 0) {
      this.addLog('WARN', '连续测试已在运行中');
      return;
    }
    this.isRunning = true;
    this.currentMode = TestMode.CONTINUOUS;
    this.successCount = 0;
    this.failureCount = 0;
    this.addLog('INFO', `========== 开始连续测试 (间隔=${this.continuousInterval}ms) ==========`);

    let options: ContinuousTestOptions = {
      intervalMs: this.continuousInterval,
      maxLogEntries: 5000
    };

    // Callback receives result from native thread
    let callback = (result: PtyTestResult): void => {
      this.lastResult = "TCP relay :9999";
      this.lastErrno = result.errno;
      this.lastFailedStep = result.failedStep;
      this.masterFd = result.masterFd;
      this.slaveFd = result.slaveFd;
      this.slavePath = result.slavePath;
      this.lastTestDuration = `${result.durationUs} μs`;

      // Update counts from the result
      if (result.counts) {
        this.successCount = result.counts.successCount;
        this.failureCount = result.counts.failureCount;
      }

      // Log attr info if available
      let attr = result.attr;
      let attrStr = '';
      if (attr) {
        attrStr = ` | ptmx: accessR=${attr['accessR']} openR=${attr['openRet']} openE=${attr['openErrno']} statE=${attr['statErrno']}`;
      }

      let brief = result.success
        ? `✓ #${result.testId} OK masterFd=${result.masterFd}${attrStr}`
        : `✗ #${result.testId} ${result.failedStep} errno=${result.errno}${attrStr}`;
      this.addLog(result.success ? 'INFO' : 'ERROR', brief);

      this.updateTime();
    };

    this.continuousTaskId = testNapi.startContinuousTest(options, callback);
    this.addLog('INFO', `连续测试已启动 taskId=${this.continuousTaskId}`);
  }

  stopContinuousTest(): void {
    if (this.continuousTaskId < 0) {
      this.addLog('WARN', '没有运行中的连续测试');
      return;
    }
    let ret = testNapi.stopContinuousTest(this.continuousTaskId);
    this.addLog('INFO', `连续测试已停止 taskId=${this.continuousTaskId} result=${ret}`);
    this.continuousTaskId = -1;
    this.isRunning = false;
    this.currentMode = TestMode.IDLE;
    this.readyForNextTest = true;
  }

  refreshSystemStateAction(): void {
    this.currentMode = TestMode.SYSTEM_STATE;
    this.refreshSystemState();
    this.addLog('INFO', '系统状态已刷新');
  }

  clearLogs(): void {
    this.logEntries = [];
    this.logIndex = 0;
    this.addLog('INFO', '界面日志已清空');
  }

  copyAllLogs(): void {
    let text = this.logEntries.map((e: LogEntry): string => e.toString()).join('\n');
    // Output via HiLog as fallback — user can view via hilog -x -e PTY_DIAG_UI
    hilog.info(DOMAIN, TAG, '=== 日志导出 (共%{public}d条) ===', this.logEntries.length);
    let remaining = text;
    // Split into chunks to avoid HiLog truncation
    while (remaining.length > 0) {
      let chunk = remaining.substring(0, 800);
      hilog.info(DOMAIN, TAG, '%{public}s', chunk);
      remaining = remaining.substring(800);
    }
    hilog.info(DOMAIN, TAG, '=== 日志导出结束 ===');
    this.addLog('INFO', `已通过 HiLog 导出 ${this.logEntries.length} 条日志 (使用 hilog -x -e PTY_DIAG_UI 查看)`);
  }

  saveReport(): void {
    this.addLog('INFO', `诊断报告路径: ${this.reportPath || '请先执行测试'}`);
    let logPath = testNapi.getLogFilePath();
    this.addLog('INFO', `日志文件路径: ${logPath}`);
  }

  // ── Interval selector ───────────────────────────────────────────
  setTestInterval(ms: number): void {
    this.continuousInterval = ms;
    this.addLog('INFO', `连续测试间隔设置为 ${ms}ms`);
  }

  // ── Build UI ────────────────────────────────────────────────────
  build() {
    Column() {
      // ── Title ───────────────────────────────────────────────────
      Text('PTY 诊断工具')
        .fontSize(22)
        .fontWeight(FontWeight.Bold)
        .padding({ top: 12, bottom: 4 })
        .textAlign(TextAlign.Center)
        .width('100%')

      // ── System info row ─────────────────────────────────────────
      Row() {
        Text(`PID:${this.pid}`).fontSize(11).fontColor('#888')
        Text(`UID:${this.uid}`).fontSize(11).fontColor('#888').margin({ left: 8 })
        Text(`GID:${this.gid}`).fontSize(11).fontColor('#888').margin({ left: 8 })
        Text(this.currentTime).fontSize(11).fontColor('#888').margin({ left: 8 })
      }
      .width('100%')
      .justifyContent(FlexAlign.Center)
      .padding({ bottom: 4 })

      // ── Status summary ──────────────────────────────────────────
      Column() {
        Text(`模式: ${this.currentMode}`).fontSize(13)
        Text(`最近结果: ${this.lastResult}`).fontSize(12).fontColor(this.lastFailedStep !== 'NONE' ? '#E74C3C' : '#27AE60').maxLines(2)
        if (this.lastTestDuration.length > 0) {
          Text(`耗时: ${this.lastTestDuration}`).fontSize(11).fontColor('#666')
        }
        Row() {
          Text(`成功: ${this.successCount}`).fontSize(13).fontColor('#27AE60')
          Text(`失败: ${this.failureCount}`).fontSize(13).fontColor('#E74C3C').margin({ left: 16 })
          Text(`errno: ${this.lastErrno}`).fontSize(13).fontColor('#E67E22').margin({ left: 16 })
        }
        if (this.lastFailedStep !== 'NONE') {
          Text(`失败步骤: ${this.lastFailedStep}`).fontSize(12).fontColor('#E74C3C')
        }
        if (this.slavePath.length > 0) {
          Text(`Slave: ${this.slavePath}`).fontSize(10).fontColor('#666').maxLines(1)
        }
      }
      .width('100%')
      .padding(8)
      .backgroundColor('#F8F9FA')
      .borderRadius(8)
      .margin({ bottom: 6 })

      // ── Button grid ─────────────────────────────────────────────
      // Row 1: Primary test buttons
      Row() {
        Button('普通PTY测试')
          .fontSize(13)
          .onClick(() => { this.runNormalTest(); })
          .enabled(this.readyForNextTest && this.continuousTaskId < 0)
        Button('Crash测试')
          .fontSize(13)
          .fontColor(Color.White)
          .backgroundColor('#E74C3C')
          .onClick(() => { this.runCrashTest(); })
          .enabled(this.readyForNextTest && this.continuousTaskId < 0)
          .margin({ left: 6 })
      }
      .width('100%')
      .justifyContent(FlexAlign.Center)
      .margin({ bottom: 4 })

      // Row 2: Continuous test + stop
      Row() {
        Button('连续测试')
          .fontSize(13)
          .fontColor(Color.White)
          .backgroundColor('#2980B9')
          .onClick(() => { this.startContinuousTest(); })
          .enabled(this.continuousTaskId < 0)
        Button('停止连续')
          .fontSize(13)
          .fontColor(Color.White)
          .backgroundColor('#E67E22')
          .onClick(() => { this.stopContinuousTest(); })
          .enabled(this.continuousTaskId >= 0)
          .margin({ left: 6 })
      }
      .width('100%')
      .justifyContent(FlexAlign.Center)
      .margin({ bottom: 4 })

      // Row 3: Shell control + Refresh state
      Row() {
        Button('Shell对照')
          .fontSize(12)
          .onClick(() => { this.runShellControlTest(); })
          .enabled(this.readyForNextTest && this.continuousTaskId < 0)
        Button('forkpty')
          .fontSize(12)
          .onClick(() => { this.runForkptyTest(); })
          .enabled(this.readyForNextTest && this.continuousTaskId < 0)
          .margin({ left: 6 })
        Button('恢复测试')
          .fontSize(12)
          .fontColor(Color.White)
          .backgroundColor('#8E44AD')
          .onClick(() => { this.runRecoveryTest(); })
          .enabled(this.readyForNextTest && this.continuousTaskId < 0)
          .margin({ left: 6 })
        Button('刷新状态')
          .fontSize(12)
          .onClick(() => { this.refreshSystemStateAction(); })
          .margin({ left: 6 })
        Button('保存报告')
          .fontSize(12)
          .onClick(() => { this.saveReport(); })
          .margin({ left: 6 })
      }
      .width('100%')
      .justifyContent(FlexAlign.Center)
      .margin({ bottom: 4 })

      // Row 4: Attr check + Batch open + Hold open
      Row() {
        Button('PTMX属性')
          .fontSize(12)
          .fontColor(Color.White)
          .backgroundColor('#16A085')
          .onClick(() => { this.checkPtmxAttributes(); })
          .enabled(this.continuousTaskId < 0)
        Button('批量打开')
          .fontSize(12)
          .onClick(() => { this.runBatchOpenTest(); })
          .enabled(this.readyForNextTest && this.continuousTaskId < 0)
          .margin({ left: 6 })
        Button('保持打开')
          .fontSize(12)
          .onClick(() => { this.runHoldOpenTest(); })
          .enabled(this.readyForNextTest && this.continuousTaskId < 0)
          .margin({ left: 6 })
      }
      .width('100%')
      .justifyContent(FlexAlign.Center)
      .margin({ bottom: 4 })

      // Row 4c: ELF exec test
      Row() {
        Button('ELF测试')
          .fontSize(12)
          .fontColor(Color.White)
          .backgroundColor('#9B59B6')
          .onClick(() => { this.runElfTest(); })
          .enabled(this.readyForNextTest && this.continuousTaskId < 0)
        Button('toybox')
          .fontSize(12)
          .onClick(() => { this.runToyboxTest(); })
          .margin({ left: 6 })
        Button('toy直接')
          .fontSize(11)
          .onClick(() => { this.runToyboxDirect(); })
          .margin({ left: 4 })
        Button('toy签名')
          .fontSize(11)
          .onClick(() => { this.runToyboxSigned(); })
          .margin({ left: 4 })
        Button('toyPtySh')
          .fontSize(11)
          .fontColor(Color.White)
          .backgroundColor('#E67E22')
          .onClick(() => { this.runToyboxPtySh(); })
          .margin({ left: 4 })
        Button('抽象Sock')
          .fontSize(11)
          .fontColor(Color.White)
          .backgroundColor('#2980B9')
          .onClick(() => { this.runAbstractSocketTest(); })
          .margin({ left: 4 })
        Button('PeerCred')
          .fontSize(11)
          .fontColor(Color.White)
          .backgroundColor('#8E44AD')
          .onClick(() => { this.runUnixPeerCredTest(); })
          .margin({ left: 4 })
        Button('SockSrv')
          .fontSize(11)
          .fontColor(Color.White)
          .backgroundColor('#1ABC9C')
          .onClick(() => { this.runAbstractSocketServer(); })
          .margin({ left: 4 })
        Button('FileSock')
          .fontSize(11)
          .fontColor(Color.White)
          .backgroundColor('#27AE60')
          .onClick(() => { this.runFileSocketServer(); })
          .margin({ left: 4 })
      }
      .width('100%')
      .justifyContent(FlexAlign.Center)
      .margin({ bottom: 4 })

      // Row 4x: IPC PING test
      Row() {
        Button('IPC PING')
          .fontSize(13)
          .fontColor(Color.White)
          .backgroundColor('#3498DB')
          .onClick(() => { this.ipcPingInfo(); })
          .enabled(this.readyForNextTest && this.continuousTaskId < 0)
      }
      .width('100%')
      .justifyContent(FlexAlign.Center)
      .margin({ bottom: 4 })

      // Row 4y: third-party command execution test
      Row() {
        Button('brew命令测试')
          .fontSize(13)
          .fontColor(Color.White)
          .backgroundColor('#6F4E37')
          .onClick(() => { this.runThirdPartyCommand(); })
          .enabled(this.readyForNextTest && this.continuousTaskId < 0)
      }
      .width('100%')
      .justifyContent(FlexAlign.Center)
      .margin({ bottom: 4 })

      // Row 4z: system zsh execution test
      Row() {
        Button('系统 zsh 测试')
          .fontSize(13)
          .fontColor(Color.White)
          .backgroundColor('#5B3A70')
          .onClick(() => { this.runSystemZshCommand(); })
          .enabled(this.readyForNextTest && this.continuousTaskId < 0)
      }
      .width('100%')
      .justifyContent(FlexAlign.Center)
      .margin({ bottom: 4 })

      // Row 4zz: BM tool execution test
      Row() {
        Button('BM工具测试')
          .fontSize(13)
          .fontColor(Color.White)
          .backgroundColor('#2E86DE')
          .onClick(() => { this.runBmTest(); })
          .enabled(this.readyForNextTest && this.continuousTaskId < 0)
      }
      .width('100%')
      .justifyContent(FlexAlign.Center)
      .margin({ bottom: 4 })


      // Row 4d: USB DDK permission test
      Row() {
        Button('USB DDK测试')
          .fontSize(13)
          .fontColor(Color.White)
          .backgroundColor('#27AE60')
          .onClick(() => { this.runUsbDdkTest(); })
          .enabled(this.readyForNextTest && this.continuousTaskId < 0)
        Button('raw_usb')
          .fontSize(13)
          .fontColor(Color.White)
          .backgroundColor('#E67E22')
          .onClick(() => { this.runRawUsbTest(); })
          .enabled(this.readyForNextTest && this.continuousTaskId < 0)
          .margin({ left: 6 })
        Button('USB Relay')
          .fontSize(13)
          .fontColor(Color.White)
          .backgroundColor('#8E44AD')
          .onClick(() => { this.startUsbRelayAction(); })
          .enabled(this.readyForNextTest && this.continuousTaskId < 0)
          .margin({ left: 6 })
      }
      .width('100%')
      .justifyContent(FlexAlign.Center)
      .margin({ bottom: 4 })

      // Row 4b: Batch/hold params
      Row() {
        Text('批次数:').fontSize(11)
        Button(`${this.batchCount}`)
          .fontSize(10)
          .onClick(() => { this.batchCount = this.batchCount === 10 ? 100 : this.batchCount === 100 ? 1000 : this.batchCount === 1000 ? 10000 : 10; })
        Text('间隔ms:').fontSize(11).margin({ left: 4 })
        Button(`${this.batchInterval}`)
          .fontSize(10)
          .onClick(() => { this.batchInterval = this.batchInterval === 0 ? 10 : this.batchInterval === 10 ? 100 : this.batchInterval === 100 ? 1000 : 0; })
        Text('关闭:').fontSize(11).margin({ left: 4 })
        Button(this.batchCloseBetween ? '是' : '否')
          .fontSize(10)
          .fontColor(this.batchCloseBetween ? Color.White : '#333')
          .backgroundColor(this.batchCloseBetween ? '#27AE60' : '#DDD')
          .onClick(() => { this.batchCloseBetween = !this.batchCloseBetween; })
        Text('并行:').fontSize(11).margin({ left: 4 })
        Button(this.batchParallel ? '是' : '否')
          .fontSize(10)
          .fontColor(this.batchParallel ? Color.White : '#333')
          .backgroundColor(this.batchParallel ? '#E74C3C' : '#DDD')
          .onClick(() => { this.batchParallel = !this.batchParallel; })
        Text('保持s:').fontSize(11).margin({ left: 4 })
        Button(`${this.holdSeconds === 0 ? '∞' : this.holdSeconds}`)
          .fontSize(10)
          .onClick(() => { this.holdSeconds = this.holdSeconds === 5 ? 30 : this.holdSeconds === 30 ? 60 : this.holdSeconds === 60 ? 300 : this.holdSeconds === 300 ? 0 : 5; })
      }
      .width('100%')
      .justifyContent(FlexAlign.Center)
      .margin({ bottom: 4 })

      // Row 5: Clear + Copy
      Row() {
        Button('清空日志')
          .fontSize(12)
          .fontColor('#666')
          .onClick(() => { this.clearLogs(); })
        Button('复制日志')
          .fontSize(12)
          .fontColor('#666')
          .onClick(() => { this.copyAllLogs(); })
          .margin({ left: 6 })
      }
      .width('100%')
      .justifyContent(FlexAlign.Center)
      .margin({ bottom: 6 })

      // ── Interval selector ───────────────────────────────────────
      Row() {
        Text('间隔:').fontSize(12)
        Button('100ms')
          .fontSize(10)
          .fontColor(this.continuousInterval === 100 ? Color.White : '#333')
          .backgroundColor(this.continuousInterval === 100 ? '#2980B9' : '#DDD')
          .onClick(() => { this.setTestInterval(100); })
        Button('500ms')
          .fontSize(10)
          .fontColor(this.continuousInterval === 500 ? Color.White : '#333')
          .backgroundColor(this.continuousInterval === 500 ? '#2980B9' : '#DDD')
          .onClick(() => { this.setTestInterval(500); })
          .margin({ left: 4 })
        Button('1000ms')
          .fontSize(10)
          .fontColor(this.continuousInterval === 1000 ? Color.White : '#333')
          .backgroundColor(this.continuousInterval === 1000 ? '#2980B9' : '#DDD')
          .onClick(() => { this.setTestInterval(1000); })
          .margin({ left: 4 })
        Button('5000ms')
          .fontSize(10)
          .fontColor(this.continuousInterval === 5000 ? Color.White : '#333')
          .backgroundColor(this.continuousInterval === 5000 ? '#2980B9' : '#DDD')
          .onClick(() => { this.setTestInterval(5000); })
          .margin({ left: 4 })
      }
      .width('100%')
      .justifyContent(FlexAlign.Center)
      .margin({ bottom: 6 })

      // ── Log area ────────────────────────────────────────────────
      Text(`日志 (${this.logEntries.length} 条)`)
        .fontSize(13)
        .fontWeight(FontWeight.Medium)
        .width('100%')
        .padding({ left: 4, bottom: 2 })

      Scroll(this.scroller) {
        Column() {
          ForEach(this.logEntries, (entry: LogEntry, index: number) => {
            Text(entry.toString())
              .fontSize(10)
              .fontFamily('monospace')
              .copyOption(CopyOptions.LocalDevice)
              .textSelectable(TextSelectableMode.SELECTABLE_FOCUSABLE)
              .fontColor(entry.level === 'ERROR' ? '#E74C3C' :
                         entry.level === 'WARN' ? '#E67E22' : '#333')
              .width('100%')
              .padding({ left: 4, right: 4, top: 1, bottom: 1 })
          }, (entry: LogEntry, index: number): string => `${index}`)
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      }
      .scrollable(ScrollDirection.Vertical)
      .scrollBar(BarState.Auto)
      .layoutWeight(1)
      .width('100%')
      .backgroundColor('#FAFAFA')
      .borderRadius(4)
      .padding(4)
    }
    .width('100%')
    .height('100%')
    .padding({ left: 10, right: 10, top: 4, bottom: 4 })
  }
}
