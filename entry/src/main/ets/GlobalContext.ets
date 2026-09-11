export interface DshmAbilityContextLike {
  filesDir: string;
}

class GlobalContextHolder {
  private static instance: GlobalContextHolder | null = null;
  private abilityContext: DshmAbilityContextLike | null = null;

  static getInstance(): GlobalContextHolder {
    if (!GlobalContextHolder.instance) {
      GlobalContextHolder.instance = new GlobalContextHolder();
    }
    return GlobalContextHolder.instance;
  }

  setContext(context: DshmAbilityContextLike): void {
    this.abilityContext = context;
  }

  clearContext(): void {
    this.abilityContext = null;
  }

  isInitialized(): boolean {
    return this.abilityContext !== null;
  }

  getContextInternal(): DshmAbilityContextLike {
    if (!this.abilityContext) {
      throw new Error('Global context is not initialized');
    }
    return this.abilityContext;
  }
}

const globalContextHolder: GlobalContextHolder = GlobalContextHolder.getInstance();

export function setContext(context: DshmAbilityContextLike): void {
  globalContextHolder.setContext(context);
}

export function clearContext(): void {
  globalContextHolder.clearContext();
}

export function isInitialized(): boolean {
  return globalContextHolder.isInitialized();
}

/**
 * 获取 DSHM 全局 AbilityContext。
 * @returns DshmAbilityContextLike 能力上下文
 * @throws Error 当全局上下文未初始化时抛出
 * @note API 23 适配：避免与系统废弃的 getContext() API 混淆
 */
export function getDshmContext(): DshmAbilityContextLike {
  return globalContextHolder.getContextInternal();
}

/**
 * @deprecated 请使用 getDshmContext() 替代，以避免与系统废弃 API 混淆
 */
export function getContext(): DshmAbilityContextLike {
  return globalContextHolder.getContextInternal();
}