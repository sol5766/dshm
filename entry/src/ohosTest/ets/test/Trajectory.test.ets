/**
 * 会话事件 → 轨迹条目的投影测试。
 *
 * 【这些样本从哪来】
 *   全部是 D2 §8.7.7 记录下来的**实测**键名与内层结构
 *   （来源：逐帧解码 Host 落盘的 `session.v3.jsonl.zstd`，
 *   1485 帧 / 5257 条记录，零凭据、零设备）。样本里的字面量不是编造的，
 *   是为了让「取值路径写错了」在真机之前就被测出来。
 *
 * 【为什么这类测试特别值得写】
 *   字段名写错**不会报错**：投影函数照样返回条目，只是正文空着。
 *   界面看起来「只是没内容」，而不是「坏了」——这类缺陷在真机上极难定位。
 *   所以这里逐条断言「正文从哪个字段取到」，把路径钉死。
 */

import { describe, expect, it } from '@ohos/hypium';
import { parseJson, readPath } from 'connection';
import {
  ContentSlot,
  eventShapeOf,
  isKnownEventType,
  KNOWN_EVENT_TYPE_COUNT,
  isMeasuredEventType,
  MEASURED_EVENT_TYPE_COUNT,
  SESSION_EVENT_SHAPES
} from 'dshcompat';
import { projectWireRecord, Speaker, ToolState, TrajectoryKind } from 'appstate';

/** 把一个 `event.data` 包成 `session/follow` 的 event 帧 */
function frame(eventType: string, dataJson: string): Object {
  const envelope: string = '{"type":"event","event":{"type":"' + eventType
    + '","seq":7,"time":1789051283087,"data":' + dataJson + '}}';
  const parsed: Object | undefined = parseJson(envelope);
  // 解析失败时返回一个**显式声明过**的 JSON 对象（ArkTS 禁止无类型对象字面量）
  if (parsed === undefined) {
    const empty: Record<string, Object> = {};
    return empty as Object;
  }
  return parsed;
}

export default function trajectoryProjectionTest() {
  describe('JsonPath', () => {
    it('walks nested segments', 0, () => {
      const value = parseJson('{"a":{"b":{"c":"deep"}}}');
      expect(readPath(value, 'a.b.c') as string).assertEqual('deep');
      expect(readPath(value, 'a.b') !== undefined).assertTrue();
    });

    it('returns the root itself for the $-path', 0, () => {
      const value = parseJson('{"a":1}');
      expect(readPath(value, '$') !== undefined).assertTrue();
    });

    it('returns undefined instead of throwing on missing or scalar segments', 0, () => {
      const value = parseJson('{"a":{"b":"leaf"},"n":null}');
      expect(readPath(value, 'a.nope') === undefined).assertTrue();
      // 中间段是标量：不能继续往下钻，也不能抛异常
      expect(readPath(value, 'a.b.c') === undefined).assertTrue();
      // 中间段是 null：同上
      expect(readPath(value, 'n.x') === undefined).assertTrue();
      // 空路径与空段都不是有效路径
      expect(readPath(value, '') === undefined).assertTrue();
      expect(readPath(value, 'a..b') === undefined).assertTrue();
      expect(readPath(undefined, 'a') === undefined).assertTrue();
    });

    it('can hand back an array container (content blocks are arrays)', 0, () => {
      const value = parseJson('{"message":{"content":[{"type":"text","text":"hi"}]}}');
      const blocks: Object | undefined = readPath(value, 'message.content');
      expect(Array.isArray(blocks)).assertTrue();
      expect((blocks as Object[]).length).assertEqual(1);
    });
  });

  describe('EventShapeTable', () => {
    /**
     * 形状表与 D2 §8.7.7 的清单必须条数一致。
     * 这条断言的作用是：**改了 D2 表格忘了改表**（或反之）会立刻失败。
     *
     * 口径：`session.v3.jsonl.zstd` 的**顶层事件记录**，不含 `session` 文件头，
     * 也**不含** `assistant/message.data.stream[]` 里的流式记录
     * （`text-chunks` / `reasoning-chunks` / `tool-call-chunks` / `chunk`）——
     * 它们有 `type` 但**不是事件类型**。这条口径差异曾经把清单
     * 从 32 污染到 39，所以专门有一条断言把它钉住。
     */
    it('covers exactly the measured event types', 0, () => {
      expect(SESSION_EVENT_SHAPES.length).assertEqual(32);
      expect(MEASURED_EVENT_TYPE_COUNT).assertEqual(32);
    });

    it('does not mistake assistant stream records for event types', 0, () => {
      expect(isMeasuredEventType('text-chunks')).assertFalse();
      expect(isMeasuredEventType('reasoning-chunks')).assertFalse();
      expect(isMeasuredEventType('tool-call-chunks')).assertFalse();
      expect(isMeasuredEventType('chunk')).assertFalse();
      // 文件头记录也不是事件类型
      expect(isMeasuredEventType('session')).assertFalse();
    });

    it('has no duplicate type and no duplicate slot within a type', 0, () => {
      const seen: string[] = [];
      for (let i = 0; i < SESSION_EVENT_SHAPES.length; i++) {
        const shape = SESSION_EVENT_SHAPES[i];
        expect(seen.indexOf(shape.type) < 0).assertTrue();
        seen.push(shape.type);
        const slots: string[] = [];
        for (let j = 0; j < shape.slots.length; j++) {
          const slot: string = shape.slots[j].slot as string;
          expect(slots.indexOf(slot) < 0).assertTrue();
          slots.push(slot);
        }
      }
    });

    /**
     * 每条绑定都必须给出实测路径，且路径语法合法。
     * 没有路径的绑定等于「这条槽位靠猜」——不允许。
     */
    it('gives every binding a well-formed path', 0, () => {
      for (let i = 0; i < SESSION_EVENT_SHAPES.length; i++) {
        const shape = SESSION_EVENT_SHAPES[i];
        for (let j = 0; j < shape.slots.length; j++) {
          const path: string = shape.slots[j].path;
          expect(path.length > 0).assertTrue();
          expect(path.indexOf('..') < 0).assertTrue();
          expect(path.charAt(path.length - 1) !== '.').assertTrue();
          if (path === '$') {
            // `$` 只允许用于「没有内容」的槽位
            expect(shape.slots[j].slot).assertEqual(ContentSlot.NONE);
          }
        }
      }
    });

    it('knows which types are measured', 0, () => {
      expect(isMeasuredEventType('tool/call')).assertTrue();
      expect(isMeasuredEventType('assistant/message')).assertTrue();
      expect(isMeasuredEventType('deliverables/presented')).assertTrue();
      expect(isMeasuredEventType('subagent/descriptor')).assertTrue();
      expect(isMeasuredEventType('session/title-llm-request')).assertTrue();
      // 被实测推翻的猜测前缀不得出现在表里
      expect(isMeasuredEventType('reasoning/delta')).assertFalse();
      expect(isMeasuredEventType('error/turn')).assertFalse();
      expect(isMeasuredEventType('job/update')).assertFalse();
    });

    /**
     * **两张表必须认识同一批类型**：形状表（字段路径）与家族表（呈现归类）。
     *
     * 两表不一致时失效方式是**静默的**：
     *   只登记在形状表 → 归类走「未知」分支、被汇总到诊断页（误报「未知事件」）；
     *   只登记在家族表 → 没有取值路径，条目正文永远为空（漏显）。
     * 所以把「键集一致」直接钉成断言，而不是靠人记住要同时改两处。
     */
    it('keeps the shape table and the family table in sync', 0, () => {
      expect(KNOWN_EVENT_TYPE_COUNT).assertEqual(SESSION_EVENT_SHAPES.length);
      for (let i = 0; i < SESSION_EVENT_SHAPES.length; i++) {
        const type: string = SESSION_EVENT_SHAPES[i].type;
        expect(isKnownEventType(type)).assertTrue();
        expect(isMeasuredEventType(type)).assertTrue();
      }
      const probes: string[] = [
        'turn/start', 'turn/end', 'step/start', 'step/end', 'session/title',
        'request/context', 'request/header', 'command/run', 'command/done',
        'agent/inbox/spliced', 'web/deepseek-search-llm-request', 'session/end-seed',
        'permission/preset', 'sandbox/mode', 'approval/policy',
        'subagent/descriptor', 'session/title-llm-request'
      ];
      for (let i = 0; i < probes.length; i++) {
        expect(isKnownEventType(probes[i])).assertTrue();
        expect(isMeasuredEventType(probes[i])).assertTrue();
      }
      // 未知类型必须两条判定都为假：这就是「升级后新事件」的检测入口
      expect(isKnownEventType('brand/new-event')).assertFalse();
      expect(isMeasuredEventType('brand/new-event')).assertFalse();
    });
  });

  describe('WireToTrajectory', () => {
    /**
     * 用户消息：正文 = `data.content[].text` 拼接。
     * 实测 `content` 是 `array<{type:'text', text}>`。
     */
    it('renders a user message from its content blocks', 0, () => {
      const item = projectWireRecord(frame('user/message',
        '{"id":"m1","role":"user","content":[{"type":"text","text":"第一段"},'
          + '{"type":"text","text":"第二段"}],"source":{"kind":"user"}}'));
      expect(item !== undefined).assertTrue();
      expect(item!.kind).assertEqual(TrajectoryKind.MESSAGE);
      expect(item!.speaker).assertEqual(Speaker.USER);
      expect(item!.body).assertEqual('第一段\n第二段');
    });

    /**
     * 助手消息：正文在 `message.content`，模型名在 `message.source.model`。
     * 实测 `source.model` 就是模型名所在（顶层没有 model 字段）。
     */
    it('renders an assistant message and reads the model from message.source.model', 0, () => {
      const item = projectWireRecord(frame('assistant/message',
        '{"turn":1,"step":1,"message":{"id":"a1","role":"assistant",'
          + '"content":[{"type":"text","text":"好的"}],'
          + '"source":{"kind":"model","provider":"deepseek","model":"DeepSeek-V41-Flash"}},'
          + '"usage":{"inputTokens":10,"outputTokens":3,"totalTokens":13}}'));
      expect(item !== undefined).assertTrue();
      expect(item!.speaker).assertEqual(Speaker.ASSISTANT);
      expect(item!.body).assertEqual('好的');
      expect(item!.model).assertEqual('DeepSeek-V41-Flash');
    });

    /**
     * 非文本块形状**尚未实测**，因此必须如实占位，
     * 而不是猜一个字段名去渲染（猜错会显示成空白，且不报错）。
     */
    it('marks non-text content blocks by type instead of guessing their fields', 0, () => {
      const item = projectWireRecord(frame('user/message',
        '{"content":[{"type":"text","text":"看图"},{"type":"image"}],"role":"user"}'));
      expect(item !== undefined).assertTrue();
      expect(item!.body).assertEqual('看图\n[image]');
    });

    it('renders a system message', 0, () => {
      const item = projectWireRecord(frame('system/message',
        '{"turn":1,"step":1,"message":{"role":"system","content":[{"type":"text","text":"已重置"}]}}'));
      expect(item !== undefined).assertTrue();
      expect(item!.kind).assertEqual(TrajectoryKind.MESSAGE);
      expect(item!.body).assertEqual('已重置');
    });

    /**
     * 工具调用：`name` + `arguments`。
     * 实测 `arguments` 是**JSON 编码后的字符串**——不能再编码一次
     * （那会让界面显示 `"{\"path\":\"a\"}"`，看起来像工具真的收到了带引号的参数）。
     */
    it('reads a tool call name and keeps the already-encoded arguments verbatim', 0, () => {
      const item = projectWireRecord(frame('tool/call',
        '{"turn":1,"step":2,"callId":"call-9","name":"read_file",'
          + '"arguments":"{\\"path\\":\\"a.txt\\"}"}'));
      expect(item !== undefined).assertTrue();
      expect(item!.kind).assertEqual(TrajectoryKind.TOOL);
      expect(item!.toolName).assertEqual('read_file');
      expect(item!.toolArgs).assertEqual('{"path":"a.txt"}');
      expect(item!.callId).assertEqual('call-9');
      // 还没结果 → 运行中
      expect(item!.toolState).assertEqual(ToolState.RUNNING);
    });

    /**
     * 工具结果：输出在 `message.content`，配对靠 `message.source.callId`。
     * **结果帧没有工具名**，所以它必须与调用共享同一个条目 id 才能合卡。
     *
     * 实测结构比文档更深一层：`message.content[0]` 是
     * `{type:'tool-result', content:[{type:'text',text}]}` —— 正文在内层 `content`。
     */
    it('reads a tool result and pairs it back through message.source.callId', 0, () => {
      const call = projectWireRecord(frame('tool/call',
        '{"callId":"call-9","name":"read_file","arguments":"{}"}'));
      const result = projectWireRecord(frame('tool/result',
        '{"turn":1,"step":2,"message":{"id":"t1","role":"tool",'
          + '"source":{"kind":"tool","callId":"call-9"},'
          + '"content":[{"type":"tool-result","toolCallId":"call-9","isError":false,'
          + '"content":[{"type":"text","text":"文件内容"}]}]}}'));
      expect(call !== undefined).assertTrue();
      expect(result !== undefined).assertTrue();
      expect(result!.kind).assertEqual(TrajectoryKind.TOOL);
      expect(result!.toolOutput).assertEqual('文件内容');
      expect(result!.callId).assertEqual('call-9');
      expect(result!.toolState).assertEqual(ToolState.SUCCESS);
      // 同一张工具卡：条目 id 一致（否则界面会出现「没有名字的结果」）
      expect(result!.id).assertEqual(call!.id);
      expect(result!.toolName).assertEqual('');
    });

    /**
     * **失败的工具结果**：实测失败形态同时带内层 `isError:true` 与顶层
     * `error{name,code}`。只读 `message.content` 会把失败显示成成功——
     * 这是最典型的静默错误，所以单独一条断言钉住。
     */
    it('marks a failed tool result as FAILED and surfaces the error code', 0, () => {
      const item = projectWireRecord(frame('tool/result',
        '{"turn":1,"step":8,"message":{"id":"t2","role":"user",'
          + '"source":{"kind":"tool","callId":"call-bad"},'
          + '"content":[{"type":"tool-result","toolCallId":"call-bad","isError":true,'
          + '"content":[{"type":"text","text":"Error: unknown tool \\"bash\\""}]}]},'
          + '"error":{"name":"ToolNotFoundError","code":"UNKNOWN_TOOL"}}'));
      expect(item !== undefined).assertTrue();
      expect(item!.toolState).assertEqual(ToolState.FAILED);
      expect(item!.expanded).assertTrue();
      expect(item!.toolOutput.indexOf('unknown tool') >= 0).assertTrue();
      expect(item!.toolOutput.indexOf('ToolNotFoundError') >= 0).assertTrue();
    });

    /** 交付物：实测 `files` 是数组（取首项路径与说明） */
    it('renders a delivered artifact row', 0, () => {
      const item = projectWireRecord(frame('deliverables/presented',
        '{"turn":1,"callId":"call-d","files":['
          + '{"path":"entry/src/main/ets/AppAbilityStage.ets","description":"新建：AbilityStage"},'
          + '{"path":"entry/src/main/module.json5","description":"修改：srcEntry"}]}'));
      expect(item !== undefined).assertTrue();
      expect(item!.kind).assertEqual(TrajectoryKind.DELIVERABLE);
      expect(item!.fileName).assertEqual('entry/src/main/ets/AppAbilityStage.ets');
      expect(item!.progress).assertEqual('新建：AbilityStage');
    });

    /** 子代理描述帧不是独立条目：它只把模型信息补回 catalog 那一行 */
    it('keeps the subagent descriptor out of the transcript', 0, () => {
      expect(projectWireRecord(frame('subagent/descriptor',
        '{"version":3,"mode":"continuable","provider":"spawn","label":"Wire multi-window",'
          + '"agentProvider":"deepseek-official","agentModel":"deepseek-flash",'
          + '"agentReasoningEffort":"high"}')) === undefined).assertTrue();
    });

    it('keeps the title-generation request out of the transcript', 0, () => {
      expect(projectWireRecord(frame('session/title-llm-request',
        '{"titleProvider":"session-title-first-prompt-llm","messageSeqs":[403],'
          + '"route":{"provider":"deepseek-official","model":"deepseek-flash"},'
          + '"system":"Create a concise title","messages":[],"maxTokens":64}')) === undefined).assertTrue();
    });

    it('renders a subagent catalog entry from its label', 0, () => {
      const item = projectWireRecord(frame('subagent/catalog',
        '{"version":1,"childId":"child-1","childCreatedAt":1789051283087,'
          + '"mode":"continuable","label":"调研上游协议"}'));
      expect(item !== undefined).assertTrue();
      expect(item!.kind).assertEqual(TrajectoryKind.SUBAGENT);
      expect(item!.title).assertEqual('调研上游协议');
      expect(item!.subagentName).assertEqual('调研上游协议');
    });

    it('renders a goal entry from goal.objective and goal.phase', 0, () => {
      const item = projectWireRecord(frame('goal/change',
        '{"kind":"change","version":1,"operation":"update","roundsStarted":2,'
          + '"goal":{"id":"g1","revision":3,"objective":"补齐 2in1 形态",'
          + '"phase":"active","maxGoalRounds":256},'
          + '"createdAt":1789051283087,"updatedAt":1789051283087}'));
      expect(item !== undefined).assertTrue();
      expect(item!.kind).assertEqual(TrajectoryKind.GOAL);
      expect(item!.title).assertEqual('补齐 2in1 形态');
      expect(item!.progress).assertEqual('active');
    });

    it('renders a todo list with a done/total progress', 0, () => {
      const item = projectWireRecord(frame('todo/write',
        '{"todos":[{"content":"写形状表","status":"completed"},'
          + '{"content":"接设置页","status":"in_progress"},'
          + '{"content":"跑真机","status":"pending"}]}'));
      expect(item !== undefined).assertTrue();
      expect(item!.kind).assertEqual(TrajectoryKind.JOB);
      expect(item!.body.indexOf('✓ 写形状表') >= 0).assertTrue();
      expect(item!.body.indexOf('▸ 接设置页') >= 0).assertTrue();
      expect(item!.body.indexOf('· 跑真机') >= 0).assertTrue();
      expect(item!.title).assertEqual('任务清单（1/3）');
      // 进度条百分比：1/3 → 33
      expect(item!.percent).assertEqual(33);
    });

    it('renders a compaction summary into the body', 0, () => {
      const item = projectWireRecord(frame('compaction/summary',
        '{"compactionId":"c1","summary":"前文已压缩为要点","model":"DeepSeek-V41-Flash",'
          + '"provider":"deepseek","usage":{"totalTokens":100}}'));
      expect(item !== undefined).assertTrue();
      expect(item!.body).assertEqual('前文已压缩为要点');
      expect(item!.model).assertEqual('DeepSeek-V41-Flash');
    });

    /**
     * 重试事件是「失败可视化」的真实来源（实测**不存在** `error/*` 事件族）。
     * D3 §4 要求失败必须默认可见，因此这类条目必须展开。
     */
    it('surfaces a retry event as an expanded error entry', 0, () => {
      const item = projectWireRecord(frame('llm/retry',
        '{"retry":2,"maxRetries":3,"mode":"auto","policyKey":"k","provider":"deepseek",'
          + '"delayMs":1500,"failure":{"kind":"network"},"retryId":"r1","step":1,"turn":1}'));
      expect(item !== undefined).assertTrue();
      expect(item!.kind).assertEqual(TrajectoryKind.ERROR);
      expect(item!.expanded).assertTrue();
      expect(item!.title).assertEqual('重试 2');
    });

    /**
     * 边界事件（轮次/步/标题）驱动状态但**不占行**：
     * 否则一次对话会被 step/start、step/end、turn/start 刷屏。
     */
    it('does not emit a row for boundary events', 0, () => {
      expect(projectWireRecord(frame('turn/start', '{"turn":1}')) === undefined).assertTrue();
      expect(projectWireRecord(frame('turn/end', '{"turn":1,"reason":{"kind":"done"}}')) === undefined).assertTrue();
      expect(projectWireRecord(frame('step/start', '{"turn":1,"step":1}')) === undefined).assertTrue();
      expect(projectWireRecord(frame('step/end', '{"turn":1,"step":1}')) === undefined).assertTrue();
      expect(projectWireRecord(frame('session/title',
        '{"title":"新标题","messageSeqs":[1,2],"source":{"kind":"auto"}}')) === undefined).assertTrue();
      expect(projectWireRecord(frame('session/end-seed', '{}')) === undefined).assertTrue();
    });

    /** 审计类事件有记录价值但没有对话内容：不进对话流 */
    it('skips audit events', 0, () => {
      expect(projectWireRecord(frame('permission/preset', '{"preset":"standard"}')) === undefined).assertTrue();
      expect(projectWireRecord(frame('sandbox/mode', '{"mode":"workspace-write"}')) === undefined).assertTrue();
      expect(projectWireRecord(frame('approval/policy', '{"policy":"ask"}')) === undefined).assertTrue();
    });

    /**
     * 未识别类型（升级后新出现的事件）**不得静默丢弃**：
     * 要按消息呈现原始载荷并展开，同时交给 noteUnknown() 汇总。
     * 「少了一截对话」比「多了一行原始 JSON」严重得多。
     */
    it('keeps an unknown event type visible instead of dropping it', 0, () => {
      const item = projectWireRecord(frame('brand/new-event', '{"payload":"x"}'));
      expect(item !== undefined).assertTrue();
      expect(item!.kind).assertEqual(TrajectoryKind.MESSAGE);
      expect(item!.expanded).assertTrue();
      expect(item!.body.indexOf('payload') >= 0).assertTrue();
    });

    it('ignores records that are not event frames', 0, () => {
      expect(projectWireRecord(parseJson('{"type":"snapshot"}')!) === undefined).assertTrue();
      expect(projectWireRecord(parseJson('{"type":"event"}')!) === undefined).assertTrue();
    });

    it('tolerates an event without a data object', 0, () => {
      const item = projectWireRecord(parseJson('{"type":"event","event":{"type":"user/message","seq":1,"time":2}}')!);
      // 没有 data 时仍然产出一条消息条目（正文为空），而不是抛异常或崩溃
      expect(item !== undefined).assertTrue();
      expect(item!.body).assertEqual('');
    });
  });
}
