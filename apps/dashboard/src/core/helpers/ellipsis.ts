export const ellipsis = (text: string, maxLength: number = 19): string => {
  if (text.length <= maxLength) {
    return text;
  }

  const ellipsisText = text.slice(0, maxLength - 3) + "...";
  return ellipsisText;
};
