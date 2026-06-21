---
name: fire-marker
description: biblio-claw M3 Phase 2 marker demo. Use this skill whenever the user asks to run the biblio-hello fire-marker demo, fire the biblio marker, or print the biblio-hello marker. It runs the bundled marker script and reports its deterministic output verbatim.
allowed-tools: Bash
---

# fire-marker (biblio-claw M3 Phase 2 marker demo)

This skill proves that a biblio (Claude Code plugin + skill) loaded into the
agent-container via spawn-time install actually executes. When it activates,
it runs a bundled script that prints a deterministic marker, then reports
that output verbatim.

## What to do when this skill activates

1. Run the bundled marker script with the Bash tool:

   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/skills/fire-marker/scripts/emit-marker.sh"
   ```

   If `$CLAUDE_PLUGIN_ROOT` is empty or the path above is not found, locate
   `emit-marker.sh` inside this skill's own `scripts/` directory and run it,
   e.g. `find / -name emit-marker.sh -path '*fire-marker*' 2>/dev/null` then
   `bash <that path>`.

2. Report the script's stdout **verbatim** in your reply, on its own line, so
   the marker string it prints is visible in the final output.

Do not invent or type the marker yourself — it must come from the script. The
marker's presence in the output is the proof that this skill loaded and its
payload ran inside the agent-container after spawn-time install.
