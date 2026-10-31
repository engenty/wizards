import { reachesOutside } from "../../broker/index.js";
import { line, ShareError, type ShareTarget } from "../types.js";

interface Channel {
  id: string;
  name: string;
  is_private: boolean;
}

reachesOutside("share:slack", [
  { connection: "share:slack", action: "list_channels", kind: "read" },
  { connection: "share:slack", action: "post_message", kind: "send" },
]);

/**
 * A message in a Slack channel, as the person: their text and the link to the result page.
 * The connector posts text only, so files travel as the link.
 */
export const slackTarget: ShareTarget = {
  id: "slack",
  name: "Slack",
  description: line("shareSlackDescription"),
  icon: "chat",
  takes: "link",
  connection: () => ({
    id: "share:slack",
    target: { connectors: ["slack"] },
    actions: ["list_channels", "post_message"],
    title: "Slack",
  }),
  fields: [
    {
      id: "channel",
      kind: "select",
      required: true,
      fromAccount: true,
      label: line("shareChannel"),
    },
    { id: "message", kind: "textarea", required: true, label: line("shareMessage") },
  ],
  defaults: (scope) => ({
    message: [scope.title, scope.text?.slice(0, 2500)].filter(Boolean).join("\n\n"),
  }),
  async choices(field, ctx) {
    if (field !== "channel" || !(await ctx.connected())) {
      return [];
    }
    const { channels } = await ctx.call<{ channels: Channel[] }>(
      { id: "list_channels", kind: "read" },
      { limit: 50 },
    );
    return channels
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ value: c.id, label: `${c.is_private ? "🔒 " : "#"}${c.name}` }));
  },
  async send({ values }, ctx) {
    const account = await ctx.connected();
    if (!account?.connector.actions.some((a) => a.id === "post_message")) {
      throw new ShareError(line("shareConnectFirst", { name: "Slack" }));
    }
    const link = await ctx.link();
    const text = [values.message?.trim(), link].filter(Boolean).join("\n\n");
    await ctx.emit(line("sharePostingAs", { account: account.label }));
    await ctx.call({ id: "post_message", kind: "send" }, { channel: values.channel, text });
    return { summary: line("sharePostedSlack") };
  },
};
