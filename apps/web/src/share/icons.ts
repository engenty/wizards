import type { ShareIcon } from "@engenty/wizards-shared/sharing";
import { FolderUp, Globe, type LucideIcon, Mail, MessageSquare, Plug } from "lucide-react";

/** How a share target looks: on the sheet, in the editor, on the flow. */
export const TARGET_ICON: Record<ShareIcon, LucideIcon> = {
  mail: Mail,
  folder: FolderUp,
  chat: MessageSquare,
  plug: Plug,
  globe: Globe,
};
