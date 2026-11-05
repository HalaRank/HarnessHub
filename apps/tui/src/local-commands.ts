import type { NativeCommand } from "@harnesshub/shared";

export const localCommands: NativeCommand[] = [
  { name: "help", description: "Keyboard shortcuts and HarnessHub commands" },
  { name: "new", description: "New conversation in the selected project" },
  { name: "resume", description: "Find projects and conversations" },
  { name: "diff", description: "Show workspace Git changes" },
  { name: "model", description: "Choose native ACP session options" },
  { name: "permissions", description: "Choose native ACP permission settings" },
  { name: "copy", description: "Copy the latest completed response" },
  { name: "quit", description: "Exit TUI and keep background work running" },
  { name: "exit", description: "Exit TUI and keep background work running" },
  { name: "keymap", description: "Configure keyboard shortcuts" },
  { name: "project", description: "Add an existing project directory" },
  { name: "sidebar", description: "Show or hide projects" },
  { name: "harness", description: "Select the next Harness" },
  { name: "approval", description: "Review native permission options" },
  { name: "handoff", description: "Inspect Handoff and recovery options" },
  { name: "queue", description: "Inspect or explicitly resume held messages" },
];
