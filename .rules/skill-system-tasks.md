# 技能：任务管理与系统通知

**适用场景**：需要在后台执行长时任务、跨模块派发任务、订阅任务进度、显示常驻或临时通知时，按本技能的标准模式接入，不要自行引入底层的 `@ohos.resourceschedule.backgroundTaskManager` 和 `@kit.NotificationKit`。
- **长时任务与保活**（如下载、解压、数据同步）
- **常驻通知与进度条**（随任务进度实时更新的系统通知）
- **意图与事件驱动**（跨模块拉起后台任务）
- **强类型任务进度监听**（在页面或服务中订阅任务的实时状态）

**自动触发条件（满足任意一条即应主动阅读本文件）**：
- 任务涉及后台下载、文件上传、数据同步、常驻通知、进度条通知、任务派发或系统事件订阅监听
- 需要在页面中通过 `@StorageProp('ngf_tasks_map')` 渲染任务列表
- 需要通过 `ngfSystem.submitTask` 执行长时逻辑
- 需要通过系统总线 `ngf.intent.action.SUBMIT_TASK` 拉起意图

---

## 1. 总体原则

- **统一入口**：统一使用 `ngfSystem` 门面（`ISystemIntegration` 契约），不要直接访问独立的 `ngfTaskManager` 或底层的 `ngfStarterKernel.eventBus`。
- **自动生命周期托管**：门面会自动在任务 `RUNNING` 时请求权限、获取 `KEEP_BACKGROUND_RUNNING` 保活锁并发出 `isOngoing=true`（常驻）的通知。任务结束后自动释放保活锁并转化为可清除通知，开发者切勿手动干预保活与通知的生命周期。
- **不要滥用常驻任务**：仅在确定操作极为耗时（通常超过 1 秒）且需要在息屏后继续存活时才使用 `submitTask`。普通的数据处理直接使用 `Promise` 即可。
- **强类型回调**：利用 `ngfSystem.onTaskProgress` 获取解析好的 `NGFTaskInfo`，避免自己解析 JSON 载荷。

---

## 2. 任务调度与系统通知（SystemIntegrationFacade）

### 2.1 AppStorage Keys（用于 @StorageProp 响应式绑定）

| Key | 类型 | 说明 |
|-----|------|------|
| `'ngf_tasks_map'` | `Map<string, NGFTaskInfo>` | 当前所有的后台任务映射表，可用于渲染全局任务面板 |

### 2.2 导入

```typescript
import {
  ngfSystemNotificationManager,
  NGFNotificationType,
  NGFNotificationRequest,
  ngfBackgroundTaskManager,
  ngfSystem
} from 'ngf_framework';
```

### 2.3 标准读取模式（响应式）

由于 ArkUI 的 `Map` 响应特性限制，通常需要转为数组进行迭代：

```typescript
@Component
struct NGFTaskManagerPage {
  // UI 层响应式绑定，任务状态/进度变化时自动重绘
  @StorageProp('ngf_tasks_map') tasksMap: Map<string, NGFTaskInfo> = new Map();

  build() {
    List() {
      ForEach(Array.from(this.tasksMap.values()), (task: NGFTaskInfo) => {
        ListItem() {
          Text(`${task.name} 状态: ${task.state} 进度: ${task.progress}%`)
        }
      }, (task: NGFTaskInfo) => task.taskId)
    }
  }
}
```

### 2.4 标准写操作（派发长时任务）

开发者只需要专注业务逻辑，通知申请、常驻通知发送、保活锁等统统由系统包办。

```typescript
ngfSystem.submitTask('核心数据同步', async (taskId: string, updateCallback: (progress: number, total: number, message: string) => void) => {
  const totalSize = 100;
  let currentProgress = 0;
  
  // 1. 初始化进度
  updateCallback(0, totalSize, '准备同步...');
  
  // 2. 执行你的耗时操作
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    currentProgress += 10;
    
    // 3. 实时汇报进度，系统会自动更新系统下拉栏的常驻通知，并在总线派发事件
    updateCallback(currentProgress, totalSize, `正在同步 (${currentProgress}%)`);
  }
  
  // 4. 任务结束
  updateCallback(totalSize, totalSize, '同步完成');
}).then((taskId: string) => {
  logger.info(TAG, `任务已提交成功，ID: ${taskId}`);
}).catch((e: Error) => {
  logger.error(TAG, `任务提交失败: ${e}`);
});
```

### 2.5 强类型系统事件订阅

当你想在一个后台服务或跨页面的地方监听其他模块派发的任务进度时：

```typescript
const progressListener = (taskInfo: NGFTaskInfo) => {
  logger.info(TAG, `监听到任务进度更新: ${taskInfo.name} -> ${taskInfo.progress}`);
};

aboutToAppear(): void {
  // 注册强类型监听器，免除 JSON.parse 的苦恼
  ngfSystem.onTaskProgress('MyPage_ProgressListener', progressListener);
}

aboutToDisappear(): void {
  // 对称移除监听器
  ngfSystem.removeTaskListener('ngf.task.progress', 'MyPage_ProgressListener');
}
```

### 2.6 意图驱动任务派发 (Intent Action)

除了在代码中显式调用 `submitTask` 之外，还可以通过发送全局系统意图来拉起任务：

```typescript
import { NGFEventPayload, NGFIntentTaskExecutor, NGFSubmitTaskIntentRequest, NGFTaskProgressUpdater } from 'ngf_framework';

const executor: NGFIntentTaskExecutor = async (
  taskId: string,
  updateCallback: NGFTaskProgressUpdater,
  request: NGFSubmitTaskIntentRequest
) => {
  updateCallback(0, 100, '准备执行...');
  // request.payloadJson 可由执行器按自己的强类型协议解析
  updateCallback(100, 100, '执行完成');
};

ngfSystem.registerIntentTaskExecutor('download.executor', executor);

// 发布一个提交任务的意图。框架只调度已注册的 executorName，不再内置模拟任务。
const payloadJson = JSON.stringify({
  executorName: 'download.executor',
  taskName: '意图驱动下载任务',
  payloadJson: JSON.stringify({ url: 'https://...' })
});
const payload = new NGFEventPayload('ngf.intent.action.SUBMIT_TASK', payloadJson, Date.now());

ngfSystem.publishSystemEvent('ngf.intent.action.SUBMIT_TASK', payload);
```

### 2.7 可用方法与事件速查

#### 统一门面方法
| 方法 | 说明 |
|------|------|
| `submitTask(name, executor): Promise<string>` | 派发一个受托管的长时后台任务 |
| `getTask(taskId): NGFTaskInfo` | 获取单条任务详情 |
| `getAllTasks(): Array<NGFTaskInfo>` | 获取所有缓存的任务列表 |
| `onTaskProgress(id, listener)` | 订阅任务进度更新（强类型 `NGFTaskInfo`） |
| `onTaskCompleted(id, listener)` | 订阅任务完成事件（强类型 `NGFTaskInfo`） |
| `onTaskFailed(id, listener)` | 订阅任务失败事件（强类型 `NGFTaskInfo`） |
| `removeTaskListener(eventName, id)` | 移除指定的强类型任务监听器 |
| `publishSystemEvent(eventName, payload)` | 基础事件底层：发布系统级意图/事件 |
| `subscribeSystemEvent(eventName, id, listener)`| 基础事件底层：订阅系统级意图/事件 |

#### 系统内置的事件枚举 (Event Names)
| 事件名 | 触发时机 | 默认载荷类型 |
|--------|---------|-------------|
| `ngf.intent.action.SUBMIT_TASK` | 跨模块意图拉起任务时 | 自定义 JSON (包含 `name` 等参数) |
| `ngf.task.started` | 任务被系统调度进入 RUNNING 时 | `NGFTaskInfo` (序列化 JSON) |
| `ngf.task.progress` | Executor 调用 updateCallback 时 | `NGFTaskInfo` (序列化 JSON) |
| `ngf.task.completed` | 任务正常执行结束时 | `NGFTaskInfo` (序列化 JSON) |
| `ngf.task.failed` | 任务抛出异常失败时 | `NGFTaskInfo` (序列化 JSON) |
