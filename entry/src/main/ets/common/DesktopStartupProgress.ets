import { curves } from '@kit.ArkUI';
import { DesktopProgressMotion, DesktopProgressSegment, DesktopProgressTimeline, StartupFrameCallback,
  desktopStartupMotion } from './DesktopStartup';

const DESKTOP_PROGRESS_HEIGHT: number = 6;
const DESKTOP_PROGRESS_FILL: string = '#1c2430';

@Component
export struct DesktopStartupProgress {
  @Prop @Watch('scheduleMotion') confirmed: number = 0;
  @Prop scan: boolean = false;
  @Prop fasterWebProgress: boolean = false;
  @Prop dark: boolean = false;
  onFullPaint: () => void = (): void => {};
  @State private fill: number = 0;
  @State private full: boolean = false;
  private visible: boolean = false;
  private queued: boolean = false;
  private accepted: number = -1;
  private motionId: number = 0;
  private timeline: DesktopProgressTimeline = new DesktopProgressTimeline();

  private scheduleMotion(): void {
    if (!this.visible || this.queued || this.confirmed <= this.accepted) {
      return;
    }
    this.queued = true;
    this.getUIContext().postFrameCallback(new StartupFrameCallback((): void => {
      this.queued = false;
      if (!this.visible || this.confirmed <= this.accepted) {
        return;
      }
      this.accepted = this.confirmed;
      if (this.accepted === 100) {
        const animation: number = ++this.motionId;
        const segment: DesktopProgressSegment = this.timeline.retarget(100, 0, Date.now(), 0, this.fasterWebProgress);
        this.getUIContext().animateTo({
          duration: segment.duration,
          curve: curves.cubicBezierCurve(1 / 3, segment.first, 2 / 3, segment.second),
          onFinish: (): void => {
            if (!this.visible || animation !== this.motionId) return;
            this.full = true;
            this.getUIContext().postFrameCallback(new StartupFrameCallback((): void => {
              if (this.visible && animation === this.motionId) {
                this.onFullPaint();
              }
            }));
          }
        }, (): void => {
          this.fill = 100;
        });
      } else {
        this.startMotion(desktopStartupMotion(this.accepted, this.fasterWebProgress));
      }
    }));
  }

  private startMotion(motion: DesktopProgressMotion): void {
    const animation: number = ++this.motionId;
    const lead: DesktopProgressSegment = this.timeline.retarget(motion.lead, motion.leadMs, Date.now(),
      (motion.limit - motion.lead) / motion.tailMs, this.fasterWebProgress && !this.scan);
    this.getUIContext().animateTo({
      duration: lead.duration,
      curve: curves.cubicBezierCurve(1 / 3, lead.first, 2 / 3, lead.second),
      onFinish: (): void => {
        if (!this.visible || animation !== this.motionId ||
          this.confirmed > this.accepted) {
          return;
        }
        const tail: DesktopProgressSegment = this.timeline.retarget(motion.limit, motion.tailMs, Date.now());
        this.getUIContext().animateTo({
          duration: tail.duration,
          curve: curves.cubicBezierCurve(1 / 3, tail.first, 2 / 3, tail.second)
        }, (): void => {
          this.fill = motion.limit;
        });
      }
    }, (): void => {
      this.fill = motion.lead;
    });
  }

  build() {
    Stack({ alignContent: Alignment.Start }) {
      if (this.full) {
        Row()
          .width('100%')
          .height('100%')
          .backgroundColor(this.dark ? '#FFFFFF' : DESKTOP_PROGRESS_FILL)
      } else {
        Stack({ alignContent: Alignment.Start }) {
          if (this.scan) {
            DesktopStartupScan()
              .transition(TransitionEffect.opacity(0).animation({ duration: 120, curve: Curve.EaseOut }))
          }
        }
        .width('100%')
        .height('100%')
        .borderRadius(DESKTOP_PROGRESS_HEIGHT / 2)
        .clip(true)
        .backgroundColor(this.dark ? '#FFFFFF' : DESKTOP_PROGRESS_FILL)
        .scale({ x: this.fill / 100, centerX: 0 })
      }
    }
    .width(200)
    .height(DESKTOP_PROGRESS_HEIGHT)
    .borderRadius(DESKTOP_PROGRESS_HEIGHT / 2)
    .clip(true)
    .backgroundColor(this.dark ? '#2A2A2E' : '#e4e7ec')
    .accessibilityRole(AccessibilityRoleType.PROGRESS)
    .onAppear((): void => {
      this.visible = true;
      this.scheduleMotion();
    })
    .onDisAppear((): void => {
      this.visible = false;
      this.motionId++;
    })
  }
}

@Component
struct DesktopStartupScan {
  @State private sweepX: number = -52;

  build() {
    Row()
      .width(52)
      .height('100%')
      .linearGradient({
        direction: GradientDirection.Right,
        colors: [['#00FFFFFF', 0], ['#80FFFFFF', 0.5], ['#00FFFFFF', 1]]
      })
      .translate({ x: this.sweepX })
      .accessibilityLevel('no')
      .onAppear((): void => {
        this.getUIContext().animateTo({ duration: 1350, curve: Curve.Linear, iterations: -1 }, (): void => {
          this.sweepX = 200;
        });
      })
  }
}
