# skills

Claude Code plugins and skills. The repository is a plugin marketplace: install any plugin below with one command.

## Install

```
/plugin install pr-pipeline --marketplace zcuric/skills
```

Answer `y` to add the marketplace, then pick the **user** scope so the plugin loads in every project. From a shell: `claude plugin install pr-pipeline --marketplace zcuric/skills`.

## Plugins

### pr-pipeline

Takes a ticket (Jira, a GitHub issue, Linear, or a task typed in words) or an open PR through nine recorded stages in any GitHub repo, and draws them in a pane beside the chat: spec, implementation, PR, AI review, address, e2e verification, acceptance check, merge risk, final proof. The pane also shows the PR itself: checks, review threads, and a guarded Merge button. Guide: [plugins/pr-pipeline/README.md](plugins/pr-pipeline/README.md).

Each repo describes its conventions in `.pr-pipeline.json` (branch pattern, title prefix, labels, reviewers, lint and test commands, e2e skill). Without one, stage 1 discovers them and offers to save the file. Example: [plugins/pr-pipeline/profiles/example.json](plugins/pr-pipeline/profiles/example.json).

## Updating a plugin

Edit the plugin under `plugins/<name>/`, bump `version` in its `.claude-plugin/plugin.json`, run `claude plugin validate plugins/<name>` and `claude plugin test plugins/<name>`, then commit. Installed copies update with `/plugin update <name>`.
