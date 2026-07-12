// version.ts —— 语义版本比较工具（semver x.y.z）。
//
// 桌面端唯一权威实现，供 TeamPluginRow（团队/市场插件「更新」判断）与
// 插件列表版本比较共用。后端有等价实现（plugin.service.ts::isVersionNewer），
// 逻辑保持一致（非法格式按 0.0.0、严格大于、逐段比较）。

/** 把版本字符串解析为 [major, minor, patch]；非法格式回退 [0,0,0]。 */
export function parseVersion(v: string): [number, number, number] {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/** 语义版本比较：newVer 是否严格大于 oldVer（x.y.z）。非法格式按 0.0.0 处理。 */
export function isVersionNewer(newVer: string, oldVer: string): boolean {
  const [a1, a2, a3] = parseVersion(newVer);
  const [b1, b2, b3] = parseVersion(oldVer);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 > b3;
}
