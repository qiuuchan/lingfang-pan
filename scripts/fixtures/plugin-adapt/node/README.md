# lingfang-smoke-node

灵坊插件适配流水线的 nodejs 冒烟样例。随包分发，用于在 `.lfplugin` 里留一份说明文本
（服务端会把它落到 release 的 readmeMarkdown 字段）。

本样例不需要任何第三方依赖，启动后保持心跳常驻，供运行时确证的 short_run 判活。
