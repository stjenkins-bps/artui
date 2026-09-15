export function truncate(value: string | undefined, width: number): string {
  if (!value) {
    return "-";
  }

  if (value.length <= width) {
    return value;
  }

  return `${value.slice(0, Math.max(0, width - 1))}…`;
}
