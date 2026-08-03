# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status: unscaffolded

This repository currently contains only `README.md`, `.gitignore`, `UNLICENSE`, and
this file. There is no `package.json`, no source tree, and no test setup. Build,
lint, and test commands cannot be documented until the project is scaffolded —
**do not assume any exist.**

Whoever scaffolds this project should replace this section with the real commands
(install, build, run the server, run the full test suite, run a single test) and a
description of the actual architecture.

## Intent

An MCP (Model Context Protocol) server that exposes ComfyUI to MCP clients.
ComfyUI is a node-graph based diffusion UI; it is driven over HTTP (`/prompt`,
`/history`, `/view`, `/object_info`) plus a WebSocket for execution progress.
Expect the server's core concerns to be workflow-graph JSON submission, polling or
streaming job progress, and returning generated image artifacts.

## Tooling signals from `.gitignore`

The ignore file is the standard GitHub `Node.gitignore` template with three
hand-added entries that indicate the intended stack:

- `node_modules.bun` — Bun is the expected runtime/package manager
- `*.sqlite` — local database expected
- `package-json.lock`

Confirm these against reality before relying on them; they are intent, not fact.

## Version control

This repo is managed with GitButler (current branch: `gitbutler/workspace`). See the
global `~/.claude/CLAUDE.md` for the required workflow — in short, use the `gitbutler`
skill and `but commit` rather than `git commit`, and never commit directly to `main`.
