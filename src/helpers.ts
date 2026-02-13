export function formatTimeLeft(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'истекло';

  const sec = Math.floor(ms / 1000) % 60;
  const mins = Math.floor(ms / 60000) % 60;
  const hours = Math.floor(ms / 3600000) % 24;
  const days = Math.floor(ms / 86400000);

  if (days > 0) return `${days} дн. ${hours} ч. ${mins} мин.`;
  if (hours > 0) return `${hours} ч. ${mins} мин. ${sec} сек.`;
  if (mins > 0) return `${mins} мин. ${sec} сек.`;
  return `${Math.ceil(ms / 1000)} сек.`;
}
