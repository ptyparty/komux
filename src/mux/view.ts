import { BoxRenderable, TextRenderable, bg, bold, fg, type CliRenderer, type StyledText } from "@opentui/core";
import { styled, type Part } from "../ui/styled.ts";
import { age } from "../claude/sessions.ts";
import { leaderLabel, type Hint } from "./keymap.ts";
import { firstLine, fit } from "./fit.ts";
import { JobsPanel, jobBadge, jobDetail } from "./jobs-panel.ts";
import { KeysCard, PaletteCard } from "./keys-card.ts";
import { Launcher, type EntryLook } from "./launcher.ts";
import { paneIds, shownPaneTab, type LayoutNode, type PaneId, type TabsNode } from "./layout.ts";
import type { Pane, PaneChrome } from "./pane.ts";
import { appColor, card, theme } from "./theme.ts";
import type { Tray } from "./tray.ts";
import type { AgentState, CommandState, SwitchEntry, Workspace } from "./workspace.ts";

export class MuxView {
  private readonly body: BoxRenderable;
  private readonly modeBar: TextRenderable;
  private readonly trayBar: TextRenderable;
  private trayRanges: { start: number; end: number; index: number; job?: PaneId }[] = [];
  private readonly jobsBar: TextRenderable;
  private jobRanges: { start: number; end: number; id: PaneId }[] = [];
  private readonly hintBar: TextRenderable;
  private readonly keysChip: TextRenderable;
  private readonly keysCard: KeysCard;
  private readonly paletteCard: PaletteCard;
  private readonly overlay: BoxRenderable;
  private bodySignature = "";
  private paneTabStrips: { row: BoxRenderable; strip: TextRenderable; group: TabsNode; ranges: { start: number; end: number; id: PaneId }[] }[] = [];
  private readonly launcher: Launcher;
  private readonly jobsPanel: JobsPanel;
  private readonly toastBox: BoxRenderable;
  private toastCards: { box: BoxRenderable; text: TextRenderable; target: PaneId }[] = [];
  private readonly dock: TextRenderable;
  private dockJobs: PaneId[] = [];
  private overlayPane: PaneId | undefined;
  private readonly drawerBox: BoxRenderable;
  private readonly drawerSlider: BoxRenderable;
  private drawerFrame: BoxRenderable | undefined;
  private drawerShown: PaneId | undefined;
  private drawerTab: number | undefined;
  private slide: { direction: "in" | "out"; started: number; timer: Timer } | undefined;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly workspace: Workspace,
    private readonly panes: Map<PaneId, Pane>,
    private readonly tray: Tray,
    private readonly actions: {
      onFocusPane: (id: PaneId) => void;
      onOpenWidget: (index: number) => void;
      onOpenJob: (id: PaneId) => void;
      onOpenKeys: () => void;
      jobLine: (id: PaneId) => string | undefined;
      conversationTitle: (dir: string) => string | undefined;
    },
  ) {
    const root = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", height: "100%", backgroundColor: theme.background, paddingLeft: 1, paddingRight: 1 });
    this.body = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "row", minHeight: 0 });
    const statusRow = new BoxRenderable(renderer, { height: 1, flexDirection: "row", flexShrink: 0, backgroundColor: theme.surface });
    this.modeBar = new TextRenderable(renderer, { height: 1, flexGrow: 1, flexShrink: 1, minWidth: 0, wrapMode: "none", bg: theme.surface });
    this.trayBar = new TextRenderable(renderer, { height: 1, flexShrink: 0, wrapMode: "none", bg: theme.surface });
    this.trayBar.onMouseDown = (event) => {
      const offset = event.x - this.trayBar.screenX;
      const hit = this.trayRanges.find((range) => offset >= range.start && offset < range.end);
      if (hit?.job !== undefined) this.actions.onOpenJob(hit.job);
      else if (hit) this.actions.onOpenWidget(hit.index);
    };
    this.jobsBar = new TextRenderable(renderer, { height: 1, flexShrink: 0, wrapMode: "none", bg: theme.surface });
    this.jobsBar.onMouseDown = (event) => {
      const offset = event.x - this.jobsBar.screenX;
      const hit = this.jobRanges.find((range) => offset >= range.start && offset < range.end);
      if (hit) this.actions.onOpenJob(hit.id);
    };
    this.keysChip = new TextRenderable(renderer, { height: 1, flexShrink: 0, wrapMode: "none", bg: theme.surface });
    this.keysChip.onMouseDown = () => this.actions.onOpenKeys();
    statusRow.add(this.modeBar);
    statusRow.add(this.keysChip);
    statusRow.add(this.jobsBar);
    statusRow.add(this.trayBar);
    this.hintBar = new TextRenderable(renderer, { position: "absolute", left: 1, right: 1, height: 1, zIndex: 155, visible: false, wrapMode: "none", fg: theme.muted, bg: theme.raised });
    this.dock = new TextRenderable(renderer, { flexShrink: 0, wrapMode: "none", visible: false });
    this.dock.onMouseDown = (event) => {
      const id = this.dockJobs[event.y - this.dock.screenY];
      if (id !== undefined) this.actions.onOpenJob(id);
    };
    root.add(this.body);
    root.add(this.dock);
    root.add(statusRow);
    this.overlay = new BoxRenderable(renderer, {
      position: "absolute",
      left: "10%",
      top: "10%",
      width: "80%",
      height: "80%",
      zIndex: 100,
      visible: false,
    });
    this.drawerBox = new BoxRenderable(renderer, { position: "absolute", left: 1, right: 1, zIndex: 90, visible: false, overflow: "hidden" });
    this.drawerSlider = new BoxRenderable(renderer, { position: "absolute", left: 0, top: 0, width: "100%" });
    this.drawerBox.add(this.drawerSlider);
    renderer.root.add(root);
    renderer.root.add(this.drawerBox);
    renderer.root.add(this.overlay);
    this.toastBox = new BoxRenderable(renderer, { position: "absolute", right: 1, bottom: 1, zIndex: 150, visible: false, flexDirection: "column", alignItems: "flex-end" });
    renderer.root.add(this.toastBox);
    renderer.root.add(this.hintBar);
    this.launcher = new Launcher(renderer, (entry) => this.entryLook(entry));
    this.jobsPanel = new JobsPanel(renderer);
    this.keysCard = new KeysCard(renderer);
    this.paletteCard = new PaletteCard(renderer);
  }

  render(): void {
    const tab = this.workspace.tab;
    this.renderBody(tab.root, tab.zoomed ? tab.layoutFocus : undefined);
    const popup = this.renderOverlay();
    const focused = this.workspace.focused;
    const grouped = new Set(this.paneTabStrips.flatMap((entry) => entry.group.panes));
    for (const id of paneIds(tab.root)) {
      const pane = this.panes.get(id);
      if (!pane) continue;
      const active = id === focused && this.workspace.prompt === undefined && !popup;
      pane.show(grouped.has(id) ? { kind: "bare" } : this.strip(id, pane, active), active);
    }
    this.renderPaneTabStrips();
    this.modeBar.content = this.renderBar();
    this.trayBar.content = this.renderTray();
    this.keysChip.content = this.renderKeysChip();
    this.jobsBar.content = this.renderJobChips(plainWidth(this.modeBar.content) + plainWidth(this.keysChip.content) + plainWidth(this.trayBar.content));
    this.launcher.render(this.workspace.prompt);
    this.paletteCard.render(this.workspace.palette, this.workspace.focusedApp());
    const showJobs = this.workspace.mode === "jobs" && !this.workspace.prompt && !this.workspace.palette;
    this.jobsPanel.render(showJobs ? this.workspace.tabJobs() : undefined, this.workspace.selectedJob, Date.now());
    this.renderDock();
    const above = 1 + (this.dock.visible ? this.dockJobs.length : 0);
    this.keysCard.render({ mode: this.workspace.mode, leader: this.workspace.leaderCardShown(), app: this.workspace.focusedApp(), bottom: above, lockLeader: this.workspace.lockLeader });
    const notice = this.renderHints();
    this.hintBar.visible = notice.chunks.length > 0;
    this.hintBar.content = notice;
    this.hintBar.bottom = above + this.keysCard.height;
    this.toastBox.bottom = above + this.keysCard.height + (this.hintBar.visible ? 1 : 0);
    this.renderToasts();
    this.renderDrawer(popup);
  }

  private renderKeysChip(): StyledText {
    const open = this.workspace.mode === "leader";
    const paint = (part: Part) => (open ? bg(theme.raised)(part) : part);
    return styled([paint(fg(open ? theme.accent : theme.text)(` ${leaderLabel}`)), paint(fg(theme.muted)(" keys ")), " "]);
  }

  private entryLook(entry: SwitchEntry): EntryLook {
    const detail = this.actions.conversationTitle(entry.dir);
    if (entry.kind === "tab") {
      const tab = this.workspace.tabs.find((candidate) => candidate.id === entry.tabId);
      const state = tab ? this.workspace.tabAttention(tab) : undefined;
      if (!state) return { detail, aside: "open" };
      return { badge: agentBadges[state], color: agentColors[state], detail, aside: `Claude ${agentLabels[state]}` };
    }
    if (entry.kind === "closed" && entry.at !== undefined) return { detail, aside: closedAge(Date.now() - entry.at) };
    return { detail, aside: "project" };
  }

  private renderDrawer(popup: boolean): void {
    const tabId = this.workspace.tab.id;
    if (this.drawerTab !== tabId && this.slide) this.detachDrawer();
    const drawer = this.workspace.drawerOf();
    const pane = drawer && this.panes.get(drawer.id);
    const shown = pane ? drawer.id : undefined;
    if (shown !== this.drawerShown) {
      const sameTab = this.drawerTab === tabId;
      if (pane) {
        this.attachDrawer(pane.frame);
        this.startSlide(sameTab ? "in" : undefined);
      } else if (sameTab && this.drawerFrame && !this.drawerFrame.isDestroyed) this.startSlide("out");
      else this.detachDrawer();
      this.drawerShown = shown;
    }
    this.drawerTab = tabId;
    if (!pane) return;
    const below = (this.dock.visible ? this.dockJobs.length : 0) + 1;
    const room = Math.max(this.renderer.height - below, 3);
    const height = drawer.zoomed ? room : Math.max(Math.round((room * drawer.height) / 100), 3);
    this.drawerBox.height = height;
    this.drawerSlider.height = height;
    this.drawerBox.top = room - height;
    this.drawerBox.visible = true;
    this.placeSlider();
    const active = this.workspace.prompt === undefined && !popup;
    pane.show(this.strip(drawer.id, pane, active, drawer.zoomed ? "drawer · zoomed" : "drawer"), active);
  }

  private attachDrawer(frame: BoxRenderable): void {
    if (this.drawerFrame === frame) return;
    this.detachDrawer();
    this.drawerSlider.add(frame);
    this.drawerFrame = frame;
  }

  private detachDrawer(): void {
    this.stopSlide();
    if (this.drawerFrame?.parent === this.drawerSlider) this.drawerSlider.remove(this.drawerFrame);
    this.drawerFrame = undefined;
    this.drawerBox.visible = false;
  }

  private startSlide(direction: "in" | "out" | undefined): void {
    this.stopSlide();
    if (!direction) {
      this.placeSlider();
      return;
    }
    this.renderer.requestLive();
    const tick = () => {
      if (!this.slide) return;
      if (this.placeSlider()) {
        this.slide.timer = setTimeout(tick, slideFrameMs);
        return;
      }
      const finished = this.slide.direction;
      this.stopSlide();
      if (finished === "out") this.detachDrawer();
    };
    this.slide = { direction, started: Date.now(), timer: setTimeout(tick, slideFrameMs) };
    this.placeSlider();
  }

  private stopSlide(): void {
    if (!this.slide) return;
    clearTimeout(this.slide.timer);
    this.slide = undefined;
    this.renderer.dropLive();
  }

  private placeSlider(): boolean {
    const height = typeof this.drawerSlider.height === "number" ? this.drawerSlider.height : 0;
    if (!this.slide) {
      this.drawerSlider.top = 0;
      return false;
    }
    const progress = Math.min((Date.now() - this.slide.started) / slideMs, 1);
    const eased = 1 - (1 - progress) ** 3;
    const hidden = this.slide.direction === "in" ? 1 - eased : eased;
    this.drawerSlider.top = Math.round(height * hidden);
    this.renderer.requestRender();
    return progress < 1;
  }

  private renderDock(): void {
    const jobs = this.workspace.tabJobs().filter((job) => job.dock);
    this.dock.visible = jobs.length > 0;
    this.dockJobs = jobs.map((job) => job.id);
    if (jobs.length === 0) return;
    this.dock.height = jobs.length;
    const nameWidth = Math.min(Math.max(...jobs.map((job) => Bun.stringWidth(job.name))), 24);
    const room = Math.max(this.renderer.width - nameWidth - 10, 10);
    const rows = jobs.map((job) => {
      const name = fit(job.name, nameWidth, true);
      const state = this.workspace.agents.get(job.id);
      if (job.agent) {
        const reply = this.workspace.latestReply(job.id);
        const mode = this.workspace.modes.get(job.id);
        const modeLabel = mode ? `${mode} · ` : "";
        const wakingUp = this.workspace.wakeups.has(job.id);
        const wakeup = wakingUp && room - Bun.stringWidth(modeLabel) - Bun.stringWidth(wakeupLabel) >= 10 ? wakeupLabel : "";
        const textRoom = Math.max(room - Bun.stringWidth(modeLabel) - Bun.stringWidth(wakeup), 1);
        const activity = this.workspace.dormant.has(job.id) ? "not started  ·  Alt c to talk" : state === "working" || wakingUp ? this.workspace.activities.get(job.id) : undefined;
        const look = this.agentLook(job.id, state);
        const text = activity ? fit(activity, textRoom) : reply ? firstLine(reply.text, textRoom) : fit(look.label, textRoom);
        return [fg(look.color)(` ${look.badge} `), bold(fg(look.color)(name)), fg(theme.muted)(`  ${modeLabel}`), fg(activity ? theme.muted : theme.text)(text), fg(theme.muted)(wakeup)];
      }
      const line = this.workspace.jobTexts.get(job.id) ?? (this.actions.jobLine(job.id) || (job.state === "running" ? "no output yet" : jobDetail(job, Date.now())));
      const shown = fit(line, room);
      const color = job.state === "running" ? theme.text : commandColors[job.state];
      return [fg(color)(` ${jobBadge(job)} `), bold(fg(color)(name)), fg(theme.muted)("  "), fg(theme.muted)(shown)];
    });
    const width = this.renderer.width - 2;
    this.dock.content = styled(
      rows.flatMap((row, index) => {
        const used = plainWidth(styled(row));
        const tag = index === 0 && width - used >= dockTag.length + 2 ? [" ".repeat(width - used - dockTag.length), fg(theme.faint)(dockTag)] : [];
        return [...(index > 0 ? ["\n"] : []), ...row, ...tag];
      }),
    );
  }

  private renderToasts(): void {
    const toasts = this.workspace.toasts();
    this.toastBox.visible = toasts.length > 0;
    for (const unused of this.toastCards.splice(toasts.length)) unused.box.destroyRecursively();
    if (toasts.length === 0) return;
    const maxWidth = Math.floor(this.renderer.width * 0.6);
    toasts.forEach((toast, index) => {
      const look = this.toastLook(toast);
      const target = toast.kind === "job" ? toast.job.id : toast.id;
      const width = Math.min(Math.max(Bun.stringWidth(look.title) + Bun.stringWidth(look.aside) + 2, Bun.stringWidth(look.detail), Bun.stringWidth(look.keys)) + 3, maxWidth);
      const room = width - 3;
      const gap = Math.max(room - Bun.stringWidth(look.title) - Bun.stringWidth(look.aside), 1);
      const lines: Part[] = [bold(fg(look.color)(fit(look.title, room))), fg(theme.muted)(`${" ".repeat(gap)}${look.aside}`), "\n", fg(look.dim ? theme.muted : theme.text)(fit(look.detail, room))];
      if (look.keys) lines.push("\n", fg(theme.muted)(fit(look.keys, room)));
      const shown = this.toastCards[index] ?? this.addToastCard();
      shown.target = target;
      shown.box.width = width;
      shown.box.borderColor = look.color;
      shown.text.content = styled(lines);
    });
  }

  private addToastCard(): { box: BoxRenderable; text: TextRenderable; target: PaneId } {
    const box = new BoxRenderable(this.renderer, { ...card(theme.accent), flexShrink: 0, paddingLeft: 1, paddingRight: 1 });
    const text = new TextRenderable(this.renderer, { wrapMode: "none" });
    const shown = { box, text, target: 0 };
    box.onMouseDown = () => {
      if (this.workspace.jobStatus(shown.target)) this.actions.onOpenJob(shown.target);
      else this.actions.onFocusPane(shown.target);
    };
    box.add(text);
    this.toastBox.add(box);
    this.toastCards.push(shown);
    return shown;
  }

  private toastLook(toast: ReturnType<Workspace["toasts"]>[number]): { title: string; aside: string; detail: string; keys: string; color: string; dim?: boolean } {
    if (toast.kind === "note") {
      return { title: `📣 ${this.workspace.jobStatus(toast.id)?.name ?? "script"}`, aside: toast.tab.name, detail: firstLine(toast.note.text, 60), keys: "", color: theme.accent };
    }
    if (toast.kind === "reply") {
      const name = this.workspace.paneNames.get(toast.id) ?? "Claude";
      const keys = toast.brief ? "" : "Alt p peek  Alt x dismiss";
      return { title: `💬 ${name}`, aside: toast.tab.name, detail: firstLine(toast.reply.text, 60), keys, color: theme.accent, dim: toast.brief };
    }
    const { job } = toast;
    const failed = job.state === "failed";
    const verb = failed ? "failed" : job.state === "running" ? "running" : "passed";
    const keys = failed ? "Alt a open  Alt x dismiss" : "";
    return { title: `${jobBadge(job)} ${job.name} ${verb}`, aside: jobDetail(job, Date.now()), detail: `${toast.tab.name} › ${job.name}`, keys, color: failed ? theme.error : theme.ok, dim: true };
  }

  private renderBody(root: LayoutNode, zoomed: PaneId | undefined): void {
    const signature = JSON.stringify([this.workspace.active, this.workspace.tab.id, this.workspace.tab.layoutFocus, zoomed, root]);
    if (signature === this.bodySignature) return;
    this.bodySignature = signature;
    for (const tab of this.workspace.tabs) {
      for (const id of paneIds(tab.root)) {
        const frame = this.panes.get(id)?.frame;
        frame?.parent?.remove(frame);
      }
    }
    for (const child of this.body.getChildren()) child.destroyRecursively();
    this.paneTabStrips = [];
    const zoomedPane = zoomed === undefined ? undefined : this.panes.get(zoomed);
    if (zoomedPane) this.body.add(this.slot(zoomedPane.frame));
    else this.body.add(this.build(root));
  }

  private renderOverlay(): boolean {
    const popup = this.workspace.popup;
    const pane = popup && this.panes.get(popup.id);
    if (this.overlayPane !== popup?.id) {
      const previous = this.overlayPane === undefined ? undefined : this.panes.get(this.overlayPane);
      if (previous) this.overlay.remove(previous.frame);
      if (pane) this.overlay.add(pane.frame);
      this.overlayPane = pane ? popup.id : undefined;
    }
    this.overlay.visible = pane !== undefined;
    if (!pane) return false;
    const { width, height } = popup.size ?? defaultPopupSize;
    this.overlay.width = `${width}%`;
    this.overlay.height = `${height}%`;
    this.overlay.left = `${(100 - width) / 2}%`;
    this.overlay.top = `${(100 - height) / 2}%`;
    const waiting = this.workspace.popupsWaiting(this.workspace.tab) - (popup.kind === "ask" ? 1 : 0);
    const job = popup.kind === "job" ? this.workspace.jobStatus(popup.id) : undefined;
    const title = job ? `${jobBadge(job)} ${job.name}` : popup.title;
    const aside = [job ? jobDetail(job, Date.now()) : this.workspace.tab.name, waiting > 0 ? `+${waiting} waiting` : ""].filter(Boolean).join("  ·  ");
    const color = job?.state === "failed" ? theme.error : theme.accent;
    pane.show({ kind: "card", color, header: pane.frameless ? undefined : this.cardHeader(title, aside, pane) }, this.workspace.prompt === undefined);
    return true;
  }

  private build(node: LayoutNode): BoxRenderable {
    if (node.kind === "pane") {
      const pane = this.panes.get(node.id);
      return pane ? this.slot(pane.frame) : new BoxRenderable(this.renderer, { flexGrow: 1, flexBasis: 0 });
    }
    if (node.kind === "tabs") return this.buildTabs(node);
    const container = new BoxRenderable(this.renderer, { flexDirection: node.axis, flexGrow: 1, flexBasis: 0, minWidth: 0, minHeight: 0, columnGap: node.axis === "row" ? 1 : 0 });
    for (const child of node.children) container.add(this.build(child));
    return container;
  }

  private buildTabs(group: TabsNode): BoxRenderable {
    const container = new BoxRenderable(this.renderer, { flexDirection: "column", flexGrow: 1, flexBasis: 0, minWidth: 0, minHeight: 0 });
    const row = new BoxRenderable(this.renderer, { height: 1, flexShrink: 0, backgroundColor: theme.surface });
    const strip = new TextRenderable(this.renderer, { flexGrow: 1, wrapMode: "none" });
    row.add(strip);
    const entry = { row, strip, group, ranges: [] as { start: number; end: number; id: PaneId }[] };
    strip.onMouseDown = (event) => {
      const offset = event.x - strip.screenX;
      const hit = entry.ranges.find((range) => offset >= range.start && offset < range.end);
      if (hit) this.actions.onFocusPane(hit.id);
    };
    this.paneTabStrips.push(entry);
    container.add(row);
    const shown = this.panes.get(group.panes[shownPaneTab(group, this.workspace.tab.layoutFocus)]!);
    if (shown) container.add(this.slot(shown.frame));
    return container;
  }

  private renderPaneTabStrips(): void {
    const focused = this.workspace.tab.layoutFocus;
    for (const entry of this.paneTabStrips) {
      const selected = shownPaneTab(entry.group, focused);
      const groupFocused = entry.group.panes.includes(this.workspace.focused) && !this.workspace.prompt && !this.workspace.popup;
      const shownId = entry.group.panes[selected];
      const shownPane = shownId === undefined ? undefined : this.panes.get(shownId);
      const parts: Part[] = [groupFocused && shownPane && shownId !== undefined ? fg(appColor(this.paneName(shownId, shownPane)))("▎") : " "];
      let column = 1;
      entry.ranges = [];
      entry.group.panes.forEach((id, index) => {
        const pane = this.panes.get(id);
        if (!pane) return;
        const state = this.workspace.agents.get(id);
        const command = this.workspace.commands.get(id);
        const badges = `${state ? ` ${agentBadges[state]}` : ""}${command ? ` ${commandBadges[command]}` : ""}`;
        const name = this.paneName(id, pane);
        const label = `◆ ${name}${badges}`;
        if (index === selected) parts.push(bold(fg(appColor(name))(label)));
        else parts.push(fg(state ? agentColors[state] : command ? commandColors[command] : theme.muted)(label));
        entry.ranges.push({ start: column, end: column + Bun.stringWidth(label), id });
        column += Bun.stringWidth(label);
        parts.push("   ");
        column += 3;
      });
      if (shownPane && column + 4 < entry.strip.width) parts.push(fg(theme.muted)(fit(shownPane.title, entry.strip.width - column - 1)));
      entry.strip.content = styled(parts);
      entry.row.backgroundColor = groupFocused ? theme.surface2 : theme.surface;
    }
  }

  private slot(frame: BoxRenderable): BoxRenderable {
    const slot = new BoxRenderable(this.renderer, { flexGrow: 1, flexBasis: 0, minWidth: 0, minHeight: 0 });
    slot.add(frame);
    return slot;
  }

  private paneName(id: PaneId, pane: Pane): string {
    return this.workspace.paneNames.get(id) ?? this.workspace.jobStatus(id)?.name ?? pane.name;
  }

  private strip(id: PaneId, pane: Pane, focused: boolean, place?: string): PaneChrome {
    const name = this.paneName(id, pane);
    const color = appColor(name);
    const zoomed = this.workspace.tab.zoomed && id === this.workspace.tab.layoutFocus ? "zoomed" : undefined;
    const state = this.workspace.agents.get(id);
    const command = this.workspace.commands.get(id);
    const right = [
      ...(state ? [fg(agentColors[state])(`${agentBadges[state]} ${agentLabels[state]}`)] : []),
      ...(command ? [fg(commandColors[command])(`${commandBadges[command]} ${commandLabels[command]}`)] : []),
      ...[place, zoomed].filter((text) => text !== undefined).map((text) => fg(theme.muted)(text)),
    ].flatMap((part, index) => (index > 0 ? ["  ", part] : [part]));
    const exited = pane.exited ? `exited${pane.code === null || pane.code === undefined ? "" : ` ${pane.code}`}` : undefined;
    const left: Part[] = [focused ? fg(color)("▎") : " ", bold(fg(color)(`◆ ${name}`))];
    const width = typeof pane.frame.width === "number" && pane.frame.width > 0 ? pane.frame.width : this.renderer.width;
    const rightWidth = plainWidth(styled(right));
    const titleRoom = width - plainWidth(styled(left)) - 2 - (rightWidth > 0 ? rightWidth + 3 : 1) - (exited ? exited.length + 3 : 0);
    if (titleRoom >= 4) left.push(fg(theme.muted)(`  ${fit(pane.title, titleRoom)}`));
    if (exited) left.push(fg(theme.faint)("  ·  "), fg(theme.warning)(exited));
    const used = plainWidth(styled(left));
    const header = rightWidth > 0 && width - used - rightWidth >= 2 ? [...left, " ".repeat(width - used - rightWidth - 1), ...right] : left;
    return { kind: "strip", header: styled(header), background: focused ? theme.surface2 : theme.surface };
  }

  private cardHeader(title: string, aside: string, pane: Pane): StyledText {
    const width = (typeof pane.frame.width === "number" && pane.frame.width > 0 ? pane.frame.width : this.renderer.width) - 3;
    const room = Math.max(width - Bun.stringWidth(aside) - 2, 4);
    const shown = fit(title, room);
    const gap = Math.max(width - Bun.stringWidth(shown) - Bun.stringWidth(aside), 1);
    return styled([bold(fg(theme.text)(shown)), fg(theme.muted)(`${" ".repeat(gap)}${aside}`)]);
  }

  private renderBar(): StyledText {
    const mode = this.workspace.mode;
    const parts: Part[] = [bold(bg(theme.modes[mode])(fg(theme.background)(` ${mode.toUpperCase()} `))), " "];
    this.workspace.tabs.forEach((tab, index) => {
      const active = index === this.workspace.active;
      const paint = (part: Part) => (active ? bg(theme.raised)(part) : part);
      const asking = this.workspace.popupsWaiting(tab) > 0 ? " ?" : "";
      const attention = this.workspace.tabAttention(tab);
      const command = this.workspace.tabCommandState(tab);
      parts.push(paint(active ? bold(fg(theme.accent)(` ${index + 1}`)) : fg(theme.muted)(` ${index + 1}`)), paint(fg(active ? theme.text : theme.muted)(` ${tab.name}${asking}`)));
      if (attention) parts.push(paint(fg(agentColors[attention])(` ${agentBadges[attention]}`)));
      if (this.workspace.tabUnread(tab)) parts.push(paint(fg(theme.accent)(" 💬")));
      if (command) parts.push(paint(fg(commandColors[command])(` ${commandBadges[command]}`)));
      parts.push(paint(" "), " ");
    });
    if (this.workspace.clients > 1) parts.push(fg(theme.warning)(` ${this.workspace.clients} terminals attached `));
    return styled(parts);
  }

  private agentLook(id: PaneId, state: AgentState | undefined): { badge: string; label: string; color: string } {
    if (state) return { badge: agentBadges[state], label: agentLabels[state], color: agentColors[state] };
    const awaited = this.workspace.awaitedJobs(id);
    if (awaited > 0) return { badge: awaitingBadge, label: awaitingLabel(awaited), color: theme.text };
    return { badge: idleBadge, label: "ready", color: theme.muted };
  }

  private renderJobChips(used: number): StyledText {
    this.jobRanges = [];
    const jobs = this.workspace.tabJobs().filter((job) => !job.dock);
    const room = this.renderer.width - used - 2;
    if (jobs.length === 0 || room < 4) return styled([]);
    const chips = jobs.map((job) => {
      const state = job.agent ? this.workspace.agents.get(job.id) : undefined;
      const badge = job.agent ? this.agentLook(job.id, state).badge : jobBadge(job);
      const color = state ? agentColors[state] : job.state === "running" ? theme.text : commandColors[job.state];
      return { id: job.id, badge, name: job.name, color };
    });
    for (const nameWidth of [Number.POSITIVE_INFINITY, 16, 10, 6]) {
      const labels = chips.map((chip) => ` ${chip.badge} ${nameWidth === Number.POSITIVE_INFINITY ? chip.name : fit(chip.name, nameWidth)} `);
      if (labels.reduce((total, label) => total + Bun.stringWidth(label), 0) > room) continue;
      let column = 0;
      return styled(
        labels.map((label, index) => {
          this.jobRanges.push({ start: column, end: column + Bun.stringWidth(label), id: chips[index]!.id });
          column += Bun.stringWidth(label);
          return fg(chips[index]!.color)(label);
        }),
      );
    }
    const counts = new Map<string, { count: number; color: string }>();
    for (const chip of chips) counts.set(chip.badge, { count: (counts.get(chip.badge)?.count ?? 0) + 1, color: chip.color });
    const summary = [...counts].map(([badge, { count, color }]) => fg(color)(` ${badge}${count}`));
    return summary.length * 4 <= room ? styled([...summary, " "]) : styled([]);
  }

  private renderTray(): StyledText {
    const selecting = this.workspace.mode === "tray";
    const parts: Part[] = [];
    let column = 0;
    this.trayRanges = [];
    for (const job of this.workspace.tabJobs()) {
      const text = this.workspace.trayTexts.get(job.id);
      if (text === undefined || text === "") continue;
      if (parts.length > 0) {
        parts.push(fg(theme.faint)("·"));
        column += 1;
      }
      const label = ` ${fit(text, 30)} `;
      parts.push(fg(theme.accent)(label));
      this.trayRanges.push({ start: column, end: column + Bun.stringWidth(label), index: -1, job: job.id });
      column += Bun.stringWidth(label);
    }
    this.tray.texts.forEach((text, index) => {
      if (text === "") return;
      if (parts.length > 0) {
        parts.push(fg(theme.faint)("·"));
        column += 1;
      }
      const label = ` ${text} `;
      const selected = selecting && index === this.workspace.selectedWidget;
      parts.push(selected ? bold(bg(theme.modes.tray)(fg(theme.background)(label))) : fg(theme.text)(label));
      this.trayRanges.push({ start: column, end: column + label.length, index });
      column += label.length;
    });
    return styled(parts);
  }

  private renderHints(): StyledText {
    const { prompt, message, mode } = this.workspace;
    if (prompt || this.workspace.palette) return styled([]);
    if (message) return styled([" ", fg(theme.warning)(message)]);
    if (this.workspace.picking) return styled([" ", fg(theme.accent)(this.workspace.picking), "  ", ...hintParts([{ keys: "Alt C", description: "cancel" }]).slice(1)]);
    const hidden = this.workspace.hiddenAsks().length;
    if (hidden > 0 && !this.workspace.popup) {
      return styled([" ", fg(theme.warning)(hidden === 1 ? "A question is waiting" : `${hidden} questions are waiting`), "  ", ...hintParts([{ keys: "Alt j", description: "show it" }]).slice(1)]);
    }
    if (this.workspace.popupWaitMs() !== undefined) {
      return styled([" ", fg(theme.warning)("A question is waiting"), fg(theme.muted)("  it opens when you pause typing  "), ...hintParts([{ keys: "Alt a", description: "open now" }]).slice(1)]);
    }
    if ((mode === "normal" || mode === "locked") && this.workspace.focusedPaneHeld()) {
      return styled([" ", fg(theme.warning)("Command exited"), "  ", ...hintParts(heldHints).slice(1)]);
    }
    return styled([]);
  }
}

const dockTag = "docked";
const slideMs = 90;
const slideFrameMs = 15;
const defaultPopupSize = { width: 80, height: 80 };
const agentBadges: Record<AgentState, string> = { working: "🧠", waiting: "!", done: "🚀", failed: "✗" };
const idleBadge = "💤";
const awaitingBadge = "⌛";
const wakeupLabel = " · handling a job event";
const agentLabels: Record<AgentState, string> = { working: "working", waiting: "needs you", done: "done", failed: "failed" };
const agentColors: Record<AgentState, string> = { working: theme.accent, waiting: theme.warning, done: theme.ok, failed: theme.error };
const commandBadges: Record<CommandState, string> = { running: "⏳", succeeded: "🎉", failed: "💥" };
const commandLabels: Record<CommandState, string> = { running: "running", succeeded: "succeeded", failed: "failed" };
const commandColors: Record<CommandState, string> = { running: theme.accent, succeeded: theme.ok, failed: theme.error };

const heldHints: Hint[] = [
  { keys: "Enter", description: "re-run" },
  { keys: "Esc", description: "shell" },
  { keys: "^c", description: "close" },
];

function hintParts(list: Hint[]): Part[] {
  const parts: Part[] = [" "];
  list.forEach((hint, index) => {
    if (index > 0) parts.push("  ");
    parts.push(fg(theme.text)(hint.keys), fg(theme.muted)(` ${hint.description}`));
  });
  return parts;
}

function closedAge(ms: number): string {
  const label = age(ms);
  return label === "1d ago" ? "yesterday" : label === "just now" ? "closed just now" : `${label}`;
}

function awaitingLabel(jobs: number): string {
  return jobs === 1 ? "waiting on a job" : `waiting on ${jobs} jobs`;
}

function plainWidth(text: StyledText | string): number {
  return Bun.stringWidth(typeof text === "string" ? text : text.chunks.map((chunk) => chunk.text).join(""));
}
