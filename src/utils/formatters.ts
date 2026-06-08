/**
 * 时间格式化工具函数
 */

export function formatTimeWithDecimal(seconds: number): string {
  const sign = seconds < 0 ? '-' : ''
  // 先四舍五入到 0.1s 再拆分 min/sec：否则补零判断用的是未取整的 sec，
  // 而显示用 sec.toFixed(1) 会进位，二者在边界处不一致——
  // 如 9.97s → 补 0 + "10.0" = "010.0"，59.97s → "0:60.0"。
  const totalDeci = Math.round(Math.abs(seconds) * 10)
  const min = Math.floor(totalDeci / 600)
  const sec = (totalDeci % 600) / 10
  return `${sign}${min}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`
}

/**
 * 伤害数值缩略：≥10000 显示为 x.xw，否则用千分位分隔
 */
export function formatDamageValue(value: number): string {
  return value >= 10000 ? `${(value / 10000).toFixed(1)}w` : value.toLocaleString()
}
