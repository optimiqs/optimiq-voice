import { formatEngineName } from "../../../core/helpers/format-engine-name";
import { toTitleCase } from "../../../core/helpers/to-title-case";
import type { Application } from "@optimiq-voice/types";
import type { ColumnDef } from "@tanstack/react-table";

/**
 * Column definitions for rendering a table of Optimiq Voice Applications using TanStack Table.
 *
 * Each column maps a property of the `Application` object to a table header and cell.
 * This configuration enables sorting, filtering, and custom rendering in table UIs.
 */
export const columns: ColumnDef<Application>[] = [
  {
    /**
     * Unique identifier column for the application.
     *
     * This is typically a UUID or internal reference string.
     */
    id: "ref",
    header: "Ref",
    accessorKey: "ref"
  },
  {
    /**
     * Human-readable name of the application.
     *
     * Often used to identify the application in the UI.
     */
    id: "name",
    header: "Name",
    accessorKey: "name"
  },
  {
    /**
     * Text-to-Speech (TTS) provider used by the application.
     *
     * Displays the product reference for the TTS engine configured.
     */
    id: "textToSpeech",
    header: "Text to Speech",
    accessorKey: "textToSpeech.productRef",
    cell: ({ row }) =>
      formatEngineName(row.original.textToSpeech?.productRef, "tts.")
  },
  {
    /**
     * Speech-to-Text (STT) provider used by the application.
     *
     * Displays the product reference for the STT engine configured.
     */
    id: "speechToText",
    header: "Speech to Text",
    accessorKey: "speechToText.productRef",
    cell: ({ row }) =>
      formatEngineName(row.original.speechToText?.productRef, "stt.")
  },
  {
    id: "intelligence",
    header: "Intelligence",
    accessorKey: "intelligence.productRef",
    cell: ({ row }) =>
      formatEngineName(row.original.intelligence?.productRef, "llm.")
  },
  {
    /**
     * Type or category of the application.
     *
     * Indicates how the application is intended to function (e.g., voice app, IVR, bot).
     */
    id: "appType",
    header: "Application Type",
    accessorKey: "type",
    cell: ({ row }) => toTitleCase(row.getValue("appType"))
  }
];
