const COLORS = [
  '#2196F3', // 蓝色
  '#009688', // 青色
  '#9C27B0', // 紫色
  '#F44336', // 红色
  '#673AB7', // 深紫色
  '#3F51B5', // 靛蓝
  '#4CAF50', // 绿色
  '#FF5722', // 深橙
  '#795548', // 棕色
  '#607D8B', // 蓝灰
];

export function generateAvatarUrl(name: string): string {
  const displayName = name.trim() || '?';
  const initial = Array.from(displayName)[0].toUpperCase().replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]!);

  const colorIndex = Array.from(displayName).reduce(
    (acc, char) => acc + char.codePointAt(0)!, 0
  ) % COLORS.length;

  const backgroundColor = COLORS[colorIndex];

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
      <rect width="100" height="100" fill="${backgroundColor}"/>
      <text
        x="50%"
        y="50%"
        fill="white"
        font-family="system-ui, -apple-system, sans-serif"
        font-size="45"
        font-weight="500"
        text-anchor="middle"
        alignment-baseline="central"
        dominant-baseline="central"
        style="text-transform: uppercase"
      >
        ${initial}
      </text>
    </svg>
  `.trim();

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
