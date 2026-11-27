const channel = (hex: string, index: number) => {
  const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance(hex: string) {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5)
}

export function contrastRatio(a: string, b: string) {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

/** Fill marks always use black or white, whichever gives the stronger contrast. */
export function markInk(color: string) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return '#ffffff'
  return contrastRatio(color, '#000000') >= contrastRatio(color, '#ffffff') ? '#000000' : '#ffffff'
}
