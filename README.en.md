# Aidy

**Aidy is a proactive AI supervision companion that comes to find you—especially for ADHD, executive-function difficulties, procrastination, and distraction.** It follows up through reminders, random check-ins, and task checkpoints, and can reach you in WeChat instead of waiting for you to remember to open another AI app.

WeChat is Aidy's way to reach you, not its product identity. WorkBuddy and other runtimes provide its Agent / model capability; they are not the reason Aidy exists.

> Aidy is not a medical tool and makes no diagnosis, treatment, or outcome claims. It is designed for everyday support when someone knows what to do but has trouble starting, stays off track, or forgets to return to a task.

## Why Aidy

Most AI assistants are passive: you have to open them, decide what to ask, and type a prompt. For people with ADHD, executive-function difficulties, or frequent procrastination and distraction, remembering to open a productivity tool can itself be a task.

Aidy aims to turn AI from a waiting chat window into a companion that shows up at useful moments. It can remind you to begin, ask what you are doing at an unpredictable time, and follow up at an agreed checkpoint. Dismissing one reminder does not mean the task is magically complete.

Those proactive follow-ups arrive in WeChat, where you are already likely to see them. The point is not to make another WeChat bot; it is to let Aidy find you when you have drifted, delayed, or forgotten.

## The core experience

### Proactive reminders

Set a time, and Aidy can come back to remind you or ask how it went—without waiting for a new prompt.

### Random check-ins

Aidy can check in at random within a time range and ask what you are doing or whether you are still on track. The randomness helps avoid the rigid feeling of preparing only for a known reminder time.

### Checkpoint follow-up

For plans with a meaningful time point, Aidy follows up when that checkpoint arrives. Quiet hours, overdue tasks, queue coalescing, and flood-protection boundaries help avoid turning stale reminders into fresh demands.

### Proactive reach through WeChat

You do not need to keep Aidy open. WeChat is the delivery channel for reminders, check-ins, and follow-up, while still supporting ordinary conversation.

### WorkBuddy-powered Agent capability

WorkBuddy is the recommended default Agent / model runtime. It owns its own account and model service; Aidy does not read or copy its credentials. Other compatible runtimes or custom APIs can be configured when needed, without changing Aidy's focus on proactive supervision.

## How it works

1. Connect and verify WorkBuddy or another compatible runtime in the Windows control center.
2. Sign in to WeChat so Aidy has a way to reach you.
3. Set reminders, a check-in range, or task checkpoints; ordinary conversation can continue in WeChat.
4. Aidy reminds, randomly checks in, or follows up within the configured boundaries.

## Core experience vs. advanced compatibility

The product experience this project emphasizes is proactive supervision, proactive reach through WeChat, and the WorkBuddy runtime. The underlying project still includes upstream capabilities such as workspaces / threads, diaries / timelines, MCP, and file or media mechanisms. These are advanced or compatibility capabilities—not claims that they are Aidy's proven core user experience.

Please validate those capabilities in your own environment before relying on them for ongoing use.

## Getting started

Use the Windows control center to connect and verify a model provider, sign in to WeChat, and start Aidy. Installation, supported commands, current limitations, and privacy boundaries are in the Chinese [README.md](./README.md) and [INSTALL.md](./INSTALL.md).

## Current status

Aidy is focused on real personal Windows + WeChat + WorkBuddy use, with continuing maintenance of proactive supervision, compatibility, and release acceptance. It does not claim to be production-ready without evidence.

## Upstream, credits, and license

Aidy is a derivative work of [WenXiaoWendy/cyberboss](https://github.com/WenXiaoWendy/cyberboss). The upstream project provided the foundation for the core architecture, WeChat Agent bridge, and proactive-supervision design. This repository retains the [AGPLv3 License](./LICENSE); please preserve its license and upstream attribution when using, modifying, or redistributing the project.
