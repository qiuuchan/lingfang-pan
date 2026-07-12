# Runtime Parts

This directory stores ordinary-Git parts for bundled runtime files that exceed Gitee's per-object limit.
Run `pnpm -C apps/desktop runtime:prepare` to materialize the complete files into `../runtimes/` without network access.

Do not add this directory to Tauri or SFX resources. Installers must contain only the materialized runtime files.
