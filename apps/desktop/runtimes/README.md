# Embedded Runtimes

This directory is bundled into the Tauri app as the `runtimes` resource.
Plugin execution and plugin development commands must use these binaries only.

Current Windows x64 payload:

- `python/`: CPython 3.12.13 from `python-build-standalone` (`install_only`), including `python.exe`, `Scripts/pip.cmd`, and `venv` support.
- `nodejs/`: Node.js 22.21.1 Windows x64, including `node.exe`, `npm`, and `pnpm` 9.15.9 installed under this runtime prefix.
- `ffmpeg/`: FFmpeg 8.1.2, including `ffmpeg.exe` and `ffprobe.exe`.
- `chromium/`: Playwright 1.61.1 Chromium revision 1228, including full Chromium and Chromium Headless Shell.

`runtime-lock.json` records versions plus the size and SHA256 of key executables. Chromium's `chrome.dll` is stored under the sibling `runtime-parts/` directory as 64 MiB ordinary-Git parts to stay below Gitee's per-object limit. `pnpm runtime:prepare` reconstructs it atomically without network access, and every development and release build runs preparation before `pnpm runtime:verify`. Packaging copies only this `runtimes/` directory, so parts are not duplicated in installers. Missing or modified runtime files fail the build.

The Rust runtime layer injects China mirrors at process start:

- pip: `https://pypi.tuna.tsinghua.edu.cn/simple`
- npm/pnpm: `https://registry.npmmirror.com`

Quick local checks:

```powershell
.\python\python.exe --version
.\python\python.exe -m pip --version
.\nodejs\node.exe --version
.\nodejs\npm.cmd --version
.\nodejs\pnpm.cmd --version
.\ffmpeg\ffmpeg.exe -version
.\chromium\ms-playwright\chromium-1228\chrome-win64\chrome.exe --version
```
