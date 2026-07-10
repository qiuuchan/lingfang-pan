# Embedded Runtimes

This directory is bundled into the Tauri app as the `runtimes` resource.
Plugin execution and plugin development commands must use these binaries only.

Current Windows x64 payload:

- `python/`: CPython 3.12.13 from `python-build-standalone` (`install_only`), including `python.exe`, `Scripts/pip.exe`, and `venv` support.
- `nodejs/`: Node.js 22.21.1 Windows x64, including `node.exe`, `npm`, and `pnpm` 9.15.9 installed under this runtime prefix.
- `ffmpeg/`: FFmpeg 8.1.2 (`ffmpeg.exe` + `ffprobe.exe`). 作为第三内置运行时——插件进程 PATH 自动包含此目录，插件的 `shutil.which("ffmpeg")` 直接命中内置版本，无需宿主机单独安装 FFmpeg。供 facefusion / videodl 等依赖 FFmpeg 的插件使用。

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
```
