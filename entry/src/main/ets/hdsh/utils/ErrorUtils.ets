/**
 * DSHM 统一错误工具。
 *
 * 目标：把「什么错误 → 给用户/日志看什么」收敛到一处，避免各模块散落裸字符串。
 * 用法：捕获后按其分类返回用户可读文案，并打点带分类前缀。
 */

/** 错误分类（安装 / 拉起 / 探活 / 网络 / 工作区 / 权限 / 未知）。 */
export enum DshErrorCategory {
  INSTALL = 0,
  LAUNCH = 1,
  DISCOVERY = 2,
  NETWORK = 3,
  WORKSPACE = 4,
  PERMISSION = 5,
  UNKNOWN = 6
}

/** 把 Error 或字符串统一转成消息文本。 */
export function errorToString(error: Error | string): string {
  if (error instanceof Error) {
    return error.message;
  }
  return error;
}

/** 返回错误分类的简短标签（用于日志前缀）。 */
export function errorCategoryLabel(category: DshErrorCategory): string {
  switch (category) {
    case DshErrorCategory.INSTALL:
      return 'install';
    case DshErrorCategory.LAUNCH:
      return 'launch';
    case DshErrorCategory.DISCOVERY:
      return 'discovery';
    case DshErrorCategory.NETWORK:
      return 'network';
    case DshErrorCategory.WORKSPACE:
      return 'workspace';
    case DshErrorCategory.PERMISSION:
      return 'permission';
    default:
      return 'unknown';
  }
}

/**
 * 生成统一错误文案。
 * 输出形如：`[install] 安装 DeepSeek Harness 失败：下载超时`
 *
 * @param category 错误分类
 * @param error 原始 Error 或消息
 * @param hint 可选的人类可读补充（如修复建议）
 */
export function formatErrorMessage(
  category: DshErrorCategory,
  error: Error | string,
  hint?: string
): string {
  const message = errorToString(error);
  const hintPart = hint !== undefined && hint.length > 0 ? `：${hint}` : '';
  return `[${errorCategoryLabel(category)}] ${message}${hintPart}`;
}

/** 校验数值是否为合法错误分类（用于外部传入时的护栏）。 */
export function isDshErrorCategory(value: number): boolean {
  return value >= DshErrorCategory.INSTALL && value <= DshErrorCategory.UNKNOWN;
}
