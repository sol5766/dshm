/**
 * 凭据配置浮层（P2-11：从 `Index.ets` 抽出的第四个浮层组件）。
 *
 * ## 它拥有什么
 *
 * "为某个引用写一次凭据"的**表单**：标题（配置哪个引用）、一句"明文不留副本"的承诺、
 * 密码输入框、「取消 / 保存到 Host」、「清除 Host 上的这项凭据」（只对已配置的引用出现），
 * 以及这一层自己的结果出口。
 *
 * ## 三条不能动的语义（都是真机实测换来的）
 *
 * 1. **输入框显式 44vp 高**（E95）：不给高度时输入框会跟着父级约束变化，
 *    真机上出现过"凭据值铺满整屏"的观感。44vp 是单行输入的标准高度。
 * 2. **明文只在这一次请求里存在**：提交时宿主**先清草稿再发请求**（见 `Index.submitCredential`）；
 *    关闭时也清（`closeCredentialSheet`）。组件不持久化任何东西。
 * 3. **成功时必须关掉浮层**：`HubSnapshot` 里没有凭据写入的结果字段，而浮层盖住了凭据列表
 *    ——用户看不到状态已经变成「已配置」，会以为写入没生效（实测踩到：Host 已 `configured=true`，
 *    界面还停在浮层上）。故关面板的时机由宿主的提交逻辑决定，不在这里。
 *
 * ## 边界
 *
 * · **草稿与回执**留在宿主：宿主用草稿判断"浮层是否开着"（`overlayState.credentialOpen`）、
 *   回执归属由宿主统一认领（E353 的 `sheetNoteOwner`）——这三个"设置类"浮层（凭据/文本/结构）
 *   共用同一套归属标记，抽组件时**不拆散它**；
 * · **写入副作用**（`credentials/set` / `credentials/unset`、成功关面板、失败留在浮层）全在宿主。
 */

import { Fs, HarmonySpacing, Radius, Sp } from 'appstate';

/** 凭据配置浮层 */
@Component
export struct CredentialSheet {
  /** 正在配置的凭据引用（显示用；也是写入的目标） */
  @Prop credentialRef: string = '';
  /** 该引用在 Host 上是否已配置（决定要不要给「清除」入口） */
  @Prop configured: boolean = false;
  /** 用户正在输入的凭据值（真值在宿主；提交后立即清空） */
  @Prop draft: string = '';
  /** 结果 / 进度文案（空串 = 不显示） */
  @Prop note: string = '';
  /** 这一层的回执是否属于自己（归属标记由宿主统一管，见 E353） */
  @Prop noteOwned: boolean = false;
  /** 请求进行中（防重复提交） */
  @Prop busy: boolean = false;
  /** 输入变化（宿主落状态） */
  onDraftChange: (value: string) => void = () => {
  };
  /** 保存到 Host（副作用在宿主） */
  onSubmit: () => void = () => {
  };
  /** 清除 Host 上的这项凭据（副作用在宿主） */
  onClear: () => void = () => {
  };
  /** 取消 / 关闭 */
  onClose: () => void = () => {
  };

  build() {
    Column() {
      Column({ space: Sp.S }) {
        Text(`配置 ${this.credentialRef}`)
          .fontSize(Fs.BODY)
          .width('100%')
        Text('值会写入 Host 的凭据存储；本客户端只在这一次请求里持有明文，不会保存副本。')
          .fontSize(Fs.CAPTION)
          .fontColor($r('sys.color.font_tertiary'))
          .width('100%')

        TextInput({ placeholder: '粘贴凭据值', text: this.draft })
          .type(InputType.Password)
          .enableAutoFill(false)
          .width('100%')
          // 【显式高度（E95）】不给高度时，输入框会跟着父级约束变化；真机上出现过
          // "凭据值铺满整屏"的观感。44vp 是单行输入的标准高度，明确写出来最省事。
          .height(44)
          .onChange((v: string) => {
            this.onDraftChange(v);
          })

        Row({ space: Sp.S }) {
          Button('取消')
            .layoutWeight(1)
            .backgroundColor($r('sys.color.background_secondary'))
            .fontColor($r('sys.color.font_primary'))
            .enabled(!this.busy)
            .onClick(() => {
              this.onClose();
            })
          Button(this.busy ? '写入中…' : '保存到 Host')
            .layoutWeight(1)
            .enabled(this.draft.length > 0 && !this.busy)
            .onClick(() => {
              this.onSubmit();
            })
        }
        .width('100%')

        if (this.configured) {
          Button('清除 Host 上的这项凭据')
            .width('100%')
            .enabled(!this.busy)
            .backgroundColor($r('sys.color.background_secondary'))
            .fontColor($r('sys.color.warning'))
            .onClick(() => {
              this.onClear();
            })
        }

        if (this.noteOwned && this.note.length > 0) {
          Text(this.note)
            .fontSize(Fs.CAPTION)
            .fontColor($r('sys.color.font_secondary'))
            .width('100%')
        }
      }
      .width('100%')
      // 浮层自身也不该铺满：最多占屏高 80%（凭据浮层通常很短；这条是防止
      // "某个字段把面板撑开"这类观感再次发生）
      .constraintSize({ maxHeight: '80%' })
      .padding(Sp.L)
      .borderRadius(Radius.L)
      .backgroundColor($r('sys.color.background_secondary'))
    }
    .width('100%')
    .padding(HarmonySpacing.CONTAINER)
  }
}
