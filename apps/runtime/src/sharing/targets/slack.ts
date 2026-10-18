import { line, ShareError, type ShareTarget } from "../types.js";

interface Channel {
  id: string;
  name: string;
  is_private: boolean;
}

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
    const account = field === "channel" ? await ctx.account() : null;
    const list = account?.connector.actions.find((a) => a.id === "list_channels");
    if (!account || !list) {
      return [];
    }
    const { channels } = (await list.handler({ limit: 50 }, account.ctx)) as {
      channels: Channel[];
    };
    return channels
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ value: c.id, label: `${c.is_private ? "🔒 " : "#"}${c.name}` }));
  },
  async send({ values }, ctx) {
    const account = await ctx.account();
    const post = account?.connector.actions.find((a) => a.id === "post_message");
    if (!account || !post) {
      throw new ShareError(line("shareConnectFirst", { name: "Slack" }));
    }
    const link = await ctx.link();
    const text = [values.message?.trim(), link].filter(Boolean).join("\n\n");
    await ctx.emit(line("sharePostingAs", { account: account.label }));
    await post.handler({ channel: values.channel, text }, account.ctx);
    return { summary: line("sharePostedSlack") };
  },
};
