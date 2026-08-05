export const getInitials = (name: string): string => {
  if (!name?.trim()) return "UN";

  const sanitized = name
    .replace(/[^a-zA-Z\s]/g, "")
    .trim()
    .replace(/\s+/g, " ");

  const [firstWord = "", secondWord = ""] = sanitized.split(" ");

  const firstLetter = firstWord.charAt(0).toUpperCase();
  const secondLetter = secondWord
    ? secondWord.charAt(0).toUpperCase()
    : firstWord.charAt(1)?.toUpperCase() || "N";

  return `${firstLetter}${secondLetter}`;
};
