// Type definitions for libentry.so - PTY Diagnostic Native Module

export interface PtyTestOptions {
  crashOnFailure: boolean;
  performReadWriteTest: boolean;
  collectMountInfo: boolean;
  collectSelinuxInfo: boolean;
  fsyncOnEveryStep: boolean;
}

export interface PtyStepResult {
  step: string;
  success: boolean;
  result: number;
  errno: number;
  errnoMessage: string;
  durationUs: number;
  details: string;
}

export interface SystemStateSummary {
  pid: number;
  uid: number;
  gid: number;
  fdCount: number;
  ptyNr: string;
  ptyMax: string;
}

export interface PtyTestResult {
  testId: number;
  success: boolean;
  crashOnFailure: boolean;
  failedStep: string;
  errno: number;
  errnoMessage: string;
  masterFd: number;
  slaveFd: number;
  slavePath: string;
  startedAt: string;
  finishedAt: string;
  durationUs: number;
  steps: PtyStepResult[];
  systemStateBefore: SystemStateSummary;
  systemStateAfter: SystemStateSummary;
  reportPath: string;
  counts?: ContinuousCounts;
  attr?: Record<string, Object>;
}

export interface ContinuousCounts {
  successCount: number;
  failureCount: number;
  totalCount: number;
}

export interface ContinuousTestOptions {
  intervalMs: number;
  maxLogEntries?: number;
}

export interface FullSystemState {
  pid: number;
  ppid: number;
  uid: number;
  euid: number;
  gid: number;
  egid: number;
  tid: number;
  fdCount: number;
  cwd: string;
  ptyNr: string;
  ptyMax: string;
  ptyReserve: string;
  selinuxCurrent: string;
  devStat: string;
  devLstat: string;
  ptmxStat: string;
  ptmxLstat: string;
  ptmxReadlink: string;
  devPtsStat: string;
  devPtsPtmxStat: string;
}

export interface PtmxAttrResult {
  pathExists: boolean;
  accessR: number;
  accessW: number;
  accessX: number;
  statRet: number;
  statErrno: number;
  statDetail: string;
  lstatRet: number;
  lstatErrno: number;
  lstatDetail: string;
  readlinkResult: string;
  openRet: number;
  openErrno: number;
  mountInfoDevPts: string;
  mountInfoDev: string;
  selinuxContext: string;
  fdCount: number;
}

export interface BatchOpenOptions {
  count: number;
  intervalMs: number;
  closeBetween: boolean;
  parallel: boolean;
}

export interface HoldOpenOptions {
  holdSeconds: number;
}

// Native functions
export const runPtyTest: (options: PtyTestOptions) => Promise<PtyTestResult>;
export const runShellControlTest: () => Promise<PtyTestResult>;
export const runForkptyTest: (options: PtyTestOptions) => Promise<PtyTestResult>;
export const runRecoveryTest: () => Promise<PtyTestResult>;
export const checkPtmxAttributes: () => PtmxAttrResult;
export const runBatchOpenTest: (options: BatchOpenOptions) => Promise<PtyTestResult>;
export const runHoldOpenTest: (options: HoldOpenOptions) => Promise<PtyTestResult>;
export const runAllElfTests: () => Promise<PtyTestResult>;
export const runToyboxTest: (cmd: string) => string;
export const runToyboxDirect: (variant: string) => string;
export const runThirdPartyCommand: (commandPath?: string, arg1?: string, arg2?: string) => string;
export const runToyboxPtySh: () => string;
export const runAbstractSocketTest: () => string;
export const runUnixPeerCredTest: () => string;
export const runAbstractSocketServer: () => Promise<string>;
export const runFileSocketServer: () => Promise<string>;
export const startContinuousTest: (options: ContinuousTestOptions, callback: (result: PtyTestResult) => void) => number;
export const stopContinuousTest: (taskId: number) => boolean;
export const collectSystemState: () => FullSystemState;
export const getLogFilePath: () => string;
export const triggerCrashForTesting: () => void;
export const initLogDir: (dir: string) => boolean;
export const runUsbDdkTest: () => string;
export const runRawUsbTest: () => string;
export const startUsbProxy: (fd: number) => boolean;
export const logToFile: (msg: string) => boolean;
