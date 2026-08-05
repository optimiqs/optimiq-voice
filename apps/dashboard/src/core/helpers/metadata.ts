export interface Metadata {
  title: string | null;
  description?: string;
}

export const metadata = (
  { title, description }: Metadata = {
    title: null
  }
) => {
  const defaultDescription =
    "Manage phone numbers, inbound and outbound calls, AI receptionists, SIP connectivity, and custom call flows with Optimiq Voice.";

  return [
    {
      title: title ? `${title} | Optimiq Voice` : "Optimiq Voice"
    },
    {
      name: "description",
      content: description || defaultDescription
    },
    {
      name: "keywords",
      content:
        "Optimiq Voice, business calling, AI receptionist, phone system, SIP"
    },
    {
      name: "author",
      content: "Optimiq Voice, Inc."
    },
    {
      name: "robots",
      content: "index, follow"
    },
    {
      property: "og:title",
      content:
        "Optimiq Voice - The complete calling system for modern businesses."
    },
    {
      property: "og:description",
      content: description || defaultDescription
    },
    {
      property: "og:image",
      content: "https://static.optimiq.health/graph.jpg"
    },
    {
      property: "og:type",
      content: "website"
    },
    {
      name: "twitter:card",
      content: "summary_large_image"
    },
    {
      name: "twitter:site",
      content: "@optimiq-voice"
    },
    {
      name: "twitter:description",
      content: description || defaultDescription
    },
    {
      name: "twitter:image",
      content: "https://static.optimiq.health/graph.jpg"
    }
  ];
};
