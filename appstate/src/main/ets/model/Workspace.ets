/**
 * 工作区与文件系统的呈现层契约（D3 §1 信息架构的「工作区」分支）。
 */

/** 工作区列表项 */
export interface WorkspaceItem {
  id: string;
  /** 显示名（通常取目录 basename） */
  name: string;
  /** 绝对路径 */
  path: string;
  /** 关联会话数 */
  sessionCount: number;
  /** 是否为主工作区 */
  primary: boolean;
}

/** 文件树节点 */
export enum NodeKind {
  DIRECTORY = 'directory',
  FILE = 'file'
}

/** 文件条目 */
export interface FileNode {
  name: string;
  path: string;
  kind: NodeKind;
  /** 字节大小（目录为 0） */
  size: number;
  /** 修改时间（毫秒；0 = 未知） */
  modifiedAt: number;
  /** 目录是否已加载子节点 */
  loaded: boolean;
  /** 子节点（仅目录，且在展开后填充） */
  children: FileNode[];
  /** 该文件是否为本次会话的交付物 */
  deliverable: boolean;
}

/** 文件预览类型（决定用哪种渲染） */
export enum PreviewKind {
  TEXT = 'text',
  MARKDOWN = 'markdown',
  CODE = 'code',
  IMAGE = 'image',
  BINARY = 'binary',
  TOO_LARGE = 'too_large'
}

/** 文件预览结果 */
export interface FilePreview {
  path: string;
  name: string;
  kind: PreviewKind;
  /** 文本内容（仅 TEXT / CODE / MARKDOWN） */
  text: string;
  /** 语言标签（仅 CODE） */
  language: string;
  /** 字节大小 */
  size: number;
  /** 是否被截断（大文件只预览前 N 字节，D3 §7.5.3） */
  truncated: boolean;
  /** 无法预览时的说明 */
  note: string;
}

/** 单个文件的预览上限（字节）：超过即只显示前若干字节 */
export const PREVIEW_LIMIT_BYTES: number = 512 * 1024;

/** 按扩展名推导预览类型 */
export function previewKindOf(name: string, size: number): PreviewKind {
  if (size > PREVIEW_LIMIT_BYTES) {
    return PreviewKind.TOO_LARGE;
  }
  const dot: number = name.lastIndexOf('.');
  if (dot < 0) {
    return PreviewKind.TEXT;
  }
  const ext: string = name.substring(dot + 1).toLowerCase();
  if (ext === 'md' || ext === 'markdown') {
    return PreviewKind.MARKDOWN;
  }
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp' || ext === 'gif' || ext === 'svg') {
    return PreviewKind.IMAGE;
  }
  const codeExts: string[] = ['ets', 'ts', 'js', 'mjs', 'cjs', 'json', 'json5', 'yml', 'yaml',
    'cpp', 'cc', 'c', 'h', 'hpp', 'java', 'kt', 'py', 'go', 'rs', 'rb', 'php', 'swift',
    'sh', 'bash', 'ps1', 'sql', 'css', 'less', 'scss', 'html', 'xml', 'toml', 'ini', 'gradle'];
  for (let i = 0; i < codeExts.length; i++) {
    if (codeExts[i] === ext) {
      return PreviewKind.CODE;
    }
  }
  const textExts: string[] = ['txt', 'log', 'csv', 'tsv', 'env', 'gitignore'];
  for (let i = 0; i < textExts.length; i++) {
    if (textExts[i] === ext) {
      return PreviewKind.TEXT;
    }
  }
  return PreviewKind.BINARY;
}

/** 代码块语言标签（用于渲染着色提示） */
export function languageOf(name: string): string {
  const dot: number = name.lastIndexOf('.');
  if (dot < 0) {
    return 'text';
  }
  const ext: string = name.substring(dot + 1).toLowerCase();
  if (ext === 'ets') {
    return 'typescript';
  }
  if (ext === 'ts' || ext === 'mjs' || ext === 'cjs') {
    return 'typescript';
  }
  if (ext === 'js') {
    return 'javascript';
  }
  if (ext === 'yml' || ext === 'yaml') {
    return 'yaml';
  }
  if (ext === 'md' || ext === 'markdown') {
    return 'markdown';
  }
  return ext;
}

/** 文件大小与类型的可读摘要 */
export function fileSummary(node: FileNode, formatBytes: (n: number) => string): string {
  if (node.kind === NodeKind.DIRECTORY) {
    return node.loaded ? `${node.children.length} 项` : '目录';
  }
  const size: string = formatBytes(node.size);
  return size.length > 0 ? size : '文件';
}
