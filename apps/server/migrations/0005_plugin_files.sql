-- 发布插件文件内容持久化（SQLite 方言）。
-- 此前 publish 仅把 manifest 元数据写入 plugins 表，HTML/JS 文件内容被丢弃，
-- 导致发布的插件无法在「我的插件」中运行。新增 files 列存放完整文件数组（[{path,content}]）。

ALTER TABLE plugins ADD COLUMN files TEXT NOT NULL DEFAULT '[]';
