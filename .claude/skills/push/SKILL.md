---
name: push
description: "Run check & build, rebase onto origin/main, and push straight to main"
allowed-tools: ["Bash"]
---

1. Run `npm run check && npm run build` and ensure a clean working tree.
2. Rebase and push straight to `main` (deploys to dev; never create or push `v*` release tags):
   ```sh
   git fetch origin main && git rebase origin/main && git push origin HEAD:main
   ```
