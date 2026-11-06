import { describe, expect, test } from "bun:test";
import { paneIds } from "./layout.ts";
import { configSchema } from "./config.ts";
import type { ReplyChoice } from "./peek.ts";
import type { Project } from "./projects.ts";
import { draftKey, Workspace, openedKey, type InputKey, type PaneHost, type RecentTab } from "./workspace.ts";

class FakeHost implements PaneHost {
  created: [number, string | undefined][] = [];
  commands = new Map<number, string[] | undefined>();
  destroyed: number[] = [];
  knownProjects: Project[] = [
    { name: "penguin", dir: "/work/exfresso/penguin" },
    { name: "penguin-auth", dir: "/work/stories/penguin-auth" },
    { name: "merlin", dir: "/work/exfresso/merlin" },
  ];
  tabOf = new Map<number, number>();
  create(id: number, cwd: string | undefined, command: string[] | undefined, tabId: number): void {
    this.created.push([id, cwd]);
    this.commands.set(id, command);
    this.tabOf.set(id, tabId);
  }
  jobs: [number, string[], number][] = [];
  jobCwds = new Map<number, string | undefined>();
  createJob(id: number, cwd: string | undefined, command: string[], tabId: number): void {
    this.jobs.push([id, command, tabId]);
    this.jobCwds.set(id, cwd);
    this.tabOf.set(id, tabId);
  }
  tracked: number[] = [];
  trackJob(id: number): void {
    this.tracked.push(id);
  }
  untracked: number[] = [];
  untrackJob(id: number): void {
    this.untracked.push(id);
  }
  running = new Map<number, string>();
  runningCommand(id: number): string | undefined {
    return this.running.get(id);
  }
  shellCommand(text: string): string[] {
    return ["sh", "-c", text];
  }
  claudes = new Set<number>();
  composed: number[] = [];
  peeked: [number, string, string][] = [];
  peekKeys: string[] = [];
  peekReply(near: number, title: string, text: string, key: string): void {
    this.peeked.push([near, title, text]);
    this.peekKeys.push(key);
  }
  picked: [number, string, ReplyChoice[]][] = [];
  pickReply(near: number, title: string, choices: ReplyChoice[], key: string): void {
    this.picked.push([near, title, choices]);
    this.peekKeys.push(key);
  }
  composeClaude(near: number, candidates: number[]): string | undefined {
    const target = this.claudes.has(near) ? near : candidates.find((id) => this.claudes.has(id));
    if (target === undefined) return "No native Claude in this tab";
    this.composed.push(target);
    return undefined;
  }
  contextAsked: [number, number[]][] = [];
  contextClaude(near: number, candidates: number[]): string | undefined {
    this.contextAsked.push([near, candidates]);
    return this.claudes.size === 0 ? "No native Claude in this tab" : undefined;
  }
  closedTabs: number[] = [];
  tabClosed(tabId: number): void {
    this.closedTabs.push(tabId);
  }
  layoutJobs(): [string[], number, string | undefined][] {
    return this.jobs.map(([id, command, tabId]) => [command, tabId, this.jobCwds.get(id)]);
  }
  projects(): Project[] {
    return this.knownProjects;
  }
  destroy(id: number): void {
    this.destroyed.push(id);
  }
  held = new Set<number>();
  reruns: number[] = [];
  shells: number[] = [];
  isHeld(id: number): boolean {
    return this.held.has(id);
  }
  rerun(id: number): void {
    this.reruns.push(id);
    this.held.delete(id);
  }
  replaceWithShell(id: number): void {
    this.shells.push(id);
    this.held.delete(id);
  }
  closedPopups: number[] = [];
  closePopup(id: number): void {
    this.closedPopups.push(id);
  }
  cwd(id: number): string | undefined {
    return `/work/${id}`;
  }
  screen(): { cols: number; rows: number } {
    return { cols: 200, rows: 50 };
  }
  widgets = 2;
  openedWidgets: number[] = [];
  widgetCount(): number {
    return this.widgets;
  }
  openWidget(index: number): void {
    this.openedWidgets.push(index);
  }
  askedKeys: number[] = [];
  askKeys(id: number): void {
    this.askedKeys.push(id);
  }
  sent: [number, string][] = [];
  sendKeys(id: number, data: string): void {
    this.sent.push([id, data]);
  }
  recent: RecentTab[] = [];
  recentTabs(): RecentTab[] {
    return this.recent;
  }
  rememberTab(tab: RecentTab): void {
    this.recent = [tab, ...this.recent.filter((kept) => openedKey(kept) !== openedKey(tab))];
  }
}

function key(spec: string): InputKey {
  const parts = spec.split("+");
  const name = parts.pop()!;
  const shift = parts.includes("shift");
  const sequence = name.length === 1 ? (shift ? name.toUpperCase() : name) : "";
  return { name, ctrl: parts.includes("ctrl"), meta: parts.includes("alt"), shift, sequence };
}

function press(workspace: Workspace, ...keys: string[]): boolean[] {
  return keys.map((spec) => workspace.handleKey(key(spec)));
}

function type(workspace: Workspace, text: string): void {
  for (const char of text) workspace.handleKey({ name: char, ctrl: false, meta: false, shift: false, sequence: char });
}

describe("Workspace", () => {
  test("starts with one tab holding one pane", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host, "/home");
    expect(workspace.tabs.map((tab) => tab.name)).toEqual(["Tab #1"]);
    expect(host.created).toEqual([[1, "/home"]]);
  });

  test("the focused pane can zoom itself and give the zoom back, and no other pane can", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+space", "p", "r");
    expect(workspace.zoomPane(1, true)).toBeUndefined();
    expect(workspace.tab).toMatchObject({ layoutFocus: 2, zoomed: false });
    expect(workspace.zoomPane(2, true)).toBe(false);
    expect(workspace.tab).toMatchObject({ layoutFocus: 2, zoomed: true });
    expect(workspace.zoomPane(2, false)).toBe(true);
    expect(workspace.tab.zoomed).toBe(false);
  });

  test("an open, focused drawer zooms the drawer rather than the layout", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "alt+d");
    const drawer = workspace.drawerOf()!.id;
    expect(workspace.zoomPane(drawer, true)).toBe(false);
    expect(workspace.drawerOf()?.zoomed).toBe(true);
    expect(workspace.tab.zoomed).toBe(false);
  });

  test("normal mode passes ordinary keys through to the pane", () => {
    const workspace = new Workspace(new FakeHost());
    expect(press(workspace, "a", "ctrl+c", "alt+x")).toEqual([false, false, false]);
  });

  test("pane mode splits, moves focus, and returns to normal", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    press(workspace, "ctrl+space", "p", "r");
    expect(workspace.mode).toBe("normal");
    expect(paneIds(workspace.tab.root)).toEqual([1, 2]);
    expect(workspace.focused).toBe(2);
    expect(host.created.at(-1)).toEqual([2, "/work/1"]);
    press(workspace, "alt+h");
    expect(workspace.focused).toBe(1);
    press(workspace, "alt+s");
    expect(workspace.focused).toBe(2);
    press(workspace, "alt+o");
    expect(workspace.focused).toBe(1);
  });

  test("pane mode moves the focused pane with the focus keys", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+space", "p", "r", "ctrl+space", "p", "alt+h");
    expect(paneIds(workspace.tab.root)).toEqual([2, 1]);
    expect([workspace.focused, workspace.mode]).toEqual([2, "pane"]);
    press(workspace, "alt+right");
    expect(paneIds(workspace.tab.root)).toEqual([1, 2]);
    press(workspace, "alt+s");
    expect(paneIds(workspace.tab.root)).toEqual([1, 2]);
  });

  test("new pane picks the split direction from the pane's shape", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+space", "p", "n");
    expect(workspace.tab.root).toMatchObject({ kind: "split", axis: "row" });
    press(workspace, "ctrl+space", "p", "n");
    expect(workspace.tab.root).toMatchObject({ children: [{}, { kind: "split", axis: "column" }] });
  });

  test("modes swallow unbound keys", () => {
    const workspace = new Workspace(new FakeHost());
    expect(press(workspace, "ctrl+space", "p", "q")).toEqual([true, true, true]);
    expect(workspace.mode).toBe("pane");
    press(workspace, "escape");
    expect(workspace.mode).toBe("normal");
  });

  test("closing panes collapses the layout and the last pane closes the tab", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    press(workspace, "ctrl+space", "t", "c", "ctrl+space", "p", "x");
    expect(host.destroyed).toEqual([2]);
    expect(workspace.tabs).toHaveLength(1);
    press(workspace, "ctrl+space", "p", "x");
    expect(workspace.quit).toBe(true);
  });

  test("pane exit removes it from its tab", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+space", "p", "d");
    workspace.paneExited(2);
    expect(paneIds(workspace.tab.root)).toEqual([1]);
    expect(workspace.focused).toBe(1);
  });

  test("tab mode creates, cycles, moves, and jumps between tabs", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+space", "t", "c", "ctrl+space", "t", "c");
    expect(workspace.tabs.map((tab) => tab.name)).toEqual(["Tab #1", "Tab #2", "Tab #3"]);
    expect(workspace.active).toBe(2);
    press(workspace, "ctrl+space", "t", "h");
    expect(workspace.active).toBe(1);
    press(workspace, "s", "s");
    expect(workspace.active).toBe(0);
    press(workspace, "n");
    expect(workspace.tabs.map((tab) => tab.name)).toEqual(["Tab #2", "Tab #1", "Tab #3"]);
    press(workspace, "3");
    expect(workspace.active).toBe(2);
    expect(workspace.mode).toBe("normal");
  });

  test("closing a tab requires typing its name", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    press(workspace, "ctrl+space", "t", "c", "ctrl+space", "t", "x");
    expect(workspace.prompt).toMatchObject({ title: "Close tab", detail: 'Type "Tab #2" to close it' });
    type(workspace, "nope");
    press(workspace, "return");
    expect(workspace.tabs).toHaveLength(2);
    expect(workspace.message).toBe("Kept the tab");
    press(workspace, "ctrl+space", "t", "x");
    type(workspace, "Tab #2");
    press(workspace, "return");
    expect(workspace.tabs.map((tab) => tab.name)).toEqual(["Tab #1"]);
    expect(host.destroyed).toEqual([2]);
  });

  test("renaming tabs and panes", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+space", "t", "r");
    for (let i = 0; i < 6; i++) press(workspace, "backspace");
    type(workspace, "api");
    press(workspace, "return");
    expect(workspace.tab.name).toBe("api");
    press(workspace, "ctrl+space", "p", "c");
    type(workspace, "server");
    press(workspace, "return");
    expect(workspace.paneNames.get(1)).toBe("server");
  });

  test("session mode d asks to detach", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+space", "s", "d");
    expect(workspace.detachRequested).toBe(true);
    expect(workspace.mode).toBe("normal");
  });

  test("quitting takes session mode then shift+q", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+q");
    expect(workspace.quit).toBe(false);
    press(workspace, "ctrl+space", "s", "q");
    expect(workspace.quit).toBe(false);
    press(workspace, "shift+q");
    expect(workspace.quit).toBe(true);
  });

  test("locked mode passes everything until the leader and l", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+space", "l");
    expect(workspace.mode).toBe("locked");
    expect(press(workspace, "ctrl+p", "alt+h", "ctrl+t")).toEqual([false, false, false]);
    expect(press(workspace, "ctrl+space", "p")).toEqual([true, false]);
    expect(workspace.mode).toBe("locked");
    expect(press(workspace, "ctrl+space", "l")).toEqual([true, true]);
    expect(workspace.mode).toBe("normal");
  });

  test("the leader gives back the Ctrl keys it replaced", () => {
    const workspace = new Workspace(new FakeHost());
    expect(press(workspace, "ctrl+p", "ctrl+t", "ctrl+s", "ctrl+o", "ctrl+g")).toEqual([false, false, false, false, false]);
    expect(workspace.mode).toBe("normal");
  });

  test("the leader runs one-shot keys and returns to normal, Esc cancels, and a stray key leaves", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+space", "n");
    expect([workspace.mode, paneIds(workspace.tab.root)]).toEqual(["normal", [1, 2]]);
    press(workspace, "ctrl+space", "escape");
    expect(workspace.mode).toBe("normal");
    expect(press(workspace, "ctrl+space", "z")).toEqual([true, true]);
    expect(workspace.mode).toBe("normal");
    expect(workspace.message).toContain("Ctrl Space ?");
  });

  test("the leader twice sends a literal Ctrl Space to the pane", () => {
    const workspace = new Workspace(new FakeHost());
    expect(press(workspace, "ctrl+space", "ctrl+space")).toEqual([true, false]);
    expect(workspace.mode).toBe("normal");
  });

  test("the leader card waits a moment before showing, and asks the focused app for its keys", () => {
    const clock = { now: 0 };
    const host = new FakeHost();
    const workspace = new Workspace(host, undefined, undefined, () => clock.now);
    press(workspace, "ctrl+space");
    expect(host.askedKeys).toEqual([1]);
    expect(workspace.leaderCardShown()).toBe(false);
    expect(workspace.leaderWaitMs()).toBe(300);
    clock.now += 300;
    expect(workspace.leaderCardShown()).toBe(true);
    press(workspace, "escape");
    workspace.openLeader();
    expect(workspace.leaderCardShown()).toBe(true);
  });

  test("an open popup receives every key until it closes", () => {
    const workspace = new Workspace(new FakeHost());
    const first = workspace.reservePaneId();
    const second = workspace.reservePaneId();
    workspace.openPopup(first, "Deploy?");
    workspace.openPopup(second, "Second");
    expect(press(workspace, "p", "escape", "x")).toEqual([false, false, false]);
    expect(workspace.mode).toBe("normal");
    workspace.popupExited(first);
    expect(workspace.popup?.title).toBe("Second");
    workspace.popupExited(second);
    expect(press(workspace, "ctrl+space", "p")).toEqual([true, true]);
    expect(workspace.mode).toBe("pane");
  });

  test("a popup belongs to the asking pane's tab and tab keys still work over it", () => {
    const clock = { now: 0 };
    const workspace = new Workspace(new FakeHost(), undefined, undefined, () => clock.now);
    press(workspace, "ctrl+space", "t", "c");
    const popup = workspace.reservePaneId();
    expect(workspace.openPopup(popup, "Question", 1)).toBe(true);
    expect(workspace.popup).toBeUndefined();
    expect(workspace.popupsWaiting(workspace.tabs[0]!)).toBe(1);
    expect(workspace.tabAttention(workspace.tabs[0]!)).toBe("waiting");
    expect(press(workspace, "a")).toEqual([false]);
    press(workspace, "ctrl+space", "t", "h", "escape");
    clock.now += 2000;
    expect(workspace.popup?.title).toBe("Question");
    expect(press(workspace, "a")).toEqual([false]);
    expect(press(workspace, "ctrl+space", "t", "s")).toEqual([true, true, true]);
    expect(workspace.active).toBe(1);
  });

  test("the project launcher takes the keys while it is open over a popup", () => {
    const clock = { now: 0 };
    const workspace = new Workspace(new FakeHost(), undefined, undefined, () => clock.now);
    const popup = workspace.reservePaneId();
    workspace.openPopup(popup, "Question", 1);
    clock.now += 2000;
    expect(workspace.popup?.title).toBe("Question");
    press(workspace, "ctrl+space", "t", "o");
    expect(press(workspace, "m", "e")).toEqual([true, true]);
    expect(workspace.prompt?.text).toBe("me");
    press(workspace, "escape");
    expect(workspace.prompt).toBeUndefined();
    expect(press(workspace, "a")).toEqual([false]);
    press(workspace, "ctrl+space", "t", "o");
    type(workspace, "merlin");
    press(workspace, "return");
    expect(workspace.tab.name).toBe("merlin");
    expect(workspace.popupsWaiting(workspace.tabs[0]!)).toBe(1);
  });

  test("session mode still works over a popup, so a stuck popup can be closed or detached from", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    const id = workspace.reservePaneId();
    workspace.openPopup(id, "Stuck");
    expect(press(workspace, "ctrl+space", "s", "x")).toEqual([true, true, true]);
    expect(host.closedPopups).toEqual([id]);
    press(workspace, "ctrl+space", "s", "d");
    expect(workspace.detachRequested).toBe(true);
  });

  test("opening a project builds its layout in a new tab named after it", () => {
    const host = new FakeHost();
    const config = configSchema.parse({
      projects: { layout: "ide" },
      layouts: { ide: { row: [{ command: ["dev", "claude"], focus: true }, { column: [{ command: ["remax"] }, {}] }] } },
    });
    const workspace = new Workspace(host, "/home", config);
    press(workspace, "ctrl+space", "t", "o");
    expect(workspace.prompt?.matches?.map((match) => match.name)).toEqual(["penguin", "penguin-auth", "merlin"]);
    type(workspace, "pen");
    press(workspace, "tab");
    expect(workspace.prompt?.text).toBe("penguin");
    press(workspace, "return");
    expect(workspace.tabs.map((tab) => tab.name)).toEqual(["Tab #1", "penguin"]);
    expect(paneIds(workspace.tab.root)).toEqual([2, 3, 4]);
    expect(workspace.focused).toBe(2);
    expect(host.created.slice(1)).toEqual([
      [2, "/work/exfresso/penguin"],
      [3, "/work/exfresso/penguin"],
      [4, "/work/exfresso/penguin"],
    ]);
    expect([host.commands.get(2), host.commands.get(3), host.commands.get(4)]).toEqual([["dev", "claude"], ["remax"], undefined]);
  });

  describe("layout jobs", () => {
    const config = configSchema.parse({
      projects: { layout: "ide", layoutFor: { merlin: "served" } },
      layouts: {
        ide: { row: [{}, {}] },
        served: { jobs: [{ command: ["q-space", "serve"], name: "server", dock: true }, { command: ["make", "watch"] }], row: [{ command: ["q-space", "pane", "stories"] }, {}] },
      },
    });

    test("a project's own layout starts its jobs with the tab, docked as configured", () => {
      const host = new FakeHost();
      const workspace = new Workspace(host, "/home", config);
      workspace.openProject("penguin");
      expect(host.layoutJobs()).toEqual([]);
      workspace.openProject("merlin");
      const merlin = workspace.tab;
      expect(host.layoutJobs()).toEqual([
        [["q-space", "serve"], merlin.id, "/work/exfresso/merlin"],
        [["make", "watch"], merlin.id, "/work/exfresso/merlin"],
      ]);
      expect(workspace.tabJobs().map((job) => [job.name, job.dock])).toEqual([
        ["server", true],
        ["make watch", false],
      ]);
      expect(paneIds(merlin.root).map((id) => host.tabOf.get(id))).toEqual([merlin.id, merlin.id]);
    });

    test("closing the tab closes its jobs", () => {
      const host = new FakeHost();
      const workspace = new Workspace(host, "/home", config);
      workspace.openProject("merlin");
      const id = workspace.tab.id;
      const jobs = workspace.tabJobs().map((job) => job.id);
      press(workspace, "ctrl+space", "t", "x");
      type(workspace, "merlin");
      press(workspace, "return");
      expect(host.closedTabs).toEqual([id]);
      expect(host.destroyed).toEqual(expect.arrayContaining(jobs));
      expect(workspace.jobs).toEqual([]);
    });

    test("the last pane exiting closes the tab's jobs", () => {
      const host = new FakeHost();
      const workspace = new Workspace(host, "/home", config);
      workspace.openProject("merlin");
      const tab = workspace.tab;
      for (const pane of paneIds(tab.root)) workspace.paneExited(pane);
      expect(host.closedTabs).toEqual([tab.id]);
      expect(workspace.tabs).not.toContain(tab);
      expect(workspace.jobs).toEqual([]);
    });

    test("Alt+Enter in the launcher opens a project without its jobs, and Ctrl Space j s starts the missing ones", () => {
      const host = new FakeHost();
      const workspace = new Workspace(host, "/home", config);
      press(workspace, "ctrl+space", "t", "o");
      type(workspace, "merlin");
      press(workspace, "alt+return");
      expect(workspace.tab.name).toBe("merlin");
      expect(workspace.tabJobs()).toEqual([]);
      press(workspace, "ctrl+space", "j", "s");
      expect(workspace.tabJobs().map((job) => [job.name, job.dock, job.layout])).toEqual([
        ["server", true, true],
        ["make watch", false, true],
      ]);
      expect(host.jobCwds.get(workspace.tabJobs()[0]!.id)).toBe("/work/exfresso/merlin");
      press(workspace, "ctrl+space", "j", "s");
      expect(workspace.message).toBe("All of this tab's layout jobs are running");
      const [server, watch] = workspace.tabJobs();
      workspace.closeJob(server!.id);
      workspace.jobFinished(watch!.id, 1);
      press(workspace, "ctrl+space", "j", "s");
      expect(workspace.tabJobs().map((job) => [job.name, job.state])).toEqual([
        ["make watch", "running"],
        ["server", "running"],
      ]);
      expect(host.reruns).toEqual([watch!.id]);
      workspace.openProject("penguin");
      press(workspace, "ctrl+space", "j", "s");
      expect(workspace.message).toBe("This tab's layout has no jobs");
    });

    test("Ctrl Space j d docks and undocks the selected job", () => {
      const workspace = new Workspace(new FakeHost(), "/home", config);
      workspace.openProject("merlin");
      press(workspace, "ctrl+space", "j", "down", "d");
      expect(workspace.tabJobs().map((job) => job.dock)).toEqual([true, true]);
      press(workspace, "up", "d");
      expect(workspace.tabJobs().map((job) => job.dock)).toEqual([false, true]);
    });
  });

  describe("named tabs", () => {
    const config = configSchema.parse({
      layouts: {
        "q-space": { jobs: [{ command: ["q-space", "serve"] }], row: [{ command: ["q-space", "pane", "stories"] }, {}] },
        logs: { row: [{}] },
      },
      tabs: { "q-space": { layout: "q-space", cwd: "/home/me/q-space" }, logs: { layout: "logs", cwd: "/var/log" }, penguin: { layout: "logs", cwd: "/elsewhere" } },
      startup: ["logs", "q-space"],
    });

    test("startup tabs replace the plain first tab, in order, with the first focused", () => {
      const host = new FakeHost();
      const workspace = new Workspace(host, "/home", config);
      expect(workspace.tabs.map((tab) => tab.name)).toEqual(["logs", "q-space"]);
      expect(workspace.active).toBe(0);
      expect(host.created).toEqual([
        [1, "/var/log"],
        [2, "/home/me/q-space"],
        [3, "/home/me/q-space"],
      ]);
      expect(host.layoutJobs()).toEqual([[["q-space", "serve"], workspace.tabs[1]!.id, "/home/me/q-space"]]);
    });

    test("named tabs lead the launcher and hide a project of the same name", () => {
      const workspace = new Workspace(new FakeHost(), "/home", config);
      press(workspace, "ctrl+space", "t", "o");
      expect(workspace.prompt?.candidates?.map((candidate) => `${candidate.name} ${candidate.dir}`)).toEqual([
        "q-space /home/me/q-space",
        "penguin /elsewhere",
        "penguin-auth /work/stories/penguin-auth",
        "merlin /work/exfresso/merlin",
      ]);
    });

    test("a closed named tab reopens with its layout and jobs", () => {
      const host = new FakeHost();
      const workspace = new Workspace(host, "/home", config);
      workspace.active = 1;
      press(workspace, "ctrl+space", "t", "x");
      type(workspace, "q-space");
      press(workspace, "return");
      expect(workspace.tabs.map((tab) => tab.name)).toEqual(["logs"]);
      expect(workspace.openProject("q-space")).toBeUndefined();
      expect(workspace.tabs.map((tab) => tab.name)).toEqual(["logs", "q-space"]);
      expect(host.layoutJobs().map(([command, , cwd]) => [command, cwd])).toEqual([
        [["q-space", "serve"], "/home/me/q-space"],
        [["q-space", "serve"], "/home/me/q-space"],
      ]);
    });
  });

  test("opening a pane near another places it beside that pane in its tab", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    press(workspace, "ctrl+space", "t", "c");
    expect(workspace.openPaneNear(1, "right", ["q-space", "pane", "comments"], { name: "comments" })).toBe(3);
    expect([workspace.active, workspace.focused]).toEqual([0, 3]);
    expect(workspace.tab.root).toMatchObject({ kind: "split", axis: "row", children: [{ id: 1 }, { id: 3 }] });
    expect(host.tabOf.get(3)).toBe(workspace.tabs[0]!.id);
    expect(host.commands.get(3)).toEqual(["q-space", "pane", "comments"]);
    expect(workspace.paneNames.get(3)).toBe("comments");
    expect(workspace.openPaneNear(3, "tab", ["htop"], { focus: false })).toBe(4);
    expect(workspace.focused).toBe(3);
    expect(workspace.tab.root).toMatchObject({ children: [{ id: 1 }, { kind: "tabs", panes: [3, 4] }] });
    expect(workspace.openPaneNear(1, "below", ["top"])).toBe(5);
    expect(workspace.tab.root).toMatchObject({ children: [{ kind: "split", axis: "column", children: [{ id: 1 }, { id: 5 }] }, {}] });
    expect(workspace.openPaneNear(99, "right", ["top"])).toBeUndefined();
  });

  test("pane groups: focus moves leave a group's shown pane alone, cycling reaches every member, new panes join the group", () => {
    const config = configSchema.parse({
      projects: { layout: "ide" },
      layouts: { ide: { row: [{ focus: true }, { tabs: [{ command: ["remax"] }, {}] }] } },
    });
    const workspace = new Workspace(new FakeHost(), "/home", config);
    workspace.openProject("merlin");
    expect(workspace.tab.root).toMatchObject({ children: [{ id: 2 }, { kind: "tabs", panes: [3, 4], selected: 0 }] });
    press(workspace, "alt+s", "alt+s");
    expect(workspace.focused).toBe(3);
    press(workspace, "alt+e");
    expect(workspace.focused).toBe(4);
    expect(workspace.tab.root).toMatchObject({ children: [{}, { selected: 1 }] });
    press(workspace, "alt+h");
    expect(workspace.focused).toBe(2);
    expect(workspace.tab.root).toMatchObject({ children: [{}, { selected: 1 }] });
    press(workspace, "alt+s");
    expect(workspace.focused).toBe(4);
    press(workspace, "ctrl+space", "p", "n");
    expect(workspace.tab.root).toMatchObject({ children: [{}, { panes: [3, 4, 5], selected: 2 }] });
    press(workspace, "alt+h", "ctrl+space", "p", "n");
    expect(workspace.tab.root).toMatchObject({ children: [{}, { panes: [3, 4, 5, 6], selected: 3 }] });
    press(workspace, "alt+h", "ctrl+space", "p", "s");
    expect(workspace.tab.root).toMatchObject({ children: [{ kind: "tabs", panes: [2, 7], selected: 1 }, {}] });
  });

  test("the project launcher selects matches with the arrow keys", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+space", "t", "o");
    type(workspace, "pen");
    expect(workspace.prompt?.matches?.map((match) => match.name)).toEqual(["penguin", "penguin-auth"]);
    press(workspace, "down");
    expect(workspace.prompt?.selected).toBe(1);
    press(workspace, "down");
    expect(workspace.prompt?.selected).toBe(0);
    press(workspace, "up", "return");
    expect(workspace.tab.name).toBe("penguin-auth");
  });

  test("the project launcher opens every marked project and focuses the first", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+space", "t", "o");
    type(workspace, "pen ");
    press(workspace, "backspace", "backspace", "backspace");
    type(workspace, "mer ");
    expect(workspace.prompt?.text).toBe("mer");
    expect(workspace.prompt?.marked?.map((project) => project.name)).toEqual(["penguin", "merlin"]);
    press(workspace, "return");
    expect(workspace.tabs.map((tab) => tab.name)).toEqual(["Tab #1", "penguin", "merlin"]);
    expect(workspace.tab.name).toBe("penguin");
  });

  test("the project launcher unmarks a project marked twice", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+space", "t", "o");
    type(workspace, "pen  ");
    expect(workspace.prompt?.marked).toEqual([]);
    press(workspace, "down", "return");
    expect(workspace.tabs.map((tab) => tab.name)).toEqual(["Tab #1", "penguin-auth"]);
  });

  test("the switcher marks projects but not open tabs", () => {
    const workspace = new Workspace(new FakeHost());
    workspace.openProject("merlin");
    press(workspace, "ctrl+space", "t", "h", "ctrl+space", "t", "o");
    type(workspace, "merlin ");
    expect(workspace.prompt?.marked).toEqual([]);
    press(workspace, "backspace", "backspace", "backspace", "backspace", "backspace", "backspace");
    type(workspace, "pen ");
    press(workspace, "return");
    expect(workspace.tabs.map((tab) => tab.name)).toEqual(["Tab #1", "penguin", "merlin"]);
    expect(workspace.tab.name).toBe("penguin");
  });

  test("opening a project that already has a tab switches to it", () => {
    const workspace = new Workspace(new FakeHost());
    expect(workspace.openProject("merlin")).toBeUndefined();
    press(workspace, "ctrl+space", "t", "h");
    expect(workspace.openProject("merl")).toBeUndefined();
    expect(workspace.tabs.map((tab) => tab.name)).toEqual(["Tab #1", "merlin"]);
    expect(workspace.active).toBe(1);
    expect(workspace.openProject("nothing-like-it")).toBe('No project matches "nothing-like-it"');
  });

  describe("layout args", () => {
    const config = configSchema.parse({
      layouts: {
        "pr-review": {
          args: ["pr"],
          name: "{project} #{pr}",
          jobs: [{ command: ["gh", "pr", "checks", "{pr}", "--watch"], name: "checks {pr}" }],
          drawer: { command: ["gh", "pr", "view", "{pr}"] },
          row: [{ command: ["remax", "--pr", "{pr}"], focus: true }, { command: ["awk", "{print}"] }],
        },
      },
    });

    test("--repo and --layout open the repo's clone with the args filled in", () => {
      const host = new FakeHost();
      const workspace = new Workspace(host, "/home", config);
      expect(workspace.openProject({ repo: "Exfresso/Merlin" }, true, { layout: "pr-review", args: { pr: "42" } })).toBeUndefined();
      const tab = workspace.tab;
      expect(tab.name).toBe("merlin #42");
      expect(host.created.slice(1)).toEqual([
        [2, "/work/exfresso/merlin"],
        [3, "/work/exfresso/merlin"],
      ]);
      expect(paneIds(tab.root).map((id) => host.commands.get(id))).toEqual([["remax", "--pr", "42"], ["awk", "{print}"]]);
      expect(host.layoutJobs()).toEqual([[["gh", "pr", "checks", "42", "--watch"], tab.id, "/work/exfresso/merlin"]]);
      expect(workspace.tabJobs().map((job) => job.name)).toEqual(["checks 42"]);
      expect(tab.drawerSpec).toEqual({ command: ["gh", "pr", "view", "42"] });
    });

    test("the same args switch to the open tab, and other args open another", () => {
      const workspace = new Workspace(new FakeHost(), "/home", config);
      workspace.openProject("merlin", true, { layout: "pr-review", args: { pr: "42" } });
      workspace.openProject("merlin", true, { layout: "pr-review", args: { pr: "7" } });
      workspace.openProject({ repo: "exfresso/merlin" }, true, { layout: "pr-review", args: { pr: "42" } });
      expect(workspace.tabs.map((tab) => tab.name)).toEqual(["Tab #1", "merlin #42", "merlin #7"]);
      expect(workspace.tab.name).toBe("merlin #42");
    });

    test("missing, extra, and unknown layouts and repos are reported", () => {
      const workspace = new Workspace(new FakeHost(), "/home", config);
      expect(workspace.openProject("merlin", true, { layout: "pr-review" })).toBe("pr-review needs --arg pr=VALUE");
      expect(workspace.openProject("merlin", true, { layout: "pr-review", args: { pr: "1", base: "main" } })).toBe("pr-review takes no base arg");
      expect(workspace.openProject("merlin", true, { args: { pr: "1" } })).toBe("merlin has no layout to take --arg pr");
      expect(workspace.openProject("merlin", true, { layout: "nope" })).toBe("No layout named nope");
      expect(workspace.openProject({ repo: "flipstone/merlin" })).toBe("No clone of flipstone/merlin under the project roots");
      expect(workspace.tabs.map((tab) => tab.name)).toEqual(["Tab #1"]);
    });
  });

  test("a held pane re-runs on Enter, becomes a shell on Esc, and closes on Ctrl+c", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    press(workspace, "ctrl+space", "p", "r");
    host.held.add(2);
    expect(press(workspace, "x", "return")).toEqual([true, true]);
    expect(host.reruns).toEqual([2]);
    host.held.add(2);
    press(workspace, "escape");
    expect(host.shells).toEqual([2]);
    host.held.add(2);
    press(workspace, "ctrl+space", "p", "escape");
    expect(workspace.mode).toBe("normal");
    press(workspace, "ctrl+c");
    expect(paneIds(workspace.tab.root)).toEqual([1]);
    expect(press(workspace, "x")).toEqual([false]);
  });

  test("held pane keys also work in locked mode, and its hints hide behind a popup", () => {
    const host = new FakeHost();
    const clock = { now: 0 };
    const workspace = new Workspace(host, undefined, undefined, () => clock.now);
    host.held.add(1);
    press(workspace, "ctrl+space", "l", "return");
    expect(host.reruns).toEqual([1]);
    host.held.add(1);
    expect(workspace.focusedPaneHeld()).toBe(true);
    workspace.openPopup(workspace.reservePaneId(), "Question");
    clock.now += 2000;
    expect(workspace.focusedPaneHeld()).toBe(false);
  });

  test("a popup waits until the user stops typing before it takes the keys", () => {
    const clock = { now: 0 };
    const workspace = new Workspace(new FakeHost(), undefined, undefined, () => clock.now);
    press(workspace, "h");
    workspace.openPopup(workspace.reservePaneId(), "Question", 1);
    clock.now += 500;
    expect(workspace.popup).toBeUndefined();
    expect(workspace.popupWaitMs()).toBe(1000);
    expect(press(workspace, "i")).toEqual([false]);
    clock.now += 1000;
    expect(workspace.popup).toBeUndefined();
    clock.now += 600;
    expect(workspace.popup?.title).toBe("Question");
    press(workspace, "y");
    expect(workspace.popup?.title).toBe("Question");
  });

  test("a view popup shows at once over its tab, ahead of waiting questions, without asking for attention", () => {
    const clock = { now: 0 };
    const host = new FakeHost();
    const workspace = new Workspace(host, undefined, undefined, () => clock.now);
    press(workspace, "h");
    workspace.openPopup(workspace.reservePaneId(), "Question", 1);
    const view = workspace.reservePaneId();
    expect(workspace.openViewPopup(view, "Comments", 1, { width: 90, height: 90 })).toBe(workspace.tab.id);
    expect(workspace.popup).toMatchObject({ id: view, kind: "view", size: { width: 90, height: 90 } });
    expect(workspace.popupsWaiting(workspace.tab)).toBe(1);
    expect(press(workspace, "j")).toEqual([false]);
    workspace.popupExited(view);
    expect(workspace.popup).toBeUndefined();
    expect(workspace.openViewPopup(workspace.reservePaneId(), "Nowhere", 99)).toBeUndefined();
  });

  test("raising a view popup by its key brings it to the front of its tab", () => {
    const workspace = new Workspace(new FakeHost());
    const compose = workspace.reservePaneId();
    workspace.openViewPopup(compose, "Message Claude", 1, undefined, "compose:1");
    const peek = workspace.reservePaneId();
    workspace.openViewPopup(peek, "Peek", 1);
    workspace.popups.unshift(workspace.popups.splice(1, 1)[0]!);
    expect(workspace.popup?.id).toBe(peek);
    expect(workspace.raiseViewPopup("compose:1")).toBe(true);
    expect(workspace.popup?.id).toBe(compose);
    expect(workspace.popups.filter((popup) => popup.key === "compose:1")).toHaveLength(1);
    expect(workspace.raiseViewPopup("compose:2")).toBe(false);
  });

  test("a hidden message box keeps running as a draft until raised, and closes with its Claude", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    press(workspace, "ctrl+space", "p", "s");
    const claude = workspace.focused;
    const compose = workspace.reservePaneId();
    workspace.openViewPopup(compose, "Message Claude", claude, undefined, draftKey(claude));
    expect(workspace.hideViewPopup(compose)).toBe(true);
    expect(workspace.popup).toBeUndefined();
    expect(workspace.hasDraft(claude)).toBe(true);
    expect(host.destroyed).toEqual([]);
    expect(workspace.raiseViewPopup(draftKey(claude))).toBe(true);
    expect(workspace.popup?.id).toBe(compose);
    expect(workspace.hasDraft(claude)).toBe(false);
    press(workspace, "alt+j");
    expect(workspace.popup).toBeUndefined();
    expect(workspace.hasDraft(claude)).toBe(true);
    expect(host.destroyed).toEqual([]);
    workspace.paneExited(claude);
    expect(host.destroyed).toContain(compose);
    expect(workspace.popups).toEqual([]);
    expect(workspace.hideViewPopup(compose)).toBe(false);
  });

  test("Alt p and Alt a bring the open reply forward, and replace it once a newer reply arrives", () => {
    const clock = { now: 0 };
    const host = new FakeHost();
    const workspace = new Workspace(host, undefined, undefined, () => clock.now);
    const agent = workspace.focused;
    press(workspace, "ctrl+space", "t", "c");
    const elsewhere = workspace.active;
    workspace.setAgentState(agent, "done", "Built it");
    press(workspace, "alt+p");
    workspace.openViewPopup(60, "peek", agent, undefined, host.peekKeys[0]);
    workspace.openViewPopup(61, "Notebook", agent);
    expect(press(workspace, "alt+p")).toEqual([true]);
    expect(host.peeked).toHaveLength(1);
    expect(workspace.popup?.id).toBe(60);
    clock.now = 5;
    workspace.active = elsewhere;
    workspace.setAgentState(agent, "done", "Built it again");
    expect(press(workspace, "alt+a")).toEqual([true]);
    expect(host.destroyed).toEqual([60]);
    expect(host.peeked.map(([, , text]) => text)).toEqual(["Built it", "Built it again"]);
    expect(workspace.latestReply(agent)?.unread).toBe(false);
    workspace.openViewPopup(62, "peek", agent, undefined, host.peekKeys[1]);
    host.held.add(62);
    workspace.openViewPopup(63, "Notebook", agent);
    press(workspace, "alt+p");
    expect(host.destroyed).toEqual([60, 62]);
    expect(host.picked).toHaveLength(1);
  });

  test("peeking at an agent leaves another tab's open reply alone", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    const first = workspace.focused;
    press(workspace, "ctrl+space", "t", "c");
    const second = workspace.focused;
    workspace.setAgentState(first, "done", "first reply");
    workspace.active = 0;
    workspace.setAgentState(second, "done", "second reply");
    press(workspace, "alt+p");
    workspace.openViewPopup(60, "peek", first, undefined, host.peekKeys[0]);
    press(workspace, "alt+a");
    expect(host.peeked.map(([id]) => id)).toEqual([first, second]);
    expect(host.destroyed).toEqual([]);
  });

  test("a popup belongs to the tab it opened over", () => {
    const workspace = new Workspace(new FakeHost());
    const view = workspace.reservePaneId();
    workspace.openViewPopup(view, "Notebook", 1);
    expect(workspace.tabOf(view)).toBeUndefined();
    expect(workspace.ownerTab(view)).toBe(workspace.tab);
    expect(workspace.ownerTab(1)).toBe(workspace.tab);
    expect(workspace.ownerTab(99)).toBeUndefined();
  });

  test("a view popup held after a failure closes on the next key", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    const view = workspace.reservePaneId();
    workspace.openViewPopup(view, "Comments", 1);
    expect(workspace.popupsWaiting(workspace.tab)).toBe(0);
    expect(workspace.tabAttention(workspace.tab)).toBeUndefined();
    host.held.add(view);
    expect(press(workspace, "x")).toEqual([true]);
    expect(host.destroyed).toEqual([view]);
    expect(workspace.popup).toBeUndefined();
  });

  test("Alt+a takes you to a question and shows it straight away", () => {
    const clock = { now: 0 };
    const workspace = new Workspace(new FakeHost(), undefined, undefined, () => clock.now);
    press(workspace, "ctrl+space", "t", "c");
    workspace.openPopup(workspace.reservePaneId(), "Question", 1);
    press(workspace, "alt+a");
    expect([workspace.active, workspace.focused]).toEqual([0, 1]);
    expect(workspace.popup?.title).toBe("Question");
  });

  test("closing a pane in a pane-tab group keeps focus in the group", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+space", "p", "r", "ctrl+space", "p", "s", "ctrl+space", "p", "s");
    expect(workspace.tab.root).toMatchObject({ children: [{}, { kind: "tabs", panes: [2, 3, 4] }] });
    press(workspace, "alt+o", "ctrl+space", "p", "x");
    expect(workspace.focused).toBe(4);
  });

  test("Ctrl Space t a goes back to the previous tab", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+space", "t", "c", "ctrl+space", "t", "c", "ctrl+space", "t", "1");
    expect(workspace.active).toBe(0);
    press(workspace, "ctrl+space", "t", "a");
    expect(workspace.active).toBe(2);
    press(workspace, "ctrl+space", "t", "a");
    expect(workspace.active).toBe(0);
  });

  describe("agent states", () => {
    function twoTabs(): Workspace {
      const workspace = new Workspace(new FakeHost());
      press(workspace, "ctrl+space", "p", "r", "ctrl+space", "t", "c");
      return workspace;
    }

    test("states roll up to the tab and only unseen changes notify", () => {
      const workspace = twoTabs();
      expect(workspace.setAgentState(1, "working")).toBe(false);
      expect(workspace.tabAttention(workspace.tabs[0]!)).toBe("working");
      expect(workspace.setAgentState(2, "waiting")).toBe(true);
      expect(workspace.setAgentState(2, "waiting")).toBe(false);
      expect(workspace.tabAttention(workspace.tabs[0]!)).toBe("waiting");
      expect(workspace.setAgentState(3, "done")).toBe(false);
      expect(workspace.agents.get(3)).toBe("done");
      expect(workspace.setAgentState(1, "failed")).toBe(true);
      expect(workspace.tabAttention(workspace.tabs[0]!)).toBe("waiting");
      expect(workspace.setAgentState(99, "done")).toBe(false);
    });

    test("Alt+a jumps to waiting agents first, then done ones, and typing clears done", () => {
      const workspace = twoTabs();
      workspace.setAgentState(1, "done");
      workspace.setAgentState(2, "waiting");
      press(workspace, "alt+a");
      expect([workspace.active, workspace.focused]).toEqual([0, 2]);
      workspace.setAgentState(2, undefined);
      press(workspace, "alt+a");
      expect([workspace.active, workspace.focused]).toEqual([0, 1]);
      expect(workspace.agents.get(1)).toBe("done");
      press(workspace, "x");
      expect(workspace.agents.has(1)).toBe(false);
      press(workspace, "alt+a");
      expect(workspace.message).toBe("No agent needs you");
    });

    test("typing into a waiting agent's pane means it is being answered", () => {
      const workspace = twoTabs();
      press(workspace, "ctrl+space", "t", "h", "escape");
      workspace.setAgentState(2, "waiting");
      press(workspace, "y");
      expect(workspace.agents.get(2)).toBe("working");
    });

    test("a long command and an agent in one tab keep separate states", () => {
      const workspace = twoTabs();
      workspace.setAgentState(1, "working");
      expect(workspace.setCommandState(2, "running")).toBe(false);
      expect(workspace.tabAttention(workspace.tabs[0]!)).toBe("working");
      expect(workspace.tabCommandState(workspace.tabs[0]!)).toBe("running");
      expect(workspace.setCommandState(2, "succeeded")).toBe(true);
      expect(workspace.agents.get(1)).toBe("working");
      press(workspace, "alt+a");
      expect([workspace.active, workspace.focused]).toEqual([0, 2]);
      press(workspace, "x");
      expect(workspace.commands.has(2)).toBe(false);
      expect(workspace.agents.get(1)).toBe("working");
    });

    test("an exiting pane forgets its state", () => {
      const workspace = twoTabs();
      workspace.setAgentState(2, "waiting");
      workspace.setCommandState(2, "failed");
      workspace.paneExited(2);
      expect(workspace.agents.has(2)).toBe(false);
      expect(workspace.commands.has(2)).toBe(false);
    });
  });

  test("Ctrl Space t w picks a tray widget to open", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    press(workspace, "ctrl+space", "t", "w");
    expect(workspace.mode).toBe("tray");
    press(workspace, "s", "s", "s", "return");
    expect(host.openedWidgets).toEqual([1]);
    expect(workspace.mode).toBe("normal");
  });

  test("an empty tray cannot be entered", () => {
    const host = new FakeHost();
    host.widgets = 0;
    const workspace = new Workspace(host);
    press(workspace, "ctrl+space", "t", "w");
    expect(workspace.mode).toBe("normal");
    expect(workspace.message).toBe("The tray has no widgets");
  });

  test("there is no resize mode", () => {
    const workspace = new Workspace(new FakeHost());
    expect(press(workspace, "ctrl+n")).toEqual([false]);
    expect(workspace.mode).toBe("normal");
  });
  describe("shell drawer", () => {
    function split() {
      const host = new FakeHost();
      const workspace = new Workspace(host, "/home");
      press(workspace, "ctrl+space", "p", "d");
      return { host, workspace };
    }

    test("Alt d opens a shell in the focused pane's directory, focused, and hides it again", () => {
      const { host, workspace } = split();
      press(workspace, "alt+d");
      expect(host.created.at(-1)).toEqual([3, "/work/2"]);
      expect(host.commands.get(3)).toBeUndefined();
      expect(workspace.drawerOf()?.id).toBe(3);
      expect(workspace.focused).toBe(3);
      expect(workspace.tabPanes(workspace.tab)).toContain(3);
      press(workspace, "alt+d");
      expect(workspace.drawerOf()).toBeUndefined();
      expect(workspace.focused).toBe(2);
      press(workspace, "alt+d");
      expect(host.created.length).toBe(3);
      expect(workspace.focused).toBe(3);
    });

    test("a layout's drawer runs its command under its name at its height", () => {
      const host = new FakeHost();
      const config = configSchema.parse({ layouts: { ide: { drawer: { command: ["lazygit"], name: "git", height: 60 }, row: [{}, {}] } }, tabs: { work: { layout: "ide", cwd: "/work" } }, startup: ["work"] });
      const workspace = new Workspace(host, "/home", config);
      expect(host.created.length).toBe(2);
      press(workspace, "alt+d");
      expect(host.commands.get(3)).toEqual(["lazygit"]);
      expect(workspace.paneNames.get(3)).toBe("git");
      expect(workspace.drawerOf()?.height).toBe(60);
    });

    test("an exited drawer command is held: Enter re-runs it, Esc swaps in a shell, Ctrl+c closes it", () => {
      const { host, workspace } = split();
      press(workspace, "alt+d");
      host.held.add(3);
      expect(workspace.focusedPaneHeld()).toBe(true);
      press(workspace, "return");
      expect(host.reruns).toEqual([3]);
      host.held.add(3);
      press(workspace, "escape");
      expect(host.shells).toEqual([3]);
      host.held.add(3);
      press(workspace, "ctrl+c");
      expect(host.destroyed).toEqual([3]);
      expect(workspace.tab.drawer).toBeUndefined();
    });

    test("leaving the drawer hides it, by Alt t, Alt o/e, or a click above, and other focus keys stay put", () => {
      const { workspace } = split();
      press(workspace, "alt+d", "alt+t");
      expect(workspace.drawerOf()).toBeUndefined();
      expect(workspace.focused).toBe(2);
      press(workspace, "alt+d", "alt+h", "alt+s", "alt+n");
      expect(workspace.focused).toBe(3);
      press(workspace, "alt+e");
      expect(workspace.drawerOf()).toBeUndefined();
      expect(workspace.focused).toBe(2);
      press(workspace, "alt+d");
      workspace.focusPane(1);
      expect(workspace.drawerOf()).toBeUndefined();
      expect(workspace.focused).toBe(1);
    });

    test("focus keys and pane cycling leave a hidden drawer alone", () => {
      const { workspace } = split();
      press(workspace, "alt+n", "alt+e", "alt+e");
      expect(workspace.drawerOf()).toBeUndefined();
      expect(workspace.tab.drawer).toBeUndefined();
      expect(workspace.focused).toBe(2);
    });

    test("a popup over the drawer leaves it open and focused once it closes", () => {
      const { workspace } = split();
      press(workspace, "alt+d");
      expect(workspace.openPopup(90, "Allow Write?", 3)).toBe(false);
      workspace.popupExited(90);
      expect(workspace.focused).toBe(3);
    });

    test("panes opened from the drawer go beside the pane above it", () => {
      const { workspace } = split();
      press(workspace, "alt+d");
      const id = workspace.openPaneNear(3, "right", ["htop"]);
      expect(id).toBe(4);
      expect(paneIds(workspace.tab.root)).toEqual([1, 2, 4]);
      expect(workspace.drawerOf()).toBeUndefined();
      expect(workspace.focused).toBe(4);
    });

    test("commands in the drawer badge the tab, and only notify when the drawer isn't in view", () => {
      const { workspace } = split();
      press(workspace, "alt+d");
      expect(workspace.setCommandState(3, "failed")).toBe(false);
      expect(workspace.setCommandState(2, "failed")).toBe(true);
      press(workspace, "alt+d");
      expect(workspace.setCommandState(3, "succeeded")).toBe(true);
      expect(workspace.tabCommandState(workspace.tab)).toBe("failed");
    });

    test("Alt a from the drawer moves on to the next agent", () => {
      const { workspace } = split();
      press(workspace, "alt+d");
      workspace.setAgentState(3, "done");
      workspace.setAgentState(1, "done");
      press(workspace, "alt+a");
      expect(workspace.focused).toBe(1);
      expect(workspace.drawerOf()).toBeUndefined();
    });

    test("pane mode zooms the drawer, and resize mode changes its height within bounds", () => {
      const { workspace } = split();
      press(workspace, "alt+d", "ctrl+space", "p", "f");
      expect(workspace.drawerOf()?.zoomed).toBe(true);
      expect(workspace.tab.zoomed).toBe(false);
      press(workspace, "alt+d", "alt+d");
      expect(workspace.drawerOf()?.zoomed).toBe(true);
      press(workspace, "ctrl+space", "p", "e", "up");
      expect(workspace.mode).toBe("resize");
      expect(workspace.drawerOf()).toMatchObject({ zoomed: false, height: 50 });
      press(workspace, ...Array(8).fill("t"));
      expect(workspace.drawerOf()?.height).toBe(80);
      press(workspace, ...Array(8).fill("j"));
      expect(workspace.drawerOf()?.height).toBe(20);
      press(workspace, "escape");
      expect(workspace.mode).toBe("normal");
    });

    test("resize mode needs an open drawer", () => {
      const { workspace } = split();
      press(workspace, "ctrl+space", "p", "e");
      expect(workspace.mode).toBe("normal");
      expect(workspace.message).toBe("The drawer isn't open");
    });

    test("each tab keeps its own drawer", () => {
      const { host, workspace } = split();
      press(workspace, "alt+d", "ctrl+space", "t", "c", "alt+d");
      expect(workspace.drawerOf()?.id).toBe(5);
      press(workspace, "ctrl+space", "t", "h");
      expect(workspace.drawerOf()?.id).toBe(3);
      expect(host.created.map(([id]) => id)).toEqual([1, 2, 3, 4, 5]);
    });

    test("the drawer survives a layout restart and closes when its shell exits", () => {
      const { host, workspace } = split();
      press(workspace, "alt+d", "alt+t", "ctrl+space", "t", "shift+r");
      type(workspace, workspace.tab.name);
      press(workspace, "return");
      expect(host.destroyed).not.toContain(3);
      press(workspace, "alt+d");
      expect(workspace.focused).toBe(3);
      workspace.paneExited(3);
      expect(workspace.tab.drawer).toBeUndefined();
      expect(workspace.focused).toBe(workspace.tab.layoutFocus);
      press(workspace, "alt+d");
      expect(workspace.drawerOf()?.id).not.toBe(3);
    });

    test("closing the drawer from pane mode, or its tab, destroys its shell", () => {
      const { host, workspace } = split();
      press(workspace, "alt+d", "ctrl+space", "p", "x");
      expect(host.destroyed).toEqual([3]);
      expect(workspace.tab.drawer).toBeUndefined();
      expect(paneIds(workspace.tab.root)).toEqual([1, 2]);
      press(workspace, "alt+d", "ctrl+space", "t", "x");
      type(workspace, workspace.tab.name);
      press(workspace, "return");
      expect(host.destroyed).toContain(4);
    });

    test("a click on a layout pane leaves the drawer, and focusing the drawer shows it", () => {
      const { workspace } = split();
      press(workspace, "alt+d");
      workspace.focusPane(1);
      expect(workspace.focused).toBe(1);
      press(workspace, "alt+d", "alt+d");
      expect(workspace.drawerOf()).toBeUndefined();
      workspace.focusPane(3);
      expect(workspace.focused).toBe(3);
    });
  });

  describe("jobs", () => {
    function ide(clock: { now: number }, host = new FakeHost()) {
      const config = configSchema.parse({
        projects: { layout: "ide" },
        layouts: { ide: { row: [{ focus: true }, { tabs: [{ command: ["remax"] }, {}] }] } },
      });
      const workspace = new Workspace(host, "/home", config, () => clock.now);
      workspace.openProject("merlin");
      return { host, workspace };
    }

    test("Ctrl Space j n runs a typed command out of sight and badges the tab while it runs", () => {
      const clock = { now: 0 };
      const { host, workspace } = ide(clock);
      press(workspace, "ctrl+space", "j", "n");
      type(workspace, "make test");
      press(workspace, "return");
      expect(host.jobs).toEqual([[5, ["sh", "-c", "make test"], workspace.tab.id]]);
      expect(workspace.tabJobs().map((job) => [job.name, job.state])).toEqual([["make test", "running"]]);
      expect(paneIds(workspace.tab.root)).toEqual([2, 3, 4]);
      expect(workspace.tabCommandState(workspace.tab)).toBe("running");
      expect(workspace.mode).toBe("normal");
    });

    test("a job that succeeds toasts for five seconds", () => {
      const clock = { now: 0 };
      const { workspace } = ide(clock);
      const id = workspace.runJob(2, ["true"])!;
      clock.now = 3000;
      workspace.jobFinished(id, 0);
      expect(workspace.toasts()).toMatchObject([{ kind: "job", job: { state: "succeeded" } }]);
      expect(workspace.nextToastExpiry()).toBe(5000);
      expect(workspace.tabCommandState(workspace.tab)).toBeUndefined();
      clock.now = 8000;
      expect(workspace.toasts()).toEqual([]);
      expect(workspace.nextToastExpiry()).toBeUndefined();
    });

    test("a tab keeps its five newest finished jobs, plus failures not yet looked at", () => {
      const clock = { now: 0 };
      const { workspace } = ide(clock);
      const failed = workspace.runJob(2, ["false"], "failed")!;
      const ids = [1, 2, 3, 4, 5, 6, 7].map((n) => workspace.runJob(2, ["true"], `ok ${n}`)!);
      clock.now = 1;
      workspace.jobFinished(failed, 1);
      for (const id of ids) {
        clock.now += 1;
        workspace.jobFinished(id, 0);
      }
      const running = workspace.runJob(2, ["sleep", "9"], "running")!;
      expect(workspace.tabJobs().map((job) => job.name)).toEqual(["failed", "ok 3", "ok 4", "ok 5", "ok 6", "ok 7", "running"]);
      workspace.openJob(failed);
      const last = workspace.runJob(2, ["true"], "last")!;
      clock.now += 1;
      workspace.jobFinished(last, 0);
      expect(workspace.tabJobs().map((job) => job.id)).toEqual([failed, ...ids.slice(3), running, last]);
    });

    test("a failed job stays toasted, badges its tab, and Alt a opens it", () => {
      const clock = { now: 0 };
      const { host, workspace } = ide(clock);
      const id = workspace.runJob(2, ["false"], "build")!;
      press(workspace, "ctrl+space", "t", "c");
      workspace.jobFinished(id, 2);
      clock.now = 60_000;
      expect(workspace.toasts()).toMatchObject([{ kind: "job", job: { name: "build" }, tab: { name: "merlin" } }]);
      expect(workspace.tabCommandState(workspace.tabs[1]!)).toBe("failed");
      press(workspace, "alt+a");
      expect(workspace.tab.name).toBe("merlin");
      expect(workspace.popup).toMatchObject({ id, kind: "job" });
      expect(workspace.toasts()).toEqual([]);
      host.held.add(id);
      press(workspace, "escape");
      expect(workspace.popup).toBeUndefined();
      expect(workspace.tabJobs()).toHaveLength(1);
    });

    test("Alt x dismisses a failed job's toast and its tab badge", () => {
      const clock = { now: 0 };
      const { workspace } = ide(clock);
      const id = workspace.runJob(2, ["false"], "build")!;
      press(workspace, "ctrl+space", "t", "c");
      workspace.jobFinished(id, 2);
      workspace.setAgentState(3, "done", "reply");
      expect(workspace.toasts()).toMatchObject([{ kind: "job", job: { name: "build" } }, { kind: "reply" }]);
      press(workspace, "alt+x");
      expect(workspace.toasts()).toMatchObject([{ kind: "reply" }]);
      expect(workspace.tabCommandState(workspace.tabs[0]!)).toBeUndefined();
      expect(workspace.popup).toBeUndefined();
    });

    test("a finished job's popup re-runs, moves into the layout, or closes", () => {
      const clock = { now: 0 };
      const { host, workspace } = ide(clock);
      const id = workspace.runJob(2, ["false"], "build")!;
      workspace.jobFinished(id, 1);
      workspace.openJob(id);
      host.held.add(id);
      press(workspace, "return");
      expect(host.reruns).toEqual([id]);
      expect(workspace.jobStatus(id)?.state).toBe("running");
      workspace.jobFinished(id, 1);
      host.held.add(id);
      press(workspace, "p");
      expect(workspace.tab.root).toMatchObject({ children: [{ id: 2 }, { kind: "tabs", panes: [3, 4, id] }] });
      expect(workspace.focused).toBe(id);
      expect(workspace.paneNames.get(id)).toBe("build");
      expect(host.untracked).toEqual([id]);
      expect(workspace.jobs).toEqual([]);
      const other = workspace.runJob(2, ["false"])!;
      workspace.jobFinished(other, 1);
      workspace.openJob(other);
      host.held.add(other);
      press(workspace, "x");
      expect(host.destroyed).toContain(other);
      expect(workspace.jobs).toEqual([]);
      expect(workspace.popup).toBeUndefined();
    });

    test("jobs mode picks a job with the arrows and acts on it", () => {
      const clock = { now: 0 };
      const { host, workspace } = ide(clock);
      workspace.runJob(2, ["one"]);
      const two = workspace.runJob(2, ["two"])!;
      press(workspace, "ctrl+space", "j", "down", "r");
      expect(host.reruns).toEqual([]);
      expect(workspace.message).toBe("two is still running");
      workspace.jobFinished(two, 1);
      press(workspace, "r");
      expect(host.reruns).toEqual([two]);
      press(workspace, "return");
      expect(workspace.popup?.id).toBe(two);
      press(workspace, "ctrl+space", "j", "h");
      expect(workspace.popup).toBeUndefined();
      press(workspace, "ctrl+space", "j", "x");
      expect(workspace.selectedJob).toBe(0);
      expect(workspace.tabJobs().map((job) => job.name)).toEqual(["one"]);
    });

    test("Ctrl Space j b sends a pane running a command to the background until the command finishes", () => {
      const clock = { now: 0 };
      const { host, workspace } = ide(clock);
      press(workspace, "ctrl+space", "j", "b");
      expect(workspace.message).toBe("Nothing is running in this pane");
      press(workspace, "alt+s", "alt+e");
      host.running.set(4, "cargo build");
      press(workspace, "ctrl+space", "j", "b");
      expect(workspace.tab.root).toMatchObject({ children: [{ id: 2 }, { id: 3 }] });
      expect(workspace.focused).toBe(3);
      expect(host.tracked).toEqual([4]);
      expect(workspace.tabJobs().map((job) => [job.name, job.command])).toEqual([["cargo build", undefined]]);
      workspace.jobFinished(4, 0);
      expect(workspace.jobStatus(4)?.state).toBe("succeeded");
      workspace.openJob(4);
      press(workspace, "return");
      expect(workspace.message).toBe("Only jobs started from a command can re-run");
      press(workspace, "escape");
      expect(workspace.popup).toBeUndefined();
      workspace.openJob(4);
      press(workspace, "p");
      expect(paneIds(workspace.tab.root)).toEqual([2, 3, 4]);
      expect(workspace.focused).toBe(4);
    });

    test("an agent running as a job badges its tab, owns its popups, and is found by Alt a and Alt c", () => {
      const clock = { now: 0 };
      const { host, workspace } = ide(clock);
      const claude = workspace.runJob(2, ["komux", "claude"], "claude")!;
      expect(workspace.tabCommandState(workspace.tab)).toBe("running");
      workspace.markAgent(claude);
      expect(workspace.tabCommandState(workspace.tab)).toBeUndefined();
      workspace.setAgentState(claude, "working");
      expect(workspace.tabAttention(workspace.tab)).toBe("working");
      expect(workspace.tabCommandState(workspace.tab)).toBeUndefined();
      press(workspace, "ctrl+space", "t", "c");
      expect(workspace.setAgentState(claude, "done")).toBe(true);
      expect(workspace.openPopup(90, "Allow Write?", claude)).toBe(true);
      expect(workspace.popups.at(-1)?.tabId).toBe(workspace.tabs.find((tab) => tab.name === "merlin")!.id);
      workspace.popupExited(90);
      press(workspace, "alt+a");
      expect(workspace.tab.name).toBe("merlin");
      expect(workspace.popup).toMatchObject({ id: claude, kind: "job" });
      expect(workspace.agents.has(claude)).toBe(false);
      workspace.setAgentState(claude, "waiting");
      press(workspace, "x");
      expect(workspace.agents.get(claude)).toBe("working");
      press(workspace, "ctrl+space", "j", "h");
      host.claudes.add(claude);
      press(workspace, "alt+c");
      expect(host.composed).toEqual([claude]);
      const tests = workspace.runJob(claude, ["bun", "test"])!;
      expect(workspace.jobStatus(tests)?.tabId).toBe(workspace.tab.id);
      workspace.setAgentState(claude, "done");
      workspace.closeJob(claude);
      expect(workspace.agents.has(claude)).toBe(false);
    });

    test("an agent awaits the running jobs it started, not the ones started near it", () => {
      const { workspace } = ide({ now: 0 });
      const claude = workspace.runJob(2, ["komux", "claude"], "claude")!;
      const build = workspace.runJob(claude, ["scripts/build"], "build", { startedBy: claude })!;
      workspace.runJob(claude, ["scripts/test"], "test", { startedBy: claude });
      workspace.runJob(claude, ["scripts/up"], "up");
      expect(workspace.awaitedJobs(claude)).toBe(2);
      expect(workspace.awaitedJobs(2)).toBe(0);
      workspace.jobFinished(build, 0);
      expect(workspace.awaitedJobs(claude)).toBe(1);
      workspace.jobFinished(claude, 0);
      workspace.openJob(claude);
      press(workspace, "return");
      expect(workspace.jobStatus(claude)?.state).toBe("running");
      expect(workspace.awaitedJobs(claude)).toBe(0);
    });

    test("the last pane in a tab can't go to the background", () => {
      const host = new FakeHost();
      const workspace = new Workspace(host);
      host.running.set(1, "sleep 30");
      press(workspace, "ctrl+space", "j", "b");
      expect(workspace.message).toBe("The tab's last pane can't go to the background");
      expect(workspace.jobs).toEqual([]);
    });

    test("a backgrounded pane's shell exiting drops the job, and closing a tab closes its jobs", () => {
      const clock = { now: 0 };
      const { host, workspace } = ide(clock);
      host.running.set(2, "sleep 30");
      press(workspace, "ctrl+space", "j", "b");
      workspace.paneExited(2);
      expect(workspace.jobs).toEqual([]);
      expect(workspace.message).toBe("sleep 30 ended");
      const id = workspace.runJob(3, ["sleep", "30"])!;
      workspace.paneExited(3);
      workspace.paneExited(4);
      expect(host.destroyed).toContain(id);
      expect(workspace.jobs).toEqual([]);
    });

    test("an agent job opened by Alt a hides once you reply and the agent gets back to work", () => {
      const { workspace } = ide({ now: 0 });
      const claude = workspace.runJob(2, ["komux", "claude"], "claude")!;
      workspace.setAgentState(claude, "done");
      press(workspace, "alt+a");
      expect(workspace.popup).toMatchObject({ id: claude, kind: "job" });
      workspace.setAgentState(claude, "working");
      expect(workspace.popup).toBeUndefined();
      workspace.setAgentState(claude, "done");
      press(workspace, "ctrl+space", "j", "return");
      workspace.setAgentState(claude, "working");
      expect(workspace.popup).toMatchObject({ id: claude, kind: "job" });
    });

    test("a job stops counting as an agent when its Claude leaves or it runs again", () => {
      const { workspace } = ide({ now: 0 });
      const job = workspace.runJob(2, ["komux", "claude"], "claude")!;
      workspace.markAgent(job);
      workspace.markAgent(job, false);
      expect(workspace.jobStatus(job)?.agent).toBe(false);
      workspace.markAgent(job);
      workspace.jobFinished(job, 0);
      press(workspace, "ctrl+space", "j", "r");
      expect(workspace.jobStatus(job)).toMatchObject({ state: "running", agent: false });
    });

    test("a dormant Claude job forgets that it was dormant when it closes", () => {
      const { workspace } = ide({ now: 0 });
      const claude = workspace.runJob(2, ["komux", "claude"], "claude")!;
      workspace.dormant.add(claude);
      workspace.closeJob(claude);
      expect(workspace.dormant.has(claude)).toBe(false);
    });

    test("Alt j hides the open job, running or finished, and reopens the last one", () => {
      const { workspace } = ide({ now: 0 });
      press(workspace, "alt+j");
      expect(workspace.message).toBe("No job or question to reopen");
      const job = workspace.runJob(2, ["make"])!;
      press(workspace, "ctrl+space", "j", "return");
      expect(workspace.popup).toMatchObject({ id: job, kind: "job" });
      press(workspace, "alt+j");
      expect(workspace.popup).toBeUndefined();
      press(workspace, "alt+j");
      expect(workspace.popup).toMatchObject({ id: job, kind: "job" });
      workspace.jobFinished(job, 1);
      press(workspace, "alt+j");
      expect(workspace.popup).toBeUndefined();
      const merlin = workspace.tab;
      press(workspace, "ctrl+space", "t", "c", "alt+j");
      expect(workspace.tab).not.toBe(merlin);
      expect(workspace.popup).toBeUndefined();
      expect(workspace.message).toBe("No job or question to reopen");
    });

    test("Alt j opens the newest job in the tab when none has been opened", () => {
      const clock = { now: 0 };
      const { workspace } = ide(clock);
      workspace.runJob(2, ["make"]);
      clock.now = 10;
      const newest = workspace.runJob(2, ["make", "test"])!;
      clock.now = 20;
      press(workspace, "ctrl+space", "t", "c");
      workspace.runJob(workspace.focused, ["elsewhere"]);
      press(workspace, "ctrl+space", "t", "a", "alt+j");
      expect(workspace.popup).toMatchObject({ id: newest, kind: "job" });
    });

    test("Alt p switches to the reply's tab, and Alt x dismisses the top toast", () => {
      const clock = { now: 0 };
      const { host, workspace } = ide(clock);
      const merlin = workspace.tab;
      const agent = merlin.layoutFocus;
      const other = paneIds(merlin.root).find((id) => id !== agent)!;
      press(workspace, "ctrl+space", "t", "c");
      workspace.setAgentState(agent, "done", "first");
      clock.now = 10;
      workspace.setAgentState(other, "done", "second");
      press(workspace, "alt+x");
      expect(workspace.toasts()).toMatchObject([{ kind: "reply", id: other }]);
      press(workspace, "alt+p");
      expect(workspace.tab).toBe(merlin);
      expect(host.peeked.map(([id]) => id)).toEqual([other]);
      expect(press(workspace, "alt+x")).toEqual([false]);
    });

    test("Alt a shows an agent's question where you are, then peeks at unread replies", () => {
      const { host, workspace } = ide({ now: 5 });
      const [first, second] = paneIds(workspace.tab.root) as [number, number];
      press(workspace, "ctrl+space", "t", "c");
      const merlin = workspace.tabs.find((tab) => tab.name === "merlin")!;
      workspace.setAgentState(first, "done", "Which one?");
      expect(workspace.openPopup(90, "Allow Write?", second)).toBe(true);
      press(workspace, "alt+j", "alt+a");
      expect([workspace.tab.name, workspace.popup?.id]).toEqual(["merlin", 90]);
      expect(workspace.focused).toBe(first);
      workspace.popupExited(90);
      workspace.active = 0;
      press(workspace, "alt+a");
      expect(host.peeked).toEqual([[first, "Claude · merlin", "Which one?"]]);
      expect(workspace.tab).toBe(merlin);
    });

    test("an agent's reply is unread until its pane is seen or peeked at", () => {
      const { host, workspace } = ide({ now: 5 });
      const agent = workspace.focused;
      workspace.setAgentState(agent, "done", "Seen as it came");
      expect(workspace.toasts()).toEqual([]);
      press(workspace, "alt+s");
      workspace.setAgentState(agent, "done", "**Built** it\nmore");
      expect(workspace.tabUnread(workspace.tab)).toBe(true);
      expect(workspace.toasts()).toMatchObject([{ kind: "reply", id: agent, reply: { text: "**Built** it\nmore" } }]);
      press(workspace, "alt+p");
      expect(host.peeked).toEqual([[agent, "Claude · merlin", "**Built** it\nmore"]]);
      expect(workspace.toasts()).toEqual([]);
      expect(workspace.agents.has(agent)).toBe(false);
      workspace.setAgentState(agent, "done", "Again");
      press(workspace, "alt+h");
      expect(workspace.tabUnread(workspace.tab)).toBe(false);
      const empty = new Workspace(new FakeHost());
      press(empty, "alt+p");
      expect(empty.message).toBe("No agent reply to show");
    });

    test("a reply marked for no toast leaves the tab as it was before the turn", () => {
      const { workspace } = ide({ now: 5 });
      const agent = workspace.focused;
      press(workspace, "ctrl+space", "t", "c");
      workspace.setAgentState(agent, "done", "Shall I start?");
      workspace.setAgentState(agent, "working");
      expect(workspace.setAgentState(agent, "done", "That was my own edit.", "none")).toBe(false);
      expect(workspace.agents.get(agent)).toBe("done");
      expect(workspace.toasts()).toMatchObject([{ kind: "reply", reply: { text: "Shall I start?" }, brief: false }]);
      expect(workspace.latestReply(agent)?.text).toBe("Shall I start?");
      expect(workspace.replies.get(agent)).toHaveLength(1);
      workspace.seeReply(agent);
      workspace.agents.delete(agent);
      workspace.setAgentState(agent, "working");
      workspace.setAgentState(agent, "done", "Nothing new.", "none");
      expect(workspace.agents.has(agent)).toBe(false);
      expect(workspace.setAgentState(agent, "done")).toBe(false);
      expect(workspace.agents.has(agent)).toBe(false);
      workspace.setAgentState(agent, "working");
      expect(workspace.setAgentState(agent, "done")).toBe(true);
    });

    test("a wakeup turn keeps the tab as it was and still toasts a reply that needs you", () => {
      const { workspace } = ide({ now: 5 });
      const agent = workspace.focused;
      press(workspace, "ctrl+space", "t", "c");
      workspace.setAgentState(agent, "done", "Shall I start?");
      expect(workspace.setAgentState(agent, "working", undefined, undefined, true)).toBe(false);
      expect(workspace.agents.get(agent)).toBe("done");
      expect(workspace.wakeups.has(agent)).toBe(true);
      workspace.setAgentState(agent, "done", "That was my own edit.", "none");
      expect(workspace.wakeups.has(agent)).toBe(false);
      expect(workspace.latestReply(agent)?.text).toBe("Shall I start?");
      workspace.setAgentState(agent, "working", undefined, undefined, true);
      expect(workspace.setAgentState(agent, "done", "The build failed.")).toBe(true);
      expect(workspace.toasts()).toMatchObject([{ kind: "reply", reply: { text: "The build failed." } }]);
      workspace.seeReply(agent);
      workspace.agents.delete(agent);
      workspace.setAgentState(agent, "working", undefined, undefined, true);
      expect(workspace.setAgentState(agent, "done")).toBe(false);
      expect(workspace.agents.has(agent)).toBe(false);
    });

    test("a wakeup turn that runs past a second shows as working, and a quiet end puts the old badge back", () => {
      const clock = { now: 5 };
      const { workspace } = ide(clock);
      const agent = workspace.focused;
      press(workspace, "ctrl+space", "t", "c");
      workspace.setAgentState(agent, "done", "Shall I start?");
      workspace.setAgentState(agent, "working", undefined, undefined, true);
      expect(workspace.nextWakeupShown()).toBe(1000);
      clock.now += 999;
      workspace.showLongWakeups();
      expect(workspace.agents.get(agent)).toBe("done");
      workspace.setAgentState(agent, "working", undefined, undefined, true);
      clock.now += 1;
      workspace.showLongWakeups();
      expect(workspace.agents.get(agent)).toBe("working");
      expect(workspace.nextWakeupShown()).toBeUndefined();
      workspace.setAgentState(agent, "working", undefined, undefined, true);
      expect(workspace.wakeups.has(agent)).toBe(true);
      workspace.setAgentState(agent, "done", "Nothing new.", "none");
      expect(workspace.agents.get(agent)).toBe("done");
      workspace.setAgentState(agent, "working", undefined, undefined, true);
      clock.now += 1000;
      workspace.showLongWakeups();
      expect(workspace.setAgentState(agent, "done", "The tour is ready.")).toBe(true);
      expect(workspace.toasts()).toMatchObject([{ kind: "reply", reply: { text: "The tour is ready." } }]);
    });

    test("a wakeup that needs you, or arrives mid-turn, changes state as usual", () => {
      const { workspace } = ide({ now: 5 });
      const agent = workspace.focused;
      press(workspace, "ctrl+space", "t", "c");
      workspace.setAgentState(agent, "working", undefined, undefined, true);
      expect(workspace.agents.has(agent)).toBe(false);
      workspace.setAgentState(agent, "waiting");
      expect(workspace.agents.get(agent)).toBe("waiting");
      expect(workspace.wakeups.has(agent)).toBe(false);
      workspace.setAgentState(agent, "working");
      workspace.setAgentState(agent, "working", undefined, undefined, true);
      expect(workspace.agents.get(agent)).toBe("working");
      expect(workspace.wakeups.has(agent)).toBe(false);
    });

    test("a quiet reply keeps a badge it can't place in a turn, and drops one you saw mid-turn", () => {
      const { workspace } = ide({ now: 5 });
      const agent = workspace.focused;
      press(workspace, "ctrl+space", "t", "c");
      const elsewhere = workspace.active;
      workspace.setAgentState(agent, "done", "Shall I start?");
      workspace.setAgentState(agent, "done", "Nothing new.", "none");
      expect(workspace.agents.get(agent)).toBe("done");
      workspace.setAgentState(agent, "working");
      workspace.focusPane(agent);
      press(workspace, "x");
      workspace.active = elsewhere;
      workspace.setAgentState(agent, "done", "Build passed.", "brief");
      expect(workspace.agents.has(agent)).toBe(false);
    });

    test("a brief reply toasts for five seconds and keeps the unread reply's toast", () => {
      const clock = { now: 5 };
      const { workspace } = ide(clock);
      const agent = workspace.focused;
      press(workspace, "ctrl+space", "t", "c");
      workspace.setAgentState(agent, "done", "Shall I start?");
      workspace.setAgentState(agent, "working");
      expect(workspace.setAgentState(agent, "done", "Build passed.", "brief")).toBe(false);
      expect(workspace.toasts()).toMatchObject([
        { kind: "reply", reply: { text: "Build passed." }, brief: true },
        { kind: "reply", reply: { text: "Shall I start?" }, brief: false },
      ]);
      expect(workspace.nextToastExpiry()).toBe(5000);
      expect(workspace.latestReply(agent)?.text).toBe("Shall I start?");
      clock.now += 5000;
      expect(workspace.toasts()).toMatchObject([{ reply: { text: "Shall I start?" } }]);
      expect(workspace.replies.get(agent)?.map((reply) => reply.text)).toEqual(["Shall I start?", "Build passed."]);
    });

    test("Alt p goes to the agent whose unread reply is newest, not whose last reply is", () => {
      const clock = { now: 1 };
      const { host, workspace } = ide(clock);
      const [first, second] = paneIds(workspace.tab.root) as [number, number];
      press(workspace, "ctrl+space", "t", "c");
      workspace.setAgentState(first, "done", "older question");
      clock.now = 5;
      workspace.setAgentState(second, "done", "newer question");
      clock.now = 10;
      workspace.setAgentState(first, "working");
      workspace.setAgentState(first, "done", "Build passed.", "brief");
      press(workspace, "alt+p");
      expect(host.picked).toEqual([]);
      expect(host.peeked.map(([id, , text]) => [id, text])).toEqual([[second, "newer question"]]);
    });

    test("Alt p opens a lone reply and lists the agent's replies when there is a choice", () => {
      const clock = { now: 0 };
      const { host, workspace } = ide(clock);
      const agent = workspace.focused;
      press(workspace, "ctrl+space", "t", "c");
      const elsewhere = workspace.active;
      workspace.setAgentState(agent, "done", "first");
      press(workspace, "alt+p");
      expect(host.peeked.map(([, , text]) => text)).toEqual(["first"]);
      press(workspace, "alt+p");
      expect(host.peeked.map(([, , text]) => text)).toEqual(["first", "first"]);
      clock.now = 120_000;
      workspace.active = elsewhere;
      workspace.setAgentState(agent, "done", "second");
      press(workspace, "alt+p");
      expect(host.peeked.map(([, , text]) => text)).toEqual(["first", "first", "second"]);
      workspace.active = elsewhere;
      workspace.setAgentState(agent, "done", "**third**\nmore");
      workspace.setAgentState(agent, "done", "fourth");
      press(workspace, "alt+p");
      expect(host.picked).toHaveLength(1);
      const [near, title, choices] = host.picked[0]!;
      expect([near, title]).toEqual([agent, "Claude · merlin"]);
      expect(choices.map((choice) => choice.label)).toEqual(["just now  new  fourth", "just now  new  third", "just now       second", "2m ago         first"]);
      expect(choices[1]!.text).toBe("**third**\nmore");
      expect(workspace.toasts()).toEqual([]);
      for (let n = 0; n < 12; n += 1) workspace.setAgentState(agent, "done", `reply ${n}`);
      expect(workspace.replies.get(agent)).toHaveLength(10);
      expect(workspace.replies.get(agent)?.[0]?.text).toBe("reply 2");
    });

    test("an unread reply outlasts ten newer read ones", () => {
      const { workspace } = ide({ now: 5 });
      const agent = workspace.focused;
      press(workspace, "ctrl+space", "t", "c");
      workspace.setAgentState(agent, "done", "Shall I start?");
      for (let n = 0; n < 12; n += 1) {
        workspace.setAgentState(agent, "working");
        workspace.setAgentState(agent, "done", `event ${n}`, "brief");
      }
      const kept = workspace.replies.get(agent)!.map((reply) => reply.text);
      expect(kept).toHaveLength(10);
      expect(kept[0]).toBe("Shall I start?");
      expect(kept.at(-1)).toBe("event 11");
    });

    test("Ctrl Space t R rebuilds the tab from its layout after you type its name", () => {
      const host = new FakeHost();
      const config = configSchema.parse({
        projects: { layout: "up" },
        layouts: { up: { row: [{ focus: true }, { command: ["remax"] }], jobs: [{ command: ["scripts/up"] }] } },
      });
      const workspace = new Workspace(host, "/home", config, () => 0);
      workspace.openProject("merlin");
      const tab = workspace.tab;
      const before = paneIds(tab.root);
      const layoutJob = tab.layoutRuns.get(0)!;
      const adHoc = workspace.runJob(tab.layoutFocus, ["make"])!;
      press(workspace, "ctrl+space", "p", "r");
      workspace.openPopup(90, "Allow Write?", tab.layoutFocus);
      press(workspace, "alt+j");
      press(workspace, "ctrl+space", "t", "shift+r", "x", "return");
      expect(workspace.message).toBe("Left the tab running");
      press(workspace, "ctrl+space", "t", "shift+r", ..."merlin".split(""), "return");
      expect(workspace.tab).toBe(tab);
      expect(host.destroyed).toEqual(expect.arrayContaining([...before, layoutJob, adHoc]));
      expect(paneIds(tab.root)).toHaveLength(2);
      expect(paneIds(tab.root).some((id) => before.includes(id))).toBe(false);
      expect(paneIds(tab.root).map((id) => host.commands.get(id))).toEqual([undefined, ["remax"]]);
      expect(workspace.tabJobs(tab).map((job) => job.command)).toEqual([["scripts/up"]]);
      expect(host.destroyed).toContain(90);
      expect(workspace.hiddenAsks()).toEqual([]);
    });

    test("restarting a tab opened without its jobs leaves them stopped", () => {
      const config = configSchema.parse({ projects: { layout: "up" }, layouts: { up: { row: [{}], jobs: [{ command: ["scripts/up"] }] } } });
      const workspace = new Workspace(new FakeHost(), "/home", config, () => 0);
      workspace.openProject("merlin", false);
      press(workspace, "ctrl+space", "t", "shift+r", ..."merlin".split(""), "return");
      expect(workspace.tabJobs(workspace.tab)).toEqual([]);
    });

    test("closing the last tab with several jobs closes them all", () => {
      const { host, workspace } = ide({ now: 0 });
      const first = workspace.tab.name;
      press(workspace, "ctrl+space", "t", "c");
      const jobs = [workspace.runJob(workspace.focused, ["one"])!, workspace.runJob(workspace.focused, ["two"])!];
      press(workspace, "ctrl+space", "t", "x", ...workspace.tab.name.split(""), "return");
      expect(host.destroyed).toEqual(expect.arrayContaining(jobs));
      expect(workspace.jobs).toEqual([]);
      expect(workspace.tab.name).toBe(first);
    });
  });

  test("Alt j hides an open question and brings it back; Alt a shows it too", () => {
    const workspace = new Workspace(new FakeHost());
    workspace.openPopup(50, "Deploy?");
    expect(workspace.popup?.id).toBe(50);
    press(workspace, "alt+j");
    expect(workspace.popup).toBeUndefined();
    expect(workspace.hiddenAsks().map((popup) => popup.id)).toEqual([50]);
    expect(workspace.tabAttention(workspace.tab)).toBe("waiting");
    expect(press(workspace, "x")).toEqual([false]);
    press(workspace, "alt+j");
    expect(workspace.popup?.id).toBe(50);
    press(workspace, "alt+j", "alt+a");
    expect(workspace.popup?.id).toBe(50);
    workspace.popupExited(50);
    expect(workspace.hiddenAsks()).toEqual([]);
  });

  test("Alt keys reach komux over every kind of popup", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    const agent = workspace.focused;
    workspace.setAgentState(agent, "done", "Built it");
    workspace.openPopup(50, "Deploy?");
    expect(press(workspace, "alt+p", "alt+h")).toEqual([true, false]);
    expect(host.peeked.map(([id]) => id)).toEqual([agent]);
    workspace.openViewPopup(60, "peek", agent);
    expect(press(workspace, "alt+x", "alt+j")).toEqual([false, true]);
    expect(host.destroyed).toContain(60);
    expect(workspace.popup?.id).toBe(50);
    workspace.popupExited(50);
    const job = workspace.runJob(agent, ["make"])!;
    press(workspace, "ctrl+space", "j", "return");
    expect(workspace.popup).toMatchObject({ id: job, kind: "job" });
    workspace.jobFinished(job, 0);
    expect(press(workspace, "alt+a")).toEqual([true]);
  });

  test("Alt c messages the focused native Claude, or the tab's first one", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    press(workspace, "alt+c");
    expect(workspace.message).toBe("No native Claude in this tab");
    press(workspace, "ctrl+space", "p", "r");
    host.claudes.add(1);
    press(workspace, "alt+c");
    expect(host.composed).toEqual([1]);
    expect(workspace.message).toBeUndefined();
    host.claudes.add(2);
    press(workspace, "alt+c");
    expect(host.composed).toEqual([1, 2]);
    expect(workspace.focused).toBe(2);
  });

  test("Alt shift c asks the focused pane for context", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    press(workspace, "alt+shift+c");
    expect(workspace.message).toBe("No native Claude in this tab");
    press(workspace, "ctrl+space", "p", "r");
    host.claudes.add(1);
    press(workspace, "alt+shift+c");
    press(workspace, "alt+shift+C");
    expect(host.contextAsked).toEqual([
      [1, [1]],
      [2, [1, 2]],
      [2, [1, 2]],
    ]);
    expect(workspace.message).toBeUndefined();
    expect(host.composed).toEqual([]);
  });

  test("Ctrl+s reaches popups, so forms can submit, and the leader opens jobs mode over a job", () => {
    const workspace = new Workspace(new FakeHost());
    workspace.openPopup(50, "Question");
    expect(press(workspace, "ctrl+s")).toEqual([false]);
    workspace.popupExited(50);
    const job = workspace.runJob(1, ["sleep", "5"])!;
    workspace.openJob(job);
    expect(press(workspace, "ctrl+s")).toEqual([false]);
    press(workspace, "ctrl+space", "j");
    expect(workspace.mode).toBe("jobs");
  });
});

describe("scripts", () => {
  function ide(clock: { now: number }) {
    const config = configSchema.parse({ projects: { layout: "ide" }, layouts: { ide: { row: [{ focus: true }, {}] } } });
    const workspace = new Workspace(new FakeHost(), "/home", config, () => clock.now);
    workspace.openProject("merlin");
    return { workspace };
  }

  test("a script's dock text, tray text and toast belong to its job", () => {
    const clock = { now: 0 };
    const { workspace } = ide(clock);
    const id = workspace.runJob(2, ["komux", "script", "host", "x"], "deploy")!;
    expect(workspace.setJobDock(id, "3 of 5 done")).toBe(true);
    expect(workspace.tabJobs()[0]).toMatchObject({ dock: true });
    expect(workspace.jobTexts.get(id)).toBe("3 of 5 done");
    workspace.setTrayText(id, "⏳ 3/5");
    workspace.addNote(id, "halfway");
    expect(workspace.toasts()).toMatchObject([{ kind: "note", id, note: { text: "halfway" } }]);
    expect(workspace.nextToastExpiry()).toBe(5000);
    clock.now = 6000;
    expect(workspace.toasts()).toEqual([]);
    workspace.setJobDock(id, null);
    expect(workspace.tabJobs()[0]).toMatchObject({ dock: false });
    expect(workspace.jobTexts.has(id)).toBe(false);
    workspace.closeJob(id);
    expect(workspace.trayTexts.has(id)).toBe(false);
    expect(workspace.setJobDock(id, "gone")).toBe(false);
  });

  test("a script sees names and states in its own tab", () => {
    const { workspace } = ide({ now: 0 });
    const id = workspace.runJob(2, ["komux", "script", "host", "x"], "deploy")!;
    workspace.setAgentState(2, "working");
    const state = workspace.scriptState(id)!;
    expect(state.tabs.filter((tab) => tab.current)).toEqual([{ name: workspace.tab.name, current: true, attention: "working" }]);
    expect(state.jobs).toEqual([{ name: "deploy", state: "running", agent: undefined }]);
    expect(state.panes.some((pane) => pane.agent === "working")).toBe(true);
    expect(workspace.scriptState(999)).toBeUndefined();
  });
});

describe("tab switching", () => {
  const ide = configSchema.parse({ projects: { layout: "ide" }, layouts: { ide: { row: [{ focus: true }, {}] } } });

  test("Alt h and Alt s at the outermost panes stay on the tab", () => {
    const workspace = new Workspace(new FakeHost(), "/home", ide);
    workspace.openProject("merlin");
    workspace.openProject("penguin");
    const focused = workspace.focused;
    press(workspace, "alt+h", "alt+h");
    expect(workspace.tab.name).toBe("penguin");
    press(workspace, "alt+s", "alt+s", "alt+s");
    expect(workspace.tab.name).toBe("penguin");
    expect(workspace.focused).not.toBe(focused);
  });

  test("Alt 1 to 9 go straight to a tab", () => {
    const workspace = new Workspace(new FakeHost());
    workspace.openProject("merlin");
    press(workspace, "alt+1");
    expect(workspace.active).toBe(0);
    press(workspace, "alt+2");
    expect(workspace.active).toBe(1);
    press(workspace, "alt+9");
    expect(workspace.active).toBe(1);
  });

  test("the switcher lists open tabs most recent first, then closed tabs, then projects", () => {
    const clock = { now: 0 };
    const host = new FakeHost();
    const workspace = new Workspace(host, undefined, undefined, () => clock.now);
    for (const name of ["merlin", "penguin", "penguin-auth"]) {
      clock.now += 10;
      workspace.openProject(name);
    }
    clock.now += 10;
    press(workspace, "alt+2");
    clock.now += 10;
    press(workspace, "ctrl+space", "t", "x");
    type(workspace, "merlin");
    press(workspace, "return");
    clock.now += 10;
    press(workspace, "ctrl+space", "space");
    expect(workspace.prompt?.candidates?.map((entry) => `${entry.kind} ${entry.name}`)).toEqual(["tab penguin-auth", "tab Tab #1", "closed merlin"]);
    press(workspace, "return");
    expect(workspace.tab.name).toBe("penguin-auth");
    press(workspace, "ctrl+space", "space");
    type(workspace, "mer");
    press(workspace, "return");
    expect(workspace.tabs.map((tab) => tab.name)).toEqual(["Tab #1", "penguin", "penguin-auth", "merlin"]);
  });

  test("closed tabs come back from the host after a restart", () => {
    const host = new FakeHost();
    host.recent = [{ title: "merlin #12", project: { name: "merlin", dir: "/work/exfresso/merlin" }, at: 5 }];
    const workspace = new Workspace(host);
    press(workspace, "ctrl+space", "space");
    expect(workspace.prompt?.candidates?.slice(0, 2).map((entry) => `${entry.kind} ${entry.name}`)).toEqual(["closed merlin #12", "project penguin"]);
  });

  test("a digit in the empty switcher jumps to that tab, and filters once there's text", () => {
    const workspace = new Workspace(new FakeHost());
    workspace.openProject("merlin");
    press(workspace, "ctrl+space", "space");
    type(workspace, "1");
    expect([workspace.prompt, workspace.active]).toEqual([undefined, 0]);
    press(workspace, "ctrl+space", "space");
    type(workspace, "m2");
    expect(workspace.prompt?.text).toBe("m2");
  });
});

describe("command palette", () => {
  test("? on the leader lists every command by name and runs the one picked", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+space", "?");
    expect(workspace.mode).toBe("normal");
    const names = workspace.palette!.entries.map((entry) => `${entry.name} · ${entry.keys}`);
    expect(names).toContain("message Claude · Alt c");
    expect(names).toContain("new tab · ^␣ t c");
    expect(names).toContain("tab mode · ^␣ t");
    type(workspace, "new tab");
    expect(workspace.palette!.matches[0]!.name).toBe("new tab");
    press(workspace, "return");
    expect([workspace.palette, workspace.tabs.length, workspace.mode]).toEqual([undefined, 2, "normal"]);
  });

  test("? in a mode shows that mode's commands with their keys in the mode, and returns to it", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+space", "t", "c", "ctrl+space", "t", "?");
    expect(workspace.palette?.scope).toBe("tab");
    expect(workspace.palette!.entries.map((entry) => entry.keys)).toContain("x");
    type(workspace, "previous tab");
    press(workspace, "return");
    expect([workspace.active, workspace.mode]).toEqual([0, "tab"]);
    press(workspace, "?", "escape");
    expect([workspace.palette, workspace.mode]).toEqual([undefined, "tab"]);
  });

  test("the focused app's commands join the palette and send their keys to its pane", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    press(workspace, "ctrl+space", "/");
    workspace.setAppKeys(1, { app: "remax", groups: [{ name: "Review", commands: [{ label: "accept hunk as reviewed", keys: "⏎", send: "\r" }, { label: "flag hunk", keys: "!" }] }] });
    type(workspace, "hunk");
    expect(workspace.palette!.matches.map((entry) => `${entry.app} ${entry.name}`)).toEqual(["remax accept hunk as reviewed", "remax flag hunk"]);
    press(workspace, "return");
    expect(host.sent).toEqual([[1, "\r"]]);
    press(workspace, "ctrl+space", "/");
    type(workspace, "flag");
    press(workspace, "return");
    expect(host.sent).toHaveLength(1);
    expect(workspace.message).toContain("can't run it");
  });

  test("an answer from a pane that lost focus is dropped", () => {
    const workspace = new Workspace(new FakeHost());
    workspace.setAppKeys(7, { app: "remax", groups: [{ name: "Review", commands: [{ label: "x" }] }] });
    expect(workspace.focusedApp()).toBeUndefined();
  });
});

describe("review fixes", () => {
  test("a failed view popup still closes on the next key while locked", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    press(workspace, "ctrl+space", "l");
    const popup = workspace.reservePaneId();
    workspace.openViewPopup(popup, "build", 1);
    host.held.add(popup);
    expect(press(workspace, "x")).toEqual([true]);
    expect([workspace.popup, workspace.mode]).toEqual([undefined, "locked"]);
  });

  test("a renamed tab isn't listed as closed under its old name", () => {
    const host = new FakeHost();
    const workspace = new Workspace(host);
    workspace.openProject("merlin");
    press(workspace, "ctrl+space", "t", "r");
    press(workspace, "backspace", "backspace", "backspace", "backspace", "backspace", "backspace");
    type(workspace, "api");
    press(workspace, "return", "alt+1");
    expect(host.recent.map((recent) => recent.title)).toEqual(["api"]);
    expect(workspace.switchEntries().map((entry) => `${entry.kind} ${entry.name}`)).toEqual(["tab api", "project penguin", "project penguin-auth"]);
  });

  test("clicking the keys chip forgets a leader pressed while locked", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+space", "l", "ctrl+space");
    workspace.openLeader();
    press(workspace, "l");
    expect(workspace.mode).toBe("locked");
    expect(press(workspace, "l")).toEqual([false]);
    expect(workspace.mode).toBe("locked");
  });

  test("the global palette leaves out commands that act on the jobs and tray selection", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+space", "?");
    const names = workspace.palette!.entries.map((entry) => entry.name);
    expect(names).not.toContain("close job");
    expect(names).not.toContain("open widget");
    expect(names).toContain("run a job");
    press(workspace, "escape", "ctrl+space", "j", "?");
    expect(workspace.palette!.entries.map((entry) => entry.name)).toContain("close job");
  });

  test("the selected palette row stays on its command when the app's commands arrive", () => {
    const workspace = new Workspace(new FakeHost());
    press(workspace, "ctrl+space", "?");
    type(workspace, "new");
    press(workspace, "down");
    const selected = workspace.palette!.matches[workspace.palette!.selected]!.name;
    workspace.setAppKeys(1, { app: "remax", groups: [{ name: "Notes", commands: [{ label: "new note", keys: "n", send: "n" }] }] });
    expect(workspace.palette!.matches[workspace.palette!.selected]!.name).toBe(selected);
  });
});
