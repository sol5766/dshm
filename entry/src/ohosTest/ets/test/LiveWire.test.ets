/**
 * 真实接线投影测试（工作区 / 文件 / 命令 / `@` 引用 / Host 记录 / 详情分区）。
 *
 * 【这些用例防的是什么】
 *   这六块曾经**整块是桩数据**：文件树、工作区、斜杠命令、`@` 引用、设备页 Host 列表、
 *   详情栏分区。桩数据不会报错，所以「功能没接上」在界面上看起来和「功能正常」一模一样。
 *   本文件钉住的是「每一块都必须由**真实回复**投影出来」，以及几条容易写反的语义：
 *     - `entry.type` 是判别字段（不是 `kind`/`isDirectory`），未知取值**不得**当成文件；
 *     - 文件截断看 `eof`，**不能**拿 `text.length` 与 `bytes` 比大小（多字节字符会误判）；
 *     - 上游不给 mtime，所以 `modifiedAt` 只能是 0（不能拿拉取时刻冒充）；
 *     - loopback 判定必须精确，否则会把远端 Host 标成「直连 loopback」（安全性陈述）；
 *     - `commands/list` 返回的名字**可能不带前导 `/`**，补错会让命令发出去必然失败。
 *
 * 样本来源：`docs/11-请求载荷契约.md` §2.1 / §2.3 / §6.1 / §6.3（逐字取自上游声明文件）。
 */

import { describe, expect, it } from '@ohos/hypium';
import { ConfigurationConstant } from '@kit.AbilityKit';
import { KeyCode } from '@kit.InputKit';
import { parseJson } from 'connection';
import { hitOfKeyEvent } from '../../../main/ets/view/ShortcutKeys';
import type { ShortcutHit } from '../../../main/ets/view/ShortcutKeys';
import {
  assertNoSensitiveContent,
  authorityOfUrl,
  basenameOf,
  dedupeKeyOf,
  hostOfUrl,
  isLoopbackUrl,
  notificationFor,
  notifyInputForPending,
  notifyInputForTurn,
  NotifyKind,
  NOTIFY_PAGES,
  matchCounterText,
  matchTrajectoryIndices,
  stepMatch,
  parseNotifyRoute,
  PendingKind,
  projectCommands,
  RiskLevel,
  withdrawalKeysForPending,
  projectDetailSections,
  projectFileReferences,
  projectHosts,
  projectQueuedItems,
  projectSessionReferences,
  projectSessionPage,
  sessionCursorOf,
  sessionPagePayload,
  projectWorkspaceListing,
  projectWorkspaceFailure,
  projectWorkspaceText,
  projectWorkspaces,
  queuedItemsOf,
  queueEditAction,
  queueRemoveAction,
  queueSteerAction,
  keyEventSpecs,
  keyboardShortcutSpecs,
  SHORTCUTS,
  sessionUpdateQueuePayload,
  TrajectoryKind,
  makeItem,
  NodeKind,
  PreviewKind,
  Speaker,
  filePart,
  fileUploadPayload,
  projectWorkspaceBytes,
  textPart,
  workspaceListPayload,
  workspaceReadAllPayload,
  WORKSPACE_ROOT_REQUEST_PATH
} from 'appstate';
import type {
  DetailSection,
  FileNode,
  FilePreview,
  HostRecord,
  CommandCandidate,
  NotifyInput,
  PendingItem,
  PromptContentPart,
  QueuedItem,
  ReferenceCandidate,
  SessionListItem,
  SessionQueuedItem,
  TrajectoryItem,
  WorkspaceItem,
  WorkspaceListingProjection
} from 'appstate';
import type { NotificationDraft } from 'platform';
import { colorModeOf, ThemeMode, themeModeOf } from 'platform';

/** 造一个最小会话项 */
function session(id: string, cwd: string, updatedAt: number): SessionListItem {
  const raw: Record<string, Object> = {};
  return {
    id: id, title: id, cwd: cwd, updatedAt: updatedAt, createdAt: 0,
    running: false, blank: false, raw: raw as Object
  };
}

/** 造一个最小轨迹项 */
function item(id: string, kind: TrajectoryKind, at: number): TrajectoryItem {
  const out: TrajectoryItem = makeItem(id, kind, at);
  return out;
}

/** 造一个最小待决项（通知入参构造的输入） */
function makePending(id: string, kind: PendingKind, sessionId: string, title: string,
  detail: string): PendingItem {
  const raw: Record<string, Object> = {};
  return {
    id: id, kind: kind, sessionId: sessionId, sessionTitle: '', title: title, detail: detail,
    raw: JSON.stringify(raw), risk: RiskLevel.NORMAL, choices: [], multiSelect: false,
    allowFreeText: false, at: 0
  };
}

export default function liveWireTest() {
  describe('liveWire', () => {

    // ───────────────── Host 记录 ─────────────────

    it('projectHosts：未配置时返回空数组（不编造条目）', 0, () => {
      const list: HostRecord[] = projectHosts({
        url: '', connected: false, authority: '', authorized: false, version: ''
      });
      expect(list.length).assertEqual(0);
    });

    it('projectHosts：loopback 地址标为 L0 且 authority 从 URL 解析', 0, () => {
      const list: HostRecord[] = projectHosts({
        url: 'http://127.0.0.1:3115/?token=x', connected: true,
        authority: '127.0.0.1:3115', authorized: true, version: ''
      });
      expect(list.length).assertEqual(1);
      expect(list[0].isLoopback).assertTrue();
      expect(list[0].authority).assertEqual('127.0.0.1:3115');
      expect(list[0].level.indexOf('L0') >= 0).assertTrue();
      expect(list[0].authorized).assertTrue();
    });

    it('isLoopbackUrl：拒绝把 127.0.0.1.evil.com 判成 loopback', 0, () => {
      expect(isLoopbackUrl('http://127.0.0.1:3115')).assertTrue();
      expect(isLoopbackUrl('http://localhost:3115')).assertTrue();
      expect(isLoopbackUrl('http://[::1]:3115')).assertTrue();
      expect(isLoopbackUrl('http://127.0.0.1.evil.com:3115')).assertFalse();
      expect(isLoopbackUrl('http://10.0.0.5:3115')).assertFalse();
      // 反向代理形态：userinfo 里出现 127.0.0.1 也不能算
      expect(isLoopbackUrl('http://127.0.0.1@evil.com:3115')).assertFalse();
    });

    it('authorityOfUrl / hostOfUrl：去 userinfo、去端口、保留 IPv6 方括号', 0, () => {
      expect(authorityOfUrl('http://a:b@host:99/x?y=1')).assertEqual('host:99');
      expect(hostOfUrl('https://host:8443')).assertEqual('host');
      expect(hostOfUrl('https://[::1]:8443')).assertEqual('[::1]');
      expect(authorityOfUrl('host:1')).assertEqual('host:1');
    });

    // ───────────────── 工作区 ─────────────────

    it('projectWorkspaces：按 cwd 分组、会话最多者为「主」', 0, () => {
      const list: WorkspaceItem[] = projectWorkspaces([
        session('s1', 'D:\\dev\\a', 10),
        session('s2', 'D:\\dev\\a', 20),
        session('s3', 'D:\\dev\\b', 99),
        session('s4', '', 5)
      ]);
      expect(list.length).assertEqual(2);
      expect(list[0].sessionCount).assertEqual(2);
      expect(list[0].primary).assertTrue();
      expect(list[0].name).assertEqual('a');
      expect(list[1].primary).assertFalse();
    });

    it('projectWorkspaces：没有 cwd 的会话被忽略（无法浏览，不给出入口）', 0, () => {
      const list: WorkspaceItem[] = projectWorkspaces([session('s1', '', 1)]);
      expect(list.length).assertEqual(0);
    });

    it('basenameOf：容忍 / 与 \\ 及尾部斜杠', 0, () => {
      expect(basenameOf('D:\\dev\\proj')).assertEqual('proj');
      expect(basenameOf('/home/u/proj/')).assertEqual('proj');
      expect(basenameOf('')).assertEqual('');
    });

    // ───────────────── 文件列表 ─────────────────

    it('projectWorkspaceListing：拼出工作区相对路径，type 判别，未知类型不当成目录', 0, () => {
      const json = '{"path":"","truncated":false,"entries":['
        + '{"name":"docs","type":"directory"},'
        + '{"name":"README.md","type":"file","size":8192},'
        + '{"name":"sock","type":"other"}]}';
      const value: Object | undefined = parseJson(json);
      const out: WorkspaceListingProjection =
        projectWorkspaceListing(value, '', ['README.md']);
      expect(out.truncated).assertFalse();
      expect(out.nodes.length).assertEqual(3);
      expect(out.nodes[0].path).assertEqual('docs');
      expect(out.nodes[0].kind).assertEqual(NodeKind.DIRECTORY);
      expect(out.nodes[1].kind).assertEqual(NodeKind.FILE);
      expect(out.nodes[1].size).assertEqual(8192);
      expect(out.nodes[1].deliverable).assertTrue();
      // `other` 不是目录（把它当目录会让用户点开一个永远打不开的节点）
      expect(out.nodes[2].kind).assertEqual(NodeKind.FILE);
      // 上游不给 mtime：只能是 0，不能拿拉取时刻冒充
      expect(out.nodes[1].modifiedAt).assertEqual(0);
      expect(out.nodes[0].loaded).assertFalse();
    });

    it('projectWorkspaceListing：子层路径是 parent + "/" + name', 0, () => {
      const json = '{"path":"docs","truncated":true,"entries":[{"name":"a.md","type":"file"}]}';
      const out: WorkspaceListingProjection =
        projectWorkspaceListing(parseJson(json), 'docs', []);
      expect(out.truncated).assertTrue();
      expect(out.nodes[0].path).assertEqual('docs/a.md');
    });

    it('projectWorkspaceListing：无回复时返回空且不报错', 0, () => {
      const out: WorkspaceListingProjection = projectWorkspaceListing(undefined, '', []);
      expect(out.nodes.length).assertEqual(0);
      expect(out.truncated).assertFalse();
    });

    // ───────────────── 文件预览 ─────────────────

    it('projectWorkspaceText：truncated 由 eof 决定，不用长度比大小', 0, () => {
      // 多字节文本：text.length(6) < bytes(12)，若按长度比大小会误报「未截断」
      const json = '{"path":"a.md","bytes":12,"offset":1,"text":"你好世界","lines":1,"eof":false}';
      const p: FilePreview = projectWorkspaceText(parseJson(json), 'a.md', 'a.md', 0);
      expect(p.truncated).assertTrue();
      expect(p.kind).assertEqual(PreviewKind.MARKDOWN);
      expect(p.size).assertEqual(12);
    });

    it('projectWorkspaceText：SVG 走 SVG 的文本事实（IMAGE 降级为 CODE）', 0, () => {
      const json = '{"path":"i.svg","bytes":30,"offset":1,"text":"<svg/>","lines":1,"eof":true}';
      const p: FilePreview = projectWorkspaceText(parseJson(json), 'i.svg', 'i.svg', 0);
      expect(p.kind).assertEqual(PreviewKind.CODE);
      expect(p.truncated).assertFalse();
      expect(p.language.length > 0).assertTrue();
    });

    it('projectWorkspaceFailure：把上游拒绝理由带到界面上（不是空白）', 0, () => {
      const p: FilePreview = projectWorkspaceFailure('bin/out', 'out', '二进制文件');
      expect(p.kind).assertEqual(PreviewKind.BINARY);
      expect(p.note).assertEqual('二进制文件');
      expect(p.text).assertEqual('');
    });

    // ───────────────── 斜杠命令 ─────────────────

    it('projectCommands：补前导 /，读 description 与 input.hint', 0, () => {
      const json = '[{"name":"compact","description":"压缩上下文","input":{"hint":"<说明>"}},'
        + '{"name":"/clear","description":"清空视图"}]';
      const list: CommandCandidate[] = projectCommands(parseJson(json));
      expect(list.length).assertEqual(2);
      expect(list[0].name).assertEqual('/compact');
      expect(list[0].args).assertEqual('<说明>');
      expect(list[0].detail).assertEqual('压缩上下文');
      // 已经带 / 的不得补成 //
      expect(list[1].name).assertEqual('/clear');
      expect(list[1].args).assertEqual('');
    });

    it('projectCommands：无名条目跳过；无回复时为空', 0, () => {
      expect(projectCommands(parseJson('[{"description":"x"}]')).length).assertEqual(0);
      expect(projectCommands(undefined).length).assertEqual(0);
      expect(projectCommands(parseJson('{}')).length).assertEqual(0);
    });

    // ───────────────── @ 引用 ─────────────────

    it('projectFileReferences：目录插入带尾斜杠，文件插入裸路径', 0, () => {
      const json = '[{"path":"docs","kind":"directory"},{"path":"a.ts","kind":"file"}]';
      const list: ReferenceCandidate[] = projectFileReferences(parseJson(json));
      expect(list.length).assertEqual(2);
      expect(list[0].insert).assertEqual('@docs/');
      expect(list[1].insert).assertEqual('@a.ts');
      expect(list[1].kind).assertEqual('file');
    });

    it('projectSessionReferences：必须用上游给的 mention，不自行拼语法', 0, () => {
      const json = '[{"mention":"@session:abc","sessionId":"abc","label":"修网关","cwd":"D:/w"}]';
      const list: ReferenceCandidate[] = projectSessionReferences(parseJson(json));
      expect(list.length).assertEqual(1);
      expect(list[0].insert).assertEqual('@session:abc');
      expect(list[0].label).assertEqual('修网关');
      expect(list[0].kind).assertEqual('session');
    });

    // ───────────────── 详情分区 ─────────────────

    it('projectDetailSections：五个分区恒在，计数是真实条数', 0, () => {
      const t: TrajectoryItem[] = [
        item('t1', TrajectoryKind.TOOL, 1),
        item('t2', TrajectoryKind.TOOL, 2),
        item('t3', TrajectoryKind.DELIVERABLE, 3)
      ];
      const t1: TrajectoryItem = t[0];
      t1.toolName = 'read';
      const sections: DetailSection[] = projectDetailSections(t);
      expect(sections.length).assertEqual(5);
      expect(sections[0].title).assertEqual('工具调用');
      expect(sections[0].count).assertEqual(2);
      expect(sections[1].count).assertEqual(0);
      expect(sections[1].lines.length).assertEqual(0);
      expect(sections[1].emptyHint.length > 0).assertTrue();
      expect(sections[2].count).assertEqual(1);
    });

    it('projectDetailSections：空轨迹时每区都是空态（不显示别人的内容）', 0, () => {
      const sections: DetailSection[] = projectDetailSections([]);
      for (let i = 0; i < sections.length; i++) {
        expect(sections[i].count).assertEqual(0);
        expect(sections[i].lines.length).assertEqual(0);
      }
    });

    it('projectDetailSections：工具行带工具名与状态；不给 0ms 的假耗时', 0, () => {
      const t: TrajectoryItem[] = [item('t1', TrajectoryKind.TOOL, 1)];
      t[0].toolName = 'edit';
      const line: string = projectDetailSections(t)[0].lines[0];
      expect(line.indexOf('edit') === 0).assertTrue();
      expect(line.indexOf('0ms') < 0).assertTrue();
    });

    it('projectDetailSections：子代理行不因缺字段崩掉', 0, () => {
      const t: TrajectoryItem[] = [item('s1', TrajectoryKind.SUBAGENT, 1)];
      t[0].subagentName = '';
      const line: string = projectDetailSections(t)[1].lines[0];
      expect(line.length > 0).assertTrue();
    });

    it('makeItem/Speaker 保持默认（防止详情投影依赖未初始化字段）', 0, () => {
      const t: TrajectoryItem = makeItem('x', TrajectoryKind.GOAL, 1);
      expect(t.speaker).assertEqual(Speaker.ASSISTANT);
      expect(t.percent).assertEqual(-1);
    });

    it('FileNode 结构：目录用 children，交付物标记是布尔', 0, () => {
      const n: FileNode = {
        name: 'd', path: 'd', kind: NodeKind.DIRECTORY, size: 0, modifiedAt: 0,
        loaded: false, children: [], deliverable: false
      };
      expect(n.children.length).assertEqual(0);
      expect(n.deliverable).assertFalse();
    });

    // ───────────────── 工作区列表的请求词法（实测事实，极易猜错） ─────────────────

    it('workspaceListPayload：根目录的 path 必须是 "."，不是空串', 0, () => {
      // 实测：空串被 Host 拒绝 ——
      //   {"ok":false,"error":{"code":"gateway/bad-request","message":"path is required"}}
      // 而它**静默地**表现为一个空文件树（用户看到「这个目录是空的」，没有任何错误）。
      // 这条钉住的正是「必填 ≠ 知道根怎么写」这个坑。
      expect(WORKSPACE_ROOT_REQUEST_PATH).assertEqual('.');
      const args: Object | undefined = workspaceListPayload('s-1', WORKSPACE_ROOT_REQUEST_PATH);
      const bag: Record<string, Object> = args as Record<string, Object>;
      expect(bag['path'] as string).assertEqual('.');
      expect(bag['workspaceFileScopeId'] as string).assertEqual('s-1');
    });

    // ───────────────── 附件（上传回执 + 提示词片段） ─────────────────

    it('fileUploadPayload：线上参数名是 agentId，不是 agent', 0, () => {
      // 这条钉的是一个曾经真实存在的缺陷：按上游 **.d.ts 的形参名** 写成了 `agent`，
      // 而生成上表里的线上名是 `agentId`。发 `agent` 会被拒：
      //   gateway/arguments-invalid: missing "agentId"
      // 该端点在客户端此前从未被调用过，所以错误一直没暴露。
      const args: Object | undefined = fileUploadPayload('session-abc', 'AAEC', 'a.txt');
      const bag: Record<string, Object> = args as Record<string, Object>;
      expect(bag['agentId'] as string).assertEqual('session-abc');
      expect(bag['agent'] === undefined).assertTrue();
      const request: Record<string, Object> = bag['request'] as Record<string, Object>;
      expect(request['data'] as string).assertEqual('AAEC');
      expect(request['name'] as string).assertEqual('a.txt');
    });

    it('fileUploadPayload：空文件名不带 name 键（上游 name 可选）', 0, () => {
      const args: Object | undefined = fileUploadPayload('s', 'AA', '');
      const bag: Record<string, Object> = args as Record<string, Object>;
      const request: Record<string, Object> = bag['request'] as Record<string, Object>;
      expect(request['name'] === undefined).assertTrue();
    });

    it('workspaceReadAllPayload：无 range，只有 scope + path', 0, () => {
      const args: Object | undefined = workspaceReadAllPayload('s-1', 'docs/a.md');
      const bag: Record<string, Object> = args as Record<string, Object>;
      expect(bag['workspaceFileScopeId'] as string).assertEqual('s-1');
      expect(bag['path'] as string).assertEqual('docs/a.md');
      expect(bag['range'] === undefined).assertTrue();
    });

    it('projectWorkspaceBytes：无 data 或空 data 一律 undefined', 0, () => {
      // 「拿不到字节」必须与「字节是空串」一样被拒绝：用空 base64 去上传
      // 会产生一个 0 字节附件，而用户以为文件带上了。
      expect(projectWorkspaceBytes(undefined) === undefined).assertTrue();
      expect(projectWorkspaceBytes(parseJson('{"bytes":10}')) === undefined).assertTrue();
      expect(projectWorkspaceBytes(parseJson('{"bytes":10,"data":""}')) === undefined).assertTrue();
      const ok = projectWorkspaceBytes(parseJson('{"bytes":3,"data":"AAEC","eof":true,"offset":0}'));
      expect(ok === undefined).assertFalse();
      expect(ok!.bytes).assertEqual(3);
      expect(ok!.data).assertEqual('AAEC');
      expect(ok!.eof).assertTrue();
    });

    // ───────────────── 排队项（Host 侧待发队列） ─────────────────

    it('queuedItemsOf：从基线的 queues（sessionId → 数组）取本会话的条目', 0, () => {
      const queues: Object | undefined = parseJson(
        '{"s-1":[{"id":"m-1","placement":"queued","message":{"content":[{"type":"text","text":"甲"}]}}],'
        + '"s-2":[{"id":"m-9","placement":"steering","message":{"content":[]}}]}');
      const mine: SessionQueuedItem[] = queuedItemsOf(queues, 's-1');
      expect(mine.length).assertEqual(1);
      expect(mine[0].id).assertEqual('m-1');
      // 别的会话的条目**不得**混进来：混进来会让用户对着 A 的队列项在 B 上点"插话"
      const other: SessionQueuedItem[] = queuedItemsOf(queues, 's-2');
      expect(other.length).assertEqual(1);
      expect(other[0].id).assertEqual('m-9');
      expect(queuedItemsOf(queues, 's-3').length).assertEqual(0);
      expect(queuedItemsOf(undefined, 's-1').length).assertEqual(0);
    });

    it('projectQueuedItems：拼接文本块；只有非文本块时给一句说明而不是空串', 0, () => {
      const items: SessionQueuedItem[] = queuedItemsOf(parseJson(
        '{"s":['
        + '{"id":"a","placement":"queued","message":{"content":[{"type":"text","text":"第一行"},{"type":"text","text":"第二行"}]}},'
        + '{"id":"b","placement":"queued","message":{"content":[{"type":"text","text":"带附件"},{"type":"image","mediaType":"image/png"}]}},'
        + '{"id":"c","placement":"context","message":{"content":[{"type":"image"}]}},'
        + '{"id":"d","placement":"queued","message":{}}'
        + ']}'), 's');
      const out: QueuedItem[] = projectQueuedItems(items);
      expect(out.length).assertEqual(4);
      expect(out[0].text).assertEqual('第一行\n第二行');
      expect(out[1].text.indexOf('另有 1 个非文本块') > 0).assertTrue();
      // 只有图片时不能显示空串：空行会让用户分不清"坏掉了"与"只有附件"
      expect(out[2].text.indexOf('非文本块') > 0).assertTrue();
      expect(out[2].text.length > 0).assertTrue();
      expect(out[3].text).assertEqual('（无可显示内容）');
      // placement 原样带上（UI 据此说明"什么时候会被处理"）
      expect(out[2].placement).assertEqual('context');
    });

    it('sessionUpdateQueuePayload：三个动作的 kind 与编辑内容', 0, () => {
      const edit: Object | undefined =
        sessionUpdateQueuePayload('s-1', 'm-1', queueEditAction(['改后的文本']));
      const eb: Record<string, Object> = edit as Record<string, Object>;
      const er: Record<string, Object> = eb['request'] as Record<string, Object>;
      expect(er['sessionId'] as string).assertEqual('s-1');
      expect(er['itemId'] as string).assertEqual('m-1');
      const ea: Record<string, Object> = er['action'] as Record<string, Object>;
      expect(ea['kind'] as string).assertEqual('edit');
      const blocks: Object[] = ea['content'] as Object[];
      expect((blocks[0] as Record<string, Object>)['text'] as string).assertEqual('改后的文本');

      const del: Record<string, Object> =
        sessionUpdateQueuePayload('s-1', 'm-2', queueRemoveAction()) as Record<string, Object>;
      expect((((del['request'] as Record<string, Object>)['action']) as Record<string, Object>)['kind'] as string)
        .assertEqual('remove');

      const steer: Record<string, Object> =
        sessionUpdateQueuePayload('s-1', 'm-3', queueSteerAction()) as Record<string, Object>;
      expect((((steer['request'] as Record<string, Object>)['action']) as Record<string, Object>)['kind'] as string)
        .assertEqual('steer');
    });

    // ───────────────── 快捷键判定（D3 §5.1） ─────────────────

    it('hitOfKeyEvent：Esc / Enter / Alt+方向 / F5 各自的规格 id', 0, () => {
      expect(hitOfKeyEvent(KeyCode.KEYCODE_ESCAPE, false, false).id).assertEqual('stop-turn');
      // 带修饰键的 Esc 不是快捷键（避免吞掉将来的 Ctrl+Esc）
      expect(hitOfKeyEvent(KeyCode.KEYCODE_ESCAPE, true, false).id).assertEqual('');

      const send: ShortcutHit = hitOfKeyEvent(KeyCode.KEYCODE_ENTER, false, false);
      expect(send.id).assertEqual('send-message');
      expect(send.delta).assertEqual(0);
      // Shift+Enter = 换行：同一个规格 id，靠 delta 表达"不做发送"
      const newline: ShortcutHit = hitOfKeyEvent(KeyCode.KEYCODE_ENTER, true, false);
      expect(newline.id).assertEqual('send-message');
      expect(newline.delta).assertEqual(-1);
      // 小键盘回车等价
      expect(hitOfKeyEvent(KeyCode.KEYCODE_NUMPAD_ENTER, false, false).id).assertEqual('send-message');

      // Alt+↑/↓ 是**同一行同一规格**，方向靠 delta 区分
      expect(hitOfKeyEvent(KeyCode.KEYCODE_DPAD_UP, false, true).delta).assertEqual(-1);
      expect(hitOfKeyEvent(KeyCode.KEYCODE_DPAD_DOWN, false, true).delta).assertEqual(1);
      // 不带 Alt 的方向键必须不命中：否则在列表里按方向键会被当成快捷键吞掉
      expect(hitOfKeyEvent(KeyCode.KEYCODE_DPAD_UP, false, false).id).assertEqual('');

      expect(hitOfKeyEvent(KeyCode.KEYCODE_F5, false, false).id).assertEqual('reconnect');
      expect(hitOfKeyEvent(KeyCode.KEYCODE_F5, true, false).id).assertEqual('');
      // 无关按键：必须返回空 id（不是抛错、也不是随便给一个动作）
      expect(hitOfKeyEvent(KeyCode.KEYCODE_A, false, false).id).assertEqual('');
    });

    it('keyEventSpecs 的每一行都必须可被命中（表与实现不许漂移）', 0, () => {
      // 这条守的是"表里有、UI 里没接"这一类缺陷：`Shortcuts.ets` 的表是规范逐行对应物，
      // 若某一行在 `hitOfKeyEvent` 里没有对应分支，它会**静默不可达**——
      // 而这正是本项目在别处（待发队列、会话分叉、附件）反复踩到过的形态。
      const reachable: string[] = [];
      const probes: ShortcutHit[] = [
        hitOfKeyEvent(KeyCode.KEYCODE_ESCAPE, false, false),
        hitOfKeyEvent(KeyCode.KEYCODE_ENTER, false, false),
        hitOfKeyEvent(KeyCode.KEYCODE_ENTER, true, false),
        hitOfKeyEvent(KeyCode.KEYCODE_DPAD_UP, false, true),
        hitOfKeyEvent(KeyCode.KEYCODE_DPAD_DOWN, false, true)
      ];
      for (let i = 0; i < probes.length; i++) {
        if (probes[i].id.length > 0) {
          reachable.push(probes[i].id);
        }
      }
      const specs = keyEventSpecs();
      expect(specs.length > 0).assertTrue();
      for (let i = 0; i < specs.length; i++) {
        expect(reachable.indexOf(specs[i].id) >= 0).assertTrue();
      }
      // 声明式那条路（8 个规格）也要非空，否则"用 keyboardShortcut 绑定"就是空转
      expect(keyboardShortcutSpecs().length > 0).assertTrue();
      // 【规模构成必须被钉住】注释曾经把"12 行规范 / 12 个规格"写成"11 行 / 13 个"，
      // 而这两个数字是"规范覆盖了多少"的唯一凭据。断言构成，让注释再也漂移不了。
      let functionKeys: number = 0;
      for (let i = 0; i < keyboardShortcutSpecs().length; i++) {
        if (keyboardShortcutSpecs()[i].functionKey) {
          functionKeys++;
        }
      }
      expect(SHORTCUTS.length).assertEqual(12);
      expect(keyboardShortcutSpecs().length).assertEqual(9);   // 8 单字符 + 1 功能键
      expect(functionKeys).assertEqual(1);                     // F5
      expect(specs.length).assertEqual(3);                     // Enter / Esc / Alt+↑↓
      expect(keyboardShortcutSpecs().length + specs.length).assertEqual(SHORTCUTS.length);
    });

    // ───────────────── 通知：入参构造 + 内容纪律 ─────────────────

    it('notifyInputForPending：审批/提问各自的 kind，摘要取短标题而非 detail', 0, () => {
      const approval: PendingItem = makePending('p-1', PendingKind.APPROVAL, 's-1', 'Bash', 'rm -rf / 的完整参数……');
      const qi: NotifyInput = notifyInputForPending(approval, '会话甲', 'h-1');
      expect(qi.kind).assertEqual(NotifyKind.APPROVAL);
      expect(qi.sessionId).assertEqual('s-1');
      expect(qi.pendingId).assertEqual('p-1');
      // 摘要必须是**短标题**：正文只允许「标题：摘要」两段，塞长文本会被纪律自检拦下
      expect(qi.detailText).assertEqual('Bash');

      const q: PendingItem = makePending('p-2', PendingKind.QUESTION, 's-2', '选哪个？', '三个选项的详细解释…');
      expect(notifyInputForPending(q, '会话乙', 'h-1').kind).assertEqual(NotifyKind.QUESTION);
    });

    it('notifyInputForTurn：失败用 FAILURE，否则 TURN_DONE；正文不含摘要', 0, () => {
      const ok: NotifyInput = notifyInputForTurn('s-1', '会话甲', 'h-1', false);
      expect(ok.kind).assertEqual(NotifyKind.TURN_DONE);
      expect(ok.detailText).assertEqual('');
      expect(ok.pendingId).assertEqual('');
      expect(notifyInputForTurn('s-1', '会话甲', 'h-1', true).kind).assertEqual(NotifyKind.FAILURE);
    });

    it('withdrawalKeysForPending：按待决项自己的 kind 算键（撤错 kind 等于没撤）', 0, () => {
      const approval: PendingItem = makePending('p-9', PendingKind.APPROVAL, 's-1', 'Bash', '');
      const keys: string[] = withdrawalKeysForPending(approval);
      expect(keys.length).assertEqual(1);
      expect(keys[0]).assertEqual(dedupeKeyOf(NotifyKind.APPROVAL, 's-1', 'p-9'));
      const question: PendingItem = makePending('p-9', PendingKind.QUESTION, 's-1', '？', '');
      expect(withdrawalKeysForPending(question)[0])
        .assertEqual(dedupeKeyOf(NotifyKind.QUESTION, 's-1', 'p-9'));
    });

    it('内容纪律：疑似凭据不得原样出现在通知草稿里', 0, () => {
      // 这条守的是"通知会把敏感内容送上锁屏"这个安全边界。判据刻意不写成
      // "assertNoSensitiveContent 必须为真"——那是在断言**哪一层**做的脱敏；
      // 而真正要保证的性质是"草稿里没有原始凭据"。策略层先脱敏是更好的实现
      // （草稿本身就干净），两种情况都必须满足下面两条断言。
      const leaky: NotifyInput = notifyInputForPending(
        makePending('p-3', PendingKind.APPROVAL, 's-1', 'sk-abcdefghijklmnopqrstuvwxyz012345', ''), '会话甲', 'h-1');
      const draft: NotificationDraft = notificationFor(leaky);
      expect(draft.body.indexOf('sk-abcdefghijklmnop') < 0).assertTrue();
      expect(draft.title.indexOf('sk-abcdefghijklmnop') < 0).assertTrue();
      // 若某一层没脱敏，纪律自检必须把它拦下（两道防线都要在）
      if (draft.body.indexOf('sk-abcdefghijklmnop') >= 0) {
        expect(assertNoSensitiveContent(draft)).assertTrue();
      }
      // 正常标题不应被误拦（误拦会让所有通知都发不出去，而界面看不出原因）
      const normal: NotifyInput = notifyInputForPending(
        makePending('p-4', PendingKind.APPROVAL, 's-1', 'Bash', ''), '会话甲', 'h-1');
      expect(assertNoSensitiveContent(notificationFor(normal))).assertFalse();
      expect(notificationFor(normal).body.indexOf('Bash') >= 0).assertTrue();
    });

    it('parseNotifyRoute：坏 JSON / 未知页面名一律不跳转', 0, () => {
      // 通知点击的路由来自 Want 参数，可能是**旧版本应用**写下的。白名单校验
      // 是为了避免"点了通知什么都没发生、且没有任何线索"。
      expect(parseNotifyRoute('') === undefined).assertTrue();
      expect(parseNotifyRoute('not json') === undefined).assertTrue();
      expect(parseNotifyRoute('{"page":"nowhere"}') === undefined).assertTrue();
      expect(parseNotifyRoute('[]') === undefined).assertTrue();

      const pending = parseNotifyRoute('{"page":"pending","sessionId":"s-1","pendingId":"p-1"}');
      expect(pending === undefined).assertFalse();
      expect(pending!.page).assertEqual('pending');
      expect(pending!.pendingId).assertEqual('p-1');
      expect(pending!.sessionId).assertEqual('s-1');

      const diag = parseNotifyRoute('{"page":"diagnostics"}');
      expect(diag === undefined).assertFalse();
      expect(diag!.page).assertEqual('diagnostics');
      // 只挂真正需要的定位参数：诊断页不该带 sessionId（生产端 routeOf 也这么保证）
      expect(diag!.sessionId === undefined).assertTrue();

      // 与生产端对齐：routeOf 产出的页面名必须都在白名单里
      for (let i = 0; i < NOTIFY_PAGES.length; i++) {
        const one: string = `{"page":"${NOTIFY_PAGES[i]}"}`;
        expect(parseNotifyRoute(one) === undefined).assertFalse();
      }
    });

    // ───────────────── 一元读回历史（session/page） ─────────────────

    it('sessionCursorOf：游标取自 projections.asOfSeq；取不到给 -1（不是 0）', 0, () => {
      // 为什么"取不到"必须是 -1 而不是 0：0 是一个**合法游标**（对应第 0 条记录），
      // 用它去请求会得到一页"看起来正常"的空记录，把"读不到游标"伪装成"这个会话是空的"。
      expect(sessionCursorOf(parseJson('{"projections":{"asOfSeq":18}}'))).assertEqual(18);
      expect(sessionCursorOf(parseJson('{"projections":{"asOfSeq":0}}'))).assertEqual(0);
      expect(sessionCursorOf(parseJson('{"projections":{}}'))).assertEqual(-1);
      expect(sessionCursorOf(parseJson('{}'))).assertEqual(-1);
      expect(sessionCursorOf(undefined)).assertEqual(-1);
      expect(sessionCursorOf(parseJson('{"projections":{"asOfSeq":-3}}'))).assertEqual(-1);
      // 类型不符也要给 -1（老 Host 可能把它报成字符串）
      expect(sessionCursorOf(parseJson('{"projections":{"asOfSeq":"18"}}'))).assertEqual(-1);
    });

    it('sessionPagePayload：address 是 {kind,sessionId}，throughSeq 原样带上', 0, () => {
      const args: Object | undefined = sessionPagePayload('s-1', 18, 200);
      const bag: Record<string, Object> = args as Record<string, Object>;
      const request: Record<string, Object> = bag['request'] as Record<string, Object>;
      const address: Record<string, Object> = request['address'] as Record<string, Object>;
      expect(address['kind'] as string).assertEqual('session');
      expect(address['sessionId'] as string).assertEqual('s-1');
      expect(request['throughSeq'] as number).assertEqual(18);
      expect(request['maxMessages'] as number).assertEqual(200);
      // maxMessages<=0 时不带该键（让 Host 用它自己的默认值，而不是我们传一个 0 条的上限）
      const noMax: Record<string, Object> =
        sessionPagePayload('s-1', 3, 0) as Record<string, Object>;
      const req2: Record<string, Object> = noMax['request'] as Record<string, Object>;
      expect(req2['maxMessages'] === undefined).assertTrue();
    });

    it('projectSessionPage：records 与 hasMore 的收窄', 0, () => {
      const ok = projectSessionPage(parseJson('{"records":[{"type":"event"},{"type":"event"}],"hasMore":true}'));
      expect(ok.records.length).assertEqual(2);
      expect(ok.hasMore).assertTrue();
      const empty = projectSessionPage(undefined);
      expect(empty.records.length).assertEqual(0);
      expect(empty.hasMore).assertFalse();
      // 形状不对时给空而不是抛错：调用方据此走"读不到"分支
      expect(projectSessionPage(parseJson('{"records":"nope"}')).records.length).assertEqual(0);
    });

    // ───────────────── 本机偏好：主题模式 ─────────────────

    it('themeModeOf：未知取值一律回到"跟随系统"', 0, () => {
      expect(themeModeOf('light')).assertEqual(ThemeMode.LIGHT);
      expect(themeModeOf('dark')).assertEqual(ThemeMode.DARK);
      expect(themeModeOf('system')).assertEqual(ThemeMode.SYSTEM);
      // 存坏值不该让应用停在随机主题上，也不该抛错
      expect(themeModeOf('')).assertEqual(ThemeMode.SYSTEM);
      expect(themeModeOf('LIGHT')).assertEqual(ThemeMode.SYSTEM);
      expect(themeModeOf('blue')).assertEqual(ThemeMode.SYSTEM);
    });

    it('主题模式往返：枚举值与持久化字符串必须一一对应', 0, () => {
      // 这条守的是"用户选了深色，下次启动又回到跟随系统"这类静默失效：
      // 它不会报错，只会让用户觉得这个设置时灵时不灵。
      const all: ThemeMode[] = [ThemeMode.SYSTEM, ThemeMode.LIGHT, ThemeMode.DARK];
      for (let i = 0; i < all.length; i++) {
        expect(themeModeOf(all[i] as string)).assertEqual(all[i]);
      }
    });

    it('colorModeOf：三种模式各自映射到系统的 ColorMode', 0, () => {
      expect(colorModeOf(ThemeMode.LIGHT)).assertEqual(ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT);
      expect(colorModeOf(ThemeMode.DARK)).assertEqual(ConfigurationConstant.ColorMode.COLOR_MODE_DARK);
      expect(colorModeOf(ThemeMode.SYSTEM)).assertEqual(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
    });

    // ───────────────── 会话内搜索 ─────────────────

    it('matchTrajectoryIndices：大小写不敏感，搜正文/工具/交付物等可见字段', 0, () => {
      const t: TrajectoryItem[] = [
        item('a', TrajectoryKind.MESSAGE, 1),
        item('b', TrajectoryKind.TOOL, 2),
        item('c', TrajectoryKind.DELIVERABLE, 3)
      ];
      t[0].body = 'Fix the Parser bug';
      t[1].toolName = 'edit';
      t[1].toolArgs = 'file=parser.ts';
      t[2].fileName = 'docs/report.md';

      const forParser = matchTrajectoryIndices(t, 'parser');
      expect(forParser.length).assertEqual(2);   // 正文 + 工具参数
      expect(matchTrajectoryIndices(t, 'PARSER').length).assertEqual(2);
      expect(matchTrajectoryIndices(t, 'report.md').length).assertEqual(1);
      expect(matchTrajectoryIndices(t, 'nothing-here').length).assertEqual(0);
      // 空关键词不返回全部（否则"打开搜索框"就等于全选，计数会变成条目总数）
      expect(matchTrajectoryIndices(t, '   ').length).assertEqual(0);
    });

    it('stepMatch：环绕且从头开始，未选中时两个方向都给到端点', 0, () => {
      // 三条语义都要对，否则用户会觉得"跳转坏了"：
      const total = 3;
      expect(stepMatch(-1, total, 1)).assertEqual(0);    // 还没选中 → 下一个从头
      expect(stepMatch(-1, total, -1)).assertEqual(2);   // 还没选中 → 上一个从尾
      expect(stepMatch(2, total, 1)).assertEqual(0);     // 末尾 → 环绕到开头
      expect(stepMatch(0, total, -1)).assertEqual(2);    // 开头 → 环绕到末尾
      expect(stepMatch(1, total, 1)).assertEqual(2);
      // 无命中 / delta=0 一律 -1（不是 0：0 是合法位置，会把"没有命中"显示成"第 1 个"）
      expect(stepMatch(0, 0, 1)).assertEqual(-1);
      expect(stepMatch(0, total, 0)).assertEqual(-1);
    });

    it('matchCounterText：未选中时显示 1/总数（而不是 0/总数）', 0, () => {
      expect(matchCounterText(-1, 12)).assertEqual('1/12');
      expect(matchCounterText(2, 12)).assertEqual('3/12');
      expect(matchCounterText(-1, 0)).assertEqual('0/0');
    });

    it('textPart / filePart：判别字段与载荷', 0, () => {
      const t: PromptContentPart = textPart('你好');
      expect(t.type).assertEqual('text');
      expect(t.text).assertEqual('你好');
      const f: PromptContentPart = filePart('r-1');
      expect(f.type).assertEqual('file');
      expect(f.receiptId).assertEqual('r-1');
      // 文件片段**不得**带 text/data：多带字段会让上游的联合类型判别变得含糊
      expect(f.text === undefined).assertTrue();
      expect(f.data === undefined).assertTrue();
    });
  });
}
